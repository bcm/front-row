import { describe, expect, it, vi, beforeEach } from "vitest";
import { chainable, db, resetDbMocks } from "../oauth/test-utils/mock-db";
import { checkRateLimit, rateLimitKey, RATE_LIMIT_MAX } from "./rate-limit";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

function upsertResult(count: number, windowStart: Date) {
  return [{ id: "k", windowStart, count }];
}

/** Point the single-statement upsert at a canned RETURNING row. */
function mockUpsert(count: number, windowStart: Date) {
  const insertChain = chainable(upsertResult(count, windowStart));
  (db.insert as any).mockReturnValue(insertChain);
  return insertChain;
}

describe("checkRateLimit", () => {
  it("allows the first request in a window via a single upsert", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const insertChain = mockUpsert(1, now);
    const decision = await checkRateLimit("k", now);
    expect(decision).toEqual({ allowed: true });
    expect(db.select).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(insertChain.onConflictDoUpdate).toHaveBeenCalled();
    expect(insertChain.returning).toHaveBeenCalled();
  });

  it("allows requests under the limit", async () => {
    mockUpsert(5, new Date("2026-01-01T00:00:00Z"));
    const decision = await checkRateLimit("k", new Date("2026-01-01T00:30:00Z"));
    expect(decision).toEqual({ allowed: true });
  });

  it("denies requests over the limit with a retry hint", async () => {
    mockUpsert(RATE_LIMIT_MAX + 1, new Date("2026-01-01T00:00:00Z"));
    const decision = await checkRateLimit("k", new Date("2026-01-01T00:30:00Z"));
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBe(1800);
  });

  it("allows the request that resets an expired window", async () => {
    // The window reset happens inside the SQL CASE; the upsert returns
    // count 1 for the fresh window.
    mockUpsert(1, new Date("2026-01-01T02:00:01Z"));
    const decision = await checkRateLimit("k", new Date("2026-01-01T02:00:01Z"));
    expect(decision).toEqual({ allowed: true });
  });
});

describe("rateLimitKey", () => {
  it("scopes keys per tool, client, and user", () => {
    expect(rateLimitKey("catalog", "ghost", "u1")).toBe("catalog:ghost:u1");
    expect(rateLimitKey("catalog", "ghost", "u1")).not.toBe(rateLimitKey("catalog", "other", "u1"));
  });
});
