// Shared TVMaze pace gate (issue #5): the distributed coordination point
// for the app's single outbound IP (20 calls / 10s, shared by all users
// and sync jobs). One Postgres row (id = 'tvmaze') carries the earliest
// time the next call may go out; concurrency slots are fixed rows in
// tvmaze_slots, claimed atomically.
//
// Two limits, one transaction: each admission advances nextAdmitAt by
// 10s/18 (even spacing; no 10s interval ever sees more than 18), and at
// most 4 upstream calls run in flight (simultaneous starts can 429 even
// inside the rate budget).
//
// One clock: every timestamp comes from PostgreSQL now(), never a
// replica's wall clock — skew breaks spacing, expires live slots early,
// or reopens a 429 cooldown early. The lock SELECT returns the database
// timestamp for retry-hint arithmetic.
//
// Why a transaction, not one statement: PostgreSQL won't modify the same
// row twice in a single statement, so the bootstrap upsert and the pace
// advance can't share one. The transaction locks the pace row (serializing
// acquirers), claims a fixed slot row with FOR UPDATE SKIP LOCKED (atomic
// per row — no MVCC snapshot race admits a fifth caller), then advances
// the pace row exactly once.
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

interface PaceLockRow {
  next_admit_at: string;
  cooldown_until: string | null;
  /** The database clock at lock time — the only clock the gate uses. */
  db_now: string;
}

/**
 * Claim the next pace slot and a concurrency slot in one transaction.
 *
 * Every timestamp comes from PostgreSQL now(): no replica wall clock
 * enters the gate. The pace row is modified exactly once per acquisition
 * (the advance below — the bootstrap is a no-op DO NOTHING on conflict),
 * so there is no double-modification hazard. Retry hints are computed
 * against the returned db_now.
 */
export async function tryAcquireSlot(): Promise<SlotDecision> {
  return db.transaction(async (tx) => {
    // Bootstrap, then lock: the insert is DO NOTHING on conflict (never a
    // second modification), and the SELECT takes the row lock that
    // serializes concurrent acquirers for the rest of the transaction.
    await tx.execute(sql`
      INSERT INTO tvmaze_pace (id, next_admit_at)
      VALUES (${PACE_ROW_ID}, now())
      ON CONFLICT (id) DO NOTHING
    `);
    const paceRes = await tx.execute(sql`
      SELECT next_admit_at, cooldown_until, now() AS db_now
      FROM tvmaze_pace WHERE id = ${PACE_ROW_ID} FOR UPDATE
    `);
    const pace = (paceRes.rows as unknown as PaceLockRow[])[0];
    const dbNow = new Date(pace.db_now).getTime();
    const nextMs = Math.max(0, new Date(pace.next_admit_at).getTime() - dbNow);
    const coolMs = pace.cooldown_until
      ? Math.max(0, new Date(pace.cooldown_until).getTime() - dbNow)
      : 0;
    if (nextMs > 0 || coolMs > 0) {
      return { admitted: false, retryAfterMs: Math.max(nextMs, coolMs) };
    }
    // Fixed slot row, FOR UPDATE SKIP LOCKED: atomic per row, so no MVCC
    // snapshot race can admit a fifth caller. Expired rows are claimable,
    // which reclaims slots from crashed replicas.
    const claimed = await tx.execute(sql`
      UPDATE tvmaze_slots AS s
      SET lease_id = gen_random_uuid(), acquired_at = now()
      WHERE s.slot = (
        SELECT slot
        FROM tvmaze_slots
        WHERE lease_id IS NULL
           OR acquired_at < now() - make_interval(secs => ${LEASE_TTL_SEC})
        ORDER BY slot
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING s.lease_id
    `);
    const leaseId =
      (claimed.rows as unknown as { lease_id: string | null }[])[0]?.lease_id ?? null;
    // Pace due and no active cooldown means the slot cap was the blocker.
    if (!leaseId) return { admitted: false, retryAfterMs: CONCURRENCY_POLL_MS };
    // The single tvmaze_pace modification on the admit path. Monotonic
    // (GREATEST) so a stale lock wait can't move next_admit_at backwards.
    await tx.execute(sql`
      UPDATE tvmaze_pace
      SET next_admit_at =
        GREATEST(next_admit_at, now()) + make_interval(secs => ${TVMAZE_PACE_INTERVAL_MS / 1000})
      WHERE id = ${PACE_ROW_ID}
    `);
    return { admitted: true, retryAfterMs: 0, leaseId };
  });
}

/**
 * Seed the gate rows. Idempotent — safe to run on every replica boot.
 * The acquire path self-seeds as a fallback, but the explicit deployment
 * contract is: tables exist (db:push) and this has run.
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
 * The delta-seconds delay is anchored to the database clock (now() +
 * interval), never the handling replica's: a replica behind the database
 * can't reopen the shared gate early. Concurrent 429s keep the longest
 * cooldown; a shorter Retry-After never clobbers it.
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

/**
 * Backstop for the HTTP-date form of Retry-After: the header names an
 * absolute instant, which SQL compares against the database clock —
 * deriving seconds from a replica's wall clock first would bake any skew
 * into the shared gate. The instant binds as an ISO string (not a Date)
 * to keep the gate's no-replica-timestamp invariant; it is TVMaze's
 * stated instant, not a replica clock reading. Absurd futures are clamped
 * by the caller (1h bound); concurrent 429s keep the longest.
 */
export async function setPaceCooldownUntil(instant: Date): Promise<void> {
  await db.execute(sql`
    INSERT INTO tvmaze_pace (id, next_admit_at, cooldown_until)
    VALUES (${PACE_ROW_ID}, now(), GREATEST(now(), ${instant.toISOString()}::timestamptz))
    ON CONFLICT (id) DO UPDATE SET
      cooldown_until = GREATEST(
        COALESCE(tvmaze_pace.cooldown_until, now()),
        EXCLUDED.cooldown_until
      )
  `);
}
