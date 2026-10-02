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
// One clock: every timestamp comes from PostgreSQL, never a replica's
// wall clock. The lock SELECT returns clock_timestamp() — actual
// post-lock database time (now() is the transaction's start, stale under
// contention) — driving eligibility, leases, expiry, advance, and hints.
//
// Why a transaction, not one statement: PostgreSQL won't modify the same
// row twice in one statement, so bootstrap and advance can't share one.
// The transaction locks the pace row (serializing acquirers), claims a
// slot row with FOR UPDATE SKIP LOCKED, then advances exactly once.
//
// Crash safety: a dead replica's slot ages past the TTL and is reclaimed.
// A 429 sets a cooldown backstop; concurrent 429s keep the longest.

import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { tvmazeSlots } from "@shared/schema";

export const TVMAZE_PACE_WINDOW_MS = 10_000;
export const TVMAZE_PACE_MAX = 18; // per window; under TVMaze's documented 20/10s
export const TVMAZE_PACE_INTERVAL_MS = Math.ceil(TVMAZE_PACE_WINDOW_MS / TVMAZE_PACE_MAX);
export const TVMAZE_MAX_CONCURRENT = 4; // simultaneous upstream calls
export const PACE_ROW_ID = "tvmaze";
// A lease must outlive the longest attempt (3 x 15s = 45s). Expired
// slots are ignored and reclaimed on every acquire.
export const LEASE_TTL_SEC = 60;
// Anomaly bound on upstream backoff: a malformed/malicious Retry-After
// must not block the shared gate forever (no admin UI to clear it), so
// the gate self-heals after this bound. Realistic backoffs are exact.
export const MAX_RETRY_AFTER_SEC = 3600;
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
 * Timestamps come from clock_timestamp() read after the pace-row lock —
 * never now() (transaction-start, stale under contention), never a
 * replica clock. The pace row is modified exactly once per acquisition.
 */
export async function tryAcquireSlot(): Promise<SlotDecision> {
  return db.transaction(async (tx) => {
    // Bootstrap is DO NOTHING on conflict (never a second modification);
    // the SELECT takes the row lock serializing concurrent acquirers.
    await tx.execute(sql`
      INSERT INTO tvmaze_pace (id, next_admit_at)
      VALUES (${PACE_ROW_ID}, now())
      ON CONFLICT (id) DO NOTHING
    `);
    const paceRes = await tx.execute(sql`
      SELECT next_admit_at, cooldown_until, clock_timestamp() AS db_now
      FROM tvmaze_pace WHERE id = ${PACE_ROW_ID} FOR UPDATE
    `);
    const pace = (paceRes.rows as unknown as PaceLockRow[])[0];
    // One post-lock instant for everything below (eligibility, lease
    // timestamps, expiry, advance): the SELECT target list evaluates
    // after the row lock, so a stale wait can't admit back-to-back or
    // expire a live lease early. Binds as an ISO string, not a Date.
    const dbNowIso: string = pace.db_now;
    const dbNow = new Date(dbNowIso).getTime();
    const nextMs = Math.max(0, new Date(pace.next_admit_at).getTime() - dbNow);
    const coolMs = pace.cooldown_until
      ? Math.max(0, new Date(pace.cooldown_until).getTime() - dbNow)
      : 0;
    if (nextMs > 0 || coolMs > 0) {
      return { admitted: false, retryAfterMs: Math.max(nextMs, coolMs) };
    }
    // Fixed slot row, FOR UPDATE SKIP LOCKED: atomic per row — no MVCC
    // snapshot race admits a fifth caller; expired rows are reclaimable.
    const claimed = await tx.execute(sql`
      UPDATE tvmaze_slots AS s
      SET lease_id = gen_random_uuid(), acquired_at = ${dbNowIso}::timestamptz
      WHERE s.slot = (
        SELECT slot
        FROM tvmaze_slots
        WHERE lease_id IS NULL
           OR acquired_at < ${dbNowIso}::timestamptz - make_interval(secs => ${LEASE_TTL_SEC})
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
    // Single tvmaze_pace modification on the admit path; GREATEST keeps
    // it monotonic so a stale lock wait can't move next_admit_at back.
    await tx.execute(sql`
      UPDATE tvmaze_pace
      SET next_admit_at =
        GREATEST(next_admit_at, ${dbNowIso}::timestamptz) + make_interval(secs => ${TVMAZE_PACE_INTERVAL_MS / 1000})
      WHERE id = ${PACE_ROW_ID}
    `);
    return { admitted: true, retryAfterMs: 0, leaseId };
  });
}

/**
 * Seed the gate rows. Idempotent — safe on every replica boot. Tables
 * must exist (db:push); the acquire path self-seeds as a fallback.
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
 * Release the caller's slot. Idempotent: an expired/reclaimed slot is a no-op.
 */
export async function releaseSlot(leaseId: string): Promise<void> {
  await db
    .update(tvmazeSlots)
    .set({ leaseId: null, acquiredAt: null })
    .where(eq(tvmazeSlots.leaseId, leaseId));
}

/**
 * Backstop: TVMaze answered 429 — admit nothing until the cooldown
 * lapses. Anchored to the database clock (now() + interval), never the
 * replica's; concurrent 429s keep the longest, shorter ones never win.
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
 * Backstop for HTTP-date Retry-After: the absolute instant is compared
 * against the database clock in SQL — never via the replica clock.
 * Binds as an ISO string (TVMaze's instant, not a clock reading).
 * Absurd futures clamp to one database hour via LEAST on PostgreSQL
 * now(); concurrent 429s keep the longest. Returns the applied instant.
 */
export async function setPaceCooldownUntil(instant: Date): Promise<Date> {
  const clamped = sql`
    LEAST(
      GREATEST(now(), ${instant.toISOString()}::timestamptz),
      now() + make_interval(secs => ${MAX_RETRY_AFTER_SEC})
    )
  `;
  const rows = (await db.execute(sql`
    INSERT INTO tvmaze_pace (id, next_admit_at, cooldown_until)
    VALUES (${PACE_ROW_ID}, now(), ${clamped})
    ON CONFLICT (id) DO UPDATE SET
      cooldown_until = GREATEST(
        COALESCE(tvmaze_pace.cooldown_until, now()),
        EXCLUDED.cooldown_until
      )
    -- GREATEST may keep a later stored cooldown: return the row's final
    -- value (the cooldown actually stored), not just the proposal.
    RETURNING cooldown_until AS applied_at
  `)).rows as unknown as { applied_at: string }[];
  return new Date(rows[0].applied_at);
}
