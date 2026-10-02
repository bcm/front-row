// Shared TVMaze pace gate (issue #5): the distributed coordination point
// for the app's single outbound IP.
//
// TVMaze allows at least 20 calls per 10 seconds per IP, shared by all
// users and the sync jobs. One Postgres row (id = 'tvmaze') carries the
// earliest time the next call may go out; concurrency slots are fixed rows
// in tvmaze_slots, claimed atomically (see below).
//
// Two limits, one atomic statement:
// - rate: each admission advances nextAdmitAt by 10s/18, so calls are evenly
//   spaced and no 10-second interval — aligned with TVMaze's limiter or
//   not — ever sees more than 18;
// - concurrency: at most 4 upstream calls in flight, because simultaneous
//   starts can trip a 429 even inside the rate budget.
//
// Why fixed slot rows instead of counting live leases: PostgreSQL
// evaluates one statement against one MVCC snapshot. A count-then-insert
// lets two concurrent acquirers both see "3 live" and both insert a 4th
// lease — the fifth lease slips through. Claiming a fixed row with
// FOR UPDATE SKIP LOCKED is atomic per row: a concurrent claimer either
// sees the row locked (skips it) or sees the committed claim on lock
// re-check (EvalPlanQual filters it out). The cap holds under contention.
//
// Crash safety: a slot is data, not a lock. If a replica dies mid-call its
// slot's acquired_at ages past the TTL and the next acquire reclaims it —
// a slot can never leak permanently. The pace-row lock serializes the pace
// advance; losers change nothing and get a retry hint.
//
// A denied caller reads the hint and waits; the caller stays synchronous
// with its own timeout. A 429 from TVMaze sets a cooldown as the backstop;
// concurrent 429s keep the longest cooldown.

import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { tvmazePace, tvmazeSlots } from "@shared/schema";

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

// Slot rows are fixed (0 .. TVMAZE_MAX_CONCURRENT - 1) and seeded by the
// acquire statement itself.
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
}

/**
 * Claim the next pace slot and a concurrency slot in ONE statement —
 * exactly one round trip, including on the deny path.
 *
 * The slot claim is a fixed-row UPDATE with FOR UPDATE SKIP LOCKED, so it
 * is atomic under replica contention: no MVCC snapshot race can admit a
 * fifth caller. The pace-row lock serializes the pace advance, and the
 * advance is monotonic (GREATEST), so a stale statement timestamp can
 * never move nextAdmitAt backwards.
 */
export async function tryAcquireSlot(now: Date = new Date()): Promise<SlotDecision> {
  const result = await db.execute(sql`
    WITH ensured_pace AS (
      INSERT INTO tvmaze_pace (id, next_admit_at)
      VALUES (${PACE_ROW_ID}, ${now})
      ON CONFLICT (id) DO NOTHING
    ),
    ensured_slots AS (
      INSERT INTO tvmaze_slots (slot)
      VALUES ${SLOT_SEED}
      ON CONFLICT (slot) DO NOTHING
    ),
    locked AS (
      SELECT next_admit_at, cooldown_until
      FROM tvmaze_pace
      WHERE id = ${PACE_ROW_ID}
      FOR UPDATE
    ),
    claimed AS (
      UPDATE tvmaze_slots AS s
      SET lease_id = gen_random_uuid(),
          acquired_at = ${now}
      FROM locked AS l
      WHERE l.next_admit_at <= ${now}
        AND (l.cooldown_until IS NULL OR l.cooldown_until <= ${now})
        AND s.slot = (
          SELECT slot
          FROM tvmaze_slots
          WHERE lease_id IS NULL
             OR acquired_at < ${now} - make_interval(secs => ${LEASE_TTL_SEC})
          ORDER BY slot
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
      RETURNING s.lease_id
    ),
    advanced AS (
      UPDATE tvmaze_pace
      SET next_admit_at =
        GREATEST(next_admit_at, ${now}) + make_interval(secs => ${TVMAZE_PACE_INTERVAL_MS / 1000})
      WHERE id = ${PACE_ROW_ID} AND EXISTS (SELECT 1 FROM claimed)
    )
    SELECT
      (SELECT lease_id FROM claimed) AS lease_id,
      (SELECT next_admit_at FROM locked) AS next_admit_at,
      (SELECT cooldown_until FROM locked) AS cooldown_until
  `);
  const row = (result.rows as unknown as AcquireRow[])[0];
  if (row.lease_id) return { admitted: true, retryAfterMs: 0, leaseId: row.lease_id };
  const nextAdmitAt = new Date(row.next_admit_at);
  const nextMs = nextAdmitAt > now ? nextAdmitAt.getTime() - now.getTime() : 0;
  const cooldownUntil = row.cooldown_until ? new Date(row.cooldown_until) : null;
  const coolMs =
    cooldownUntil && cooldownUntil > now ? cooldownUntil.getTime() - now.getTime() : 0;
  // Pace due and no active cooldown means the slot cap was the blocker.
  const concurrencyBlocked = nextMs === 0 && coolMs === 0;
  return {
    admitted: false,
    retryAfterMs: concurrencyBlocked ? CONCURRENCY_POLL_MS : Math.max(nextMs, coolMs),
  };
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
 * Concurrent 429s keep the longest cooldown; a shorter Retry-After never
 * clobbers it. (GREATEST alone would return NULL when no cooldown exists,
 * hence the COALESCE.)
 */
export async function setPaceCooldown(retryAfterSec: number, now: Date = new Date()): Promise<void> {
  const until = new Date(now.getTime() + retryAfterSec * 1000);
  await db
    .insert(tvmazePace)
    .values({ id: PACE_ROW_ID, nextAdmitAt: now, cooldownUntil: until })
    .onConflictDoUpdate({
      target: tvmazePace.id,
      set: { cooldownUntil: sql`GREATEST(COALESCE(${tvmazePace.cooldownUntil}, ${until}), ${until})` },
    });
}
