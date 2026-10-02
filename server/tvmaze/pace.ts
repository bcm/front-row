// Shared TVMaze pace gate (issue #5): the distributed coordination point
// for the app's single outbound IP.
//
// TVMaze allows at least 20 calls per 10 seconds per IP, shared by all
// users and the sync jobs. One Postgres row (id = 'tvmaze') carries the
// earliest time the next call may go out plus how many upstream calls are
// currently in flight, so autoscale replicas share a single budget.
//
// Two limits, one atomic claim:
// - rate: each admission advances nextAdmitAt by 10s/18, so calls are evenly
//   spaced and no 10-second interval — aligned with TVMaze's limiter or
//   not — ever sees more than 18;
// - concurrency: at most 4 upstream calls in flight, because simultaneous
//   starts can trip a 429 even inside the rate budget.
//
// A denied caller reads the row for an honest retry hint and waits; the
// caller stays synchronous with its own timeout. A 429 from TVMaze sets a
// cooldown as the backstop; concurrent 429s keep the longest cooldown.

import { and, eq, isNull, lte, lt, or, sql } from "drizzle-orm";
import { db } from "../db";
import { tvmazePace } from "@shared/schema";

export const TVMAZE_PACE_WINDOW_MS = 10_000;
export const TVMAZE_PACE_MAX = 18; // per window; under TVMaze's documented 20/10s
export const TVMAZE_PACE_INTERVAL_MS = Math.ceil(TVMAZE_PACE_WINDOW_MS / TVMAZE_PACE_MAX);
export const TVMAZE_MAX_CONCURRENT = 4; // simultaneous upstream calls
export const PACE_ROW_ID = "tvmaze";
// When the only blocker is in-flight saturation, the row gives no future
// timestamp to wait on — poll again soon instead of spinning.
const CONCURRENCY_POLL_MS = 250;

export interface SlotDecision {
  admitted: boolean;
  retryAfterMs: number;
}

/**
 * Claim the next pace slot and a concurrency slot in one atomic UPDATE.
 * Exactly one concurrent claimant wins; losers (slot not due, in-flight
 * full, or cooldown active) change nothing.
 */
async function claimSlot(admitAt: Date, now: Date): Promise<boolean> {
  const updated = await db
    .update(tvmazePace)
    .set({
      nextAdmitAt: admitAt,
      inFlight: sql`${tvmazePace.inFlight} + 1`,
    })
    .where(
      and(
        eq(tvmazePace.id, PACE_ROW_ID),
        lte(tvmazePace.nextAdmitAt, now),
        lt(tvmazePace.inFlight, TVMAZE_MAX_CONCURRENT),
        or(isNull(tvmazePace.cooldownUntil), lte(tvmazePace.cooldownUntil, now)),
      ),
    )
    .returning({ id: tvmazePace.id });
  return updated.length > 0;
}

export async function tryAcquireSlot(now: Date = new Date()): Promise<SlotDecision> {
  const admitAt = new Date(now.getTime() + TVMAZE_PACE_INTERVAL_MS);
  let claimed = await claimSlot(admitAt, now);
  if (!claimed) {
    // No pace row yet (first call ever): create it due immediately, then claim.
    await db
      .insert(tvmazePace)
      .values({ id: PACE_ROW_ID, nextAdmitAt: now, inFlight: 0 })
      .onConflictDoNothing();
    claimed = await claimSlot(admitAt, now);
  }
  if (claimed) return { admitted: true, retryAfterMs: 0 };
  // Denied: read the row for an honest retry hint.
  const [row] = await db.select().from(tvmazePace).where(eq(tvmazePace.id, PACE_ROW_ID));
  const nextMs = row && row.nextAdmitAt > now ? row.nextAdmitAt.getTime() - now.getTime() : 0;
  const coolMs =
    row?.cooldownUntil && row.cooldownUntil > now ? row.cooldownUntil.getTime() - now.getTime() : 0;
  return { admitted: false, retryAfterMs: Math.max(nextMs, coolMs, CONCURRENCY_POLL_MS) };
}

/** Release a concurrency slot after the upstream call settles. Never goes negative. */
export async function releaseSlot(): Promise<void> {
  await db
    .update(tvmazePace)
    .set({ inFlight: sql`GREATEST(${tvmazePace.inFlight} - 1, 0)` })
    .where(eq(tvmazePace.id, PACE_ROW_ID));
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
    .values({ id: PACE_ROW_ID, nextAdmitAt: now, inFlight: 0, cooldownUntil: until })
    .onConflictDoUpdate({
      target: tvmazePace.id,
      set: { cooldownUntil: sql`GREATEST(COALESCE(${tvmazePace.cooldownUntil}, ${until}), ${until})` },
    });
}
