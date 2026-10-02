// Shared TVMaze pace gate (issue #5): the distributed coordination point
// for the app's single outbound IP (20 calls / 10s, shared by all users
// and sync jobs). One Postgres row (id = 'tvmaze') carries the earliest
// time the next call may go out; concurrency slots are fixed rows in
// tvmaze_slots, claimed atomically.
//
// Two limits, one atomic statement: each admission advances nextAdmitAt by
// 10s/18 (even spacing; no 10s interval ever sees more than 18), and at
// most 4 upstream calls run in flight (simultaneous starts can 429 even
// inside the rate budget).
//
// One clock: every timestamp comes from PostgreSQL now(), never a
// replica's wall clock — ~556 ms of skew breaks the spacing guarantee,
// larger skew expires live slots early or reopens a 429 cooldown early.
// The statement returns the database timestamp for retry-hint arithmetic.
//
// Fixed slot rows, not count-then-insert: one statement sees one MVCC
// snapshot, so two acquirers could both see "3 live" and admit a fifth.
// Claiming a fixed row with FOR UPDATE SKIP LOCKED is atomic per row
// (a concurrent claimer sees the lock and skips, or EvalPlanQual filters
// the committed claim on re-check).
//
// Bootstrap: the pace row is created by an upsert whose no-op
// ON CONFLICT DO UPDATE takes the row lock and feeds RETURNING into the
// rest of the statement — the first acquire on a fresh database admits
// instead of reading nulls through the sibling-CTE visibility gap. Slot
// rows can't bootstrap this way (the claim scans the table, which can't
// see a sibling insert), so ensureTvmazeGateSeeded() runs at startup as
// the explicit deployment contract.
//
// Crash safety: a dead replica's slot ages past the TTL and is reclaimed —
// slots never leak permanently. A 429 sets a cooldown backstop; concurrent
// 429s keep the longest.

import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { tvmazeSlots } from "@shared/schema";

export const TVMAZE_PACE_WINDOW_MS = 10_000;
export const TVMAZE_PACE_MAX = 18; // per window; under TVMaze's documented 20/10s
export const TVMAZE_PACE_INTERVAL_MS = Math.ceil(TVMAZE_PACE_WINDOW_MS / TVMAZE_PACE_MAX);
export const TVMAZE_MAX_CONCURRENT = 4; // simultaneous upstream calls
export const PACE_ROW_ID = "tvmaze";
// A lease must outlive the longest possible attempt: 3 tries x 15s fetch
// timeout = 45s worst case per client.ts. Expired slots are ignored (and
// reclaimed) on every acquire.
export const LEASE_TTL_SEC = 60;
// When the only blocker is in-flight saturation, the row gives no future
// timestamp to wait on — poll again soon instead of spinning.
const CONCURRENCY_POLL_MS = 250;

// Slot rows are fixed (0 .. TVMAZE_MAX_CONCURRENT - 1).
const SLOT_SEED = sql.raw(
  Array.from({ length: TVMAZE_MAX_CONCURRENT }, (_, i) => `(${i})`).join(", "),
);

export interface SlotDecision {
  admitted: boolean;
  retryAfterMs: number;
  /** Present when admitted: the caller's lease id; pass to releaseSlot. */
  leaseId?: string;
}

interface AcquireRow {
  lease_id: string | null;
  next_admit_at: string;
  cooldown_until: string | null;
  /** The database clock at statement time — the only clock the gate uses. */
  db_now: string;
}

/**
 * Claim the next pace slot and a concurrency slot in ONE statement —
 * exactly one round trip, including on the deny path.
 *
 * Every timestamp comes from PostgreSQL now(): no replica wall clock
 * enters the gate, so clock skew between autoscaled replicas can't break
 * spacing, expire live slots early, or reopen a cooldown early. The slot
 * claim is a fixed-row UPDATE with FOR UPDATE SKIP LOCKED, so it is
 * atomic under replica contention: no MVCC snapshot race can admit a
 * fifth caller. The pace-row lock (via the upsert below) serializes the
 * pace advance, and the advance is monotonic (GREATEST), so a stale
 * statement timestamp can never move nextAdmitAt backwards.
 */
