// Shared TVMaze pace gate (issue #5).
//
// TVMaze allows at least 20 calls per 10 seconds per IP, and the app's
// single outbound IP is shared by all users and the sync jobs. Every
// outbound TVMaze call is admitted here first. Backed by Postgres
// (tvmaze_pace, one row) so autoscale replicas share a single budget.
//
// Pacing, not windowing: the row carries the earliest time the next call
// may go out, and each admission advances it by 10s/18. Calls are evenly
// spaced, so no 10-second interval — aligned with TVMaze's limiter or
// not — ever sees more than 18. (A fixed local window would admit 18
// just before reset and 18 just after: 36 inside 10s.) The claim is one
// conditional UPDATE, atomic under concurrency; a denied caller reads the
// row for its retry hint. A 429 from TVMaze sets a cooldown as the
// backstop; concurrent 429s keep the longest cooldown, never a shorter one.

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import { tvmazePace } from "@shared/schema";

export const TVMAZE_PACE_WINDOW_MS = 10_000;
export const TVMAZE_PACE_MAX = 18; // per window; under TVMaze's documented 20/10s
export const TVMAZE_PACE_INTERVAL_MS = Math.ceil(TVMAZE_PACE_WINDOW_MS / TVMAZE_PACE_MAX);
export const PACE_ROW_ID = "tvmaze";

export interface PaceDecision {
  admitted: boolean;
  retryAfterSec: number;
}

/**
 * Claim the next pace slot: one atomic conditional UPDATE. Exactly one
 * concurrent claimant wins; losers (slot not due, or cooldown active)
 * change nothing.
 */
async function claimPaceSlot(admitAt: Date, now: Date): Promise<boolean> {
  const updated = await db
    .update(tvmazePace)
    .set({ nextAdmitAt: admitAt })
    .where(
      and(
        eq(tvmazePace.id, PACE_ROW_ID),
        lte(tvmazePace.nextAdmitAt, now),
        or(isNull(tvmazePace.cooldownUntil), lte(tvmazePace.cooldownUntil, now))
      )
    )
    .returning({ id: tvmazePace.id });
  return updated.length > 0;
}

export async function admitPacedCall(now: Date = new Date()): Promise<PaceDecision> {
  const admitAt = new Date(now.getTime() + TVMAZE_PACE_INTERVAL_MS);
  let claimed = await claimPaceSlot(admitAt, now);
  if (!claimed) {
    // No pace row yet (first call ever): create it due immediately, then claim.
    await db
      .insert(tvmazePace)
      .values({ id: PACE_ROW_ID, nextAdmitAt: now })
      .onConflictDoNothing();
    claimed = await claimPaceSlot(admitAt, now);
  }
  if (claimed) return { admitted: true, retryAfterSec: 0 };
  // Denied: read the row for an honest retry hint.
  const [row] = await db.select().from(tvmazePace).where(eq(tvmazePace.id, PACE_ROW_ID));
  const nextMs = row && row.nextAdmitAt > now ? row.nextAdmitAt.getTime() - now.getTime() : 0;
  const coolMs =
    row?.cooldownUntil && row.cooldownUntil > now ? row.cooldownUntil.getTime() - now.getTime() : 0;
  return { admitted: false, retryAfterSec: Math.max(1, Math.ceil(Math.max(nextMs, coolMs) / 1000)) };
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
