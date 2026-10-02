// Shared TVMaze pace gate (issue #5): the distributed coordination point
// for the app's single outbound IP.
//
// TVMaze allows at least 20 calls per 10 seconds per IP, shared by all
// users and the sync jobs. One Postgres row (id = 'tvmaze') carries the
// earliest time the next call may go out; concurrency slots are per-request
// lease rows in tvmaze_leases, reclaimed by expiry (see below).
//
// Two limits, one atomic statement:
// - rate: each admission advances nextAdmitAt by 10s/18, so calls are evenly
//   spaced and no 10-second interval — aligned with TVMaze's limiter or
//   not — ever sees more than 18;
// - concurrency: at most 4 upstream calls in flight, because simultaneous
//   starts can trip a 429 even inside the rate budget.
//
// Crash safety: a lease is a row, not a counter increment. If a replica
// dies mid-call its lease row ages out and the next acquire prunes it, so
// a slot can never leak permanently. The pace-row lock serializes
// concurrent acquirers; losers change nothing and get a retry hint.
//
// A denied caller reads the hint and waits; the caller stays synchronous
// with its own timeout. A 429 from TVMaze sets a cooldown as the backstop;
// concurrent 429s keep the longest cooldown.

import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { tvmazeLeases, tvmazePace } from "@shared/schema";

export const TVMAZE_PACE_WINDOW_MS = 10_000;
export const TVMAZE_PACE_MAX = 18; // per window; under TVMaze's documented 20/10s
export const TVMAZE_PACE_INTERVAL_MS = Math.ceil(TVMAZE_PACE_WINDOW_MS / TVMAZE_PACE_MAX);
export const TVMAZE_MAX_CONCURRENT = 4; // simultaneous upstream calls
export const PACE_ROW_ID = "tvmaze";
// A lease must outlive the longest possible attempt: 3 tries x 15s fetch
// timeout = 45s worst case per client.ts. Expired leases are pruned (and
// ignored) on every acquire.
export const LEASE_TTL_SEC = 60;
// When the only blocker is in-flight saturation, the row gives no future
// timestamp to wait on — poll again soon instead of spinning.
const CONCURRENCY_POLL_MS = 250;

export interface SlotDecision {
  admitted: boolean;
  retryAfterMs: number;
  /** Present when admitted: the caller's lease row id; pass to releaseSlot. */
  leaseId?: string;
}

interface AcquireRow {
  lease_id: string | null;
  next_admit_at: string;
  cooldown_until: string | null;
}

/**
 * Claim the next pace slot and a concurrency lease in ONE statement —
 * exactly one round trip, including on the deny path.
 *
 * The pace-row lock serializes concurrent acquirers across replicas. The
 * lease insert prunes expired rows first and only fires when fewer than
 * TVMAZE_MAX_CONCURRENT live leases exist; the pace timestamp advances
 * only when a lease was actually taken.
 */
export async function tryAcquireSlot(now: Date = new Date()): Promise<SlotDecision> {
  const result = await db.execute(sql`
    WITH ensured AS (
      INSERT INTO tvmaze_pace (id, next_admit_at)
      VALUES (${PACE_ROW_ID}, ${now})
      ON CONFLICT (id) DO NOTHING
    ),
    locked AS (
      SELECT next_admit_at, cooldown_until
      FROM tvmaze_pace
      WHERE id = ${PACE_ROW_ID}
      FOR UPDATE
    ),
    pruned AS (
      DELETE FROM tvmaze_leases
      WHERE acquired_at < ${now} - make_interval(secs => ${LEASE_TTL_SEC})
    ),
    live AS (
      SELECT COUNT(*)::int AS lease_count FROM tvmaze_leases
    ),
    decision AS (
      SELECT
        (l.next_admit_at <= ${now}
         AND (l.cooldown_until IS NULL OR l.cooldown_until <= ${now})
         AND c.lease_count < ${TVMAZE_MAX_CONCURRENT}) AS ok,
        l.next_admit_at,
        l.cooldown_until
      FROM locked l CROSS JOIN live c
    ),
    new_lease AS (
      INSERT INTO tvmaze_leases (id)
      SELECT gen_random_uuid()
      FROM decision
      WHERE decision.ok
      RETURNING id
    ),
    advanced AS (
      UPDATE tvmaze_pace
      SET next_admit_at = ${now} + make_interval(secs => ${TVMAZE_PACE_INTERVAL_MS / 1000})
      WHERE id = ${PACE_ROW_ID} AND EXISTS (SELECT 1 FROM new_lease)
    )
    SELECT
      (SELECT id FROM new_lease) AS lease_id,
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
  // Pace due and no active cooldown means the lease cap was the blocker.
  const concurrencyBlocked = nextMs === 0 && coolMs === 0;
  return {
    admitted: false,
    retryAfterMs: concurrencyBlocked ? CONCURRENCY_POLL_MS : Math.max(nextMs, coolMs),
  };
}

/**
 * Release the caller's concurrency lease. Idempotent: a lease already
 * pruned by expiry (e.g. a fetch that outran the TTL) deletes nothing.
 */
export async function releaseSlot(leaseId: string): Promise<void> {
  await db.delete(tvmazeLeases).where(eq(tvmazeLeases.id, leaseId));
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