export async function tryAcquireSlot(): Promise<SlotDecision> {
  const result = await db.execute(sql`
    WITH ensured_pace AS (
      INSERT INTO tvmaze_pace (id, next_admit_at)
      VALUES (${PACE_ROW_ID}, now())
      -- No-op update on conflict: takes the row lock (serializing
      -- concurrent acquirers) and makes the row visible via RETURNING
      -- even on a fresh database, where a sibling SELECT could not see
      -- the just-inserted row.
      ON CONFLICT (id) DO UPDATE SET next_admit_at = tvmaze_pace.next_admit_at
      RETURNING next_admit_at, cooldown_until
    ),
    locked AS (
      SELECT next_admit_at, cooldown_until FROM ensured_pace
    ),
    claimed AS (
      UPDATE tvmaze_slots AS s
      SET lease_id = gen_random_uuid(),
          acquired_at = now()
      FROM locked AS l
      WHERE l.next_admit_at <= now()
        AND (l.cooldown_until IS NULL OR l.cooldown_until <= now())
        AND s.slot = (
          SELECT slot
          FROM tvmaze_slots
          WHERE lease_id IS NULL
             OR acquired_at < now() - make_interval(secs => ${LEASE_TTL_SEC})
          ORDER BY slot
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
      RETURNING s.lease_id
    ),
    advanced AS (
      UPDATE tvmaze_pace
      SET next_admit_at =
        GREATEST(next_admit_at, now()) + make_interval(secs => ${TVMAZE_PACE_INTERVAL_MS / 1000})
      WHERE id = ${PACE_ROW_ID} AND EXISTS (SELECT 1 FROM claimed)
    )
    SELECT
      (SELECT lease_id FROM claimed) AS lease_id,
      (SELECT next_admit_at FROM locked) AS next_admit_at,
      (SELECT cooldown_until FROM locked) AS cooldown_until,
      now() AS db_now
  `);
  const row = (result.rows as unknown as AcquireRow[])[0];
  if (row.lease_id) return { admitted: true, retryAfterMs: 0, leaseId: row.lease_id };
  // Retry hints are computed against the database clock, not the replica's.
  const dbNow = new Date(row.db_now).getTime();
  const nextMs = Math.max(0, new Date(row.next_admit_at).getTime() - dbNow);
  const coolMs = row.cooldown_until
    ? Math.max(0, new Date(row.cooldown_until).getTime() - dbNow)
    : 0;
  // Pace due and no active cooldown means the slot cap was the blocker.
  const concurrencyBlocked = nextMs === 0 && coolMs === 0;
  return {
    admitted: false,
    retryAfterMs: concurrencyBlocked ? CONCURRENCY_POLL_MS : Math.max(nextMs, coolMs),
  };
}

/**
 * Seed the gate rows. Idempotent — safe to run on every replica boot.
 * The acquire statement self-seeds as a fallback, but the explicit
 * deployment contract is: tables exist (db:push) and this has run.
 */
export async function ensureTvmazeGateSeeded(): Promise<void> {
  await db.execute(sql`
    INSERT INTO tvmaze_pace (id, next_admit_at)
    VALUES (${PACE_ROW_ID}, now())
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    INSERT INTO tvmaze_slots (slot)
    VALUES ${SLOT_SEED}
    ON CONFLICT (slot) DO NOTHING
  `);
}

/**
 * Release the caller's concurrency slot. Idempotent: clearing an already
 * expired/reclaimed slot matches nothing and is a no-op.
 */
export async function releaseSlot(leaseId: string): Promise<void> {
  await db
    .update(tvmazeSlots)
    .set({ leaseId: null, acquiredAt: null })
    .where(eq(tvmazeSlots.leaseId, leaseId));
}

/**
 * Backstop: TVMaze answered 429 — admit nothing until the cooldown lapses.
 * The cooldown is anchored to the database clock (now() + interval), never
 * the handling replica's: a replica behind the database can't reopen the
 * shared gate early. Concurrent 429s keep the longest cooldown; a shorter
 * Retry-After never clobbers it.
 */
export async function setPaceCooldown(retryAfterSec: number): Promise<void> {
  await db.execute(sql`
    INSERT INTO tvmaze_pace (id, next_admit_at, cooldown_until)
    VALUES (${PACE_ROW_ID}, now(), now() + make_interval(secs => ${retryAfterSec}))
    ON CONFLICT (id) DO UPDATE SET
      cooldown_until = GREATEST(
        COALESCE(tvmaze_pace.cooldown_until, now()),
        EXCLUDED.cooldown_until
      )
  `);
}
