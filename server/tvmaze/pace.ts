// Shared TVMaze pace gate (issue #5).
//
// TVMaze allows at least 20 calls per 10 seconds per IP, and the app's
// single outbound IP is shared by all users and the sync jobs. Every
// outbound TVMaze call is admitted here first. Backed by Postgres
// (tvmaze_pace, one row) so autoscale replicas share a single budget —
// the check-and-increment is one upsert statement, same pattern as the
// per-client mcp_rate_limits gate.
//
// We admit 18 per window, leaving headroom for replicas that pass the gate
// in the same instant. A 429 from TVMaze sets a cooldown as the backstop;
// the Retry-After header is honored when present.

import { sql } from "drizzle-orm";
import { db } from "../db";
import { tvmazePace } from "@shared/schema";

export const TVMAZE_PACE_WINDOW_MS = 10_000;
export const TVMAZE_PACE_MAX = 18; // under TVMaze's documented 20/10s
export const PACE_ROW_ID = "tvmaze";

export interface PaceDecision {
  admitted: boolean;
  retryAfterSec: number;
}

export async function admitPacedCall(now: Date = new Date()): Promise<PaceDecision> {
  const cutoff = new Date(now.getTime() - TVMAZE_PACE_WINDOW_MS);
  // One statement: insert the pace row, or on conflict reset the window
  // when it expired and otherwise increment. Atomic under concurrency.
  const [row] = await db
    .insert(tvmazePace)
    .values({ id: PACE_ROW_ID, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: tvmazePace.id,
      set: {
        windowStart: sql`CASE WHEN ${tvmazePace.windowStart} <= ${cutoff} THEN ${now} ELSE ${tvmazePace.windowStart} END`,
        count: sql`CASE WHEN ${tvmazePace.windowStart} <= ${cutoff} THEN 1 ELSE ${tvmazePace.count} + 1 END`,
      },
    })
    .returning();
  if (!row) {
    // Unreachable: the upsert always returns the row. Keeps types honest.
    return { admitted: true, retryAfterSec: 0 };
  }
  if (row.cooldownUntil && row.cooldownUntil > now) {
    const retryAfterSec = Math.ceil((row.cooldownUntil.getTime() - now.getTime()) / 1000);
    return { admitted: false, retryAfterSec: Math.max(retryAfterSec, 1) };
  }
  if (row.count > TVMAZE_PACE_MAX) {
    const retryAfterSec = Math.ceil((row.windowStart.getTime() + TVMAZE_PACE_WINDOW_MS - now.getTime()) / 1000);
    return { admitted: false, retryAfterSec: Math.max(retryAfterSec, 1) };
  }
  return { admitted: true, retryAfterSec: 0 };
}

/** Backstop: TVMaze answered 429 — admit nothing until the cooldown lapses. */
export async function setPaceCooldown(retryAfterSec: number, now: Date = new Date()): Promise<void> {
  const until = new Date(now.getTime() + retryAfterSec * 1000);
  await db
    .insert(tvmazePace)
    .values({ id: PACE_ROW_ID, windowStart: now, count: 0, cooldownUntil: until })
    .onConflictDoUpdate({
      target: tvmazePace.id,
      set: { cooldownUntil: until },
    });
}
