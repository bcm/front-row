// Per-client+user rate limiting for TVMaze-proxied tools (design §11.6).
//
// Backed by Postgres (mcp_rate_limits) so it is stateless-safe across
// autoscale replicas. Fixed-window counter; the check-and-increment is a
// single upsert statement so concurrent replicas cannot over-admit.

import { sql } from "drizzle-orm";
import { db } from "../db";
import { mcpRateLimits } from "@shared/schema";

export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const RATE_LIMIT_MAX = 60; // requests per window per key

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec?: number;
}

export async function checkRateLimit(key: string, now: Date = new Date()): Promise<RateLimitDecision> {
  const cutoff = new Date(now.getTime() - RATE_LIMIT_WINDOW_MS);
  // One statement: insert the key, or on conflict reset the window when it
  // expired and otherwise increment the counter. Atomic under concurrency:
  // two replicas racing both increment, neither loses the other's count.
  const [row] = await db
    .insert(mcpRateLimits)
    .values({ id: key, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: mcpRateLimits.id,
      set: {
        windowStart: sql`CASE WHEN ${mcpRateLimits.windowStart} <= ${cutoff} THEN ${now} ELSE ${mcpRateLimits.windowStart} END`,
        count: sql`CASE WHEN ${mcpRateLimits.windowStart} <= ${cutoff} THEN 1 ELSE ${mcpRateLimits.count} + 1 END`,
      },
    })
    .returning();
  if (!row) {
    // Unreachable: the upsert always returns the row. Keeps types honest.
    return { allowed: true };
  }
  if (row.count > RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((row.windowStart.getTime() + RATE_LIMIT_WINDOW_MS - now.getTime()) / 1000);
    return { allowed: false, retryAfterSec: Math.max(retryAfterSec, 1) };
  }
  return { allowed: true };
}

/** Rate-limit key for a tool invocation: per OAuth client + user (per grant). */
export function rateLimitKey(tool: string, clientId: string, userId: string): string {
  return `${tool}:${clientId}:${userId}`;
}
