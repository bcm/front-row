// Per-client+user rate limiting for TVMaze-proxied tools (design §11.6).
//
// Backed by Postgres (mcp_rate_limits) so it is stateless-safe across
// autoscale replicas. Fixed-window token bucket; concurrent requests may
// over-admit by a small margin, which is acceptable for rate limiting.

import { eq } from "drizzle-orm";
import { db } from "../db";
import { mcpRateLimits } from "@shared/schema";

export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
export const RATE_LIMIT_MAX = 60; // requests per window per key

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSec?: number;
}

export async function checkRateLimit(key: string, now: Date = new Date()): Promise<RateLimitDecision> {
  const [row] = await db.select().from(mcpRateLimits).where(eq(mcpRateLimits.id, key));
  if (!row || now.getTime() - row.windowStart.getTime() >= RATE_LIMIT_WINDOW_MS) {
    await db
      .insert(mcpRateLimits)
      .values({ id: key, windowStart: now, count: 1 })
      .onConflictDoUpdate({
        target: mcpRateLimits.id,
        set: { windowStart: now, count: 1 },
      });
    return { allowed: true };
  }
  if (row.count >= RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((row.windowStart.getTime() + RATE_LIMIT_WINDOW_MS - now.getTime()) / 1000);
    return { allowed: false, retryAfterSec: Math.max(retryAfterSec, 1) };
  }
  await db
    .update(mcpRateLimits)
    .set({ count: row.count + 1 })
    .where(eq(mcpRateLimits.id, key));
  return { allowed: true };
}

/** Rate-limit key for a tool invocation: per OAuth client + user (per grant). */
export function rateLimitKey(tool: string, clientId: string, userId: string): string {
  return `${tool}:${clientId}:${userId}`;
}
