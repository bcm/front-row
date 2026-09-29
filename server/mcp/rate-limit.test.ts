import { describe, expect, it, vi, beforeEach } from "vitest";
import { chainable, db, resetDbMocks } from "../oauth/test-utils/mock-db";
import { checkRateLimit, rateLimitKey, RATE_LIMIT_MAX } from "./rate-limit";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

function row(count: number, windowStart: Date) {
  return { id: "k", windowStart, count };
}

describe("checkRateLimit", () => {
  it("allows the first request in a window and records it", async () => {
    (db.select as any).mockImplementationOnce(() => chainable([]));
    const decision = await checkRateLimit("k", new Date("2026-01-01T00:00:00Z"));
    expect(decision).toEqual({ allowed: true });
    expect(db.insert).toHaveBeenCalled();
  });

  it("allows requests under the limit and increments the counter", async () => {
    (db.select as any).mockImplementationOnce(() => chainable([row(5, new Date("2026-01-01T00:00:00Z"))]));
    const updateChain = chainable();
    (db.update as any).mockReturnValue(updateChain);
    const decision = await checkRateLimit("k", new Date("2026-01-01T00:30:00Z"));
    expect(decision).toEqual({ allowed: true });
    expect(updateChain.set).toHaveBeenCalledWith({ count: 6 });
  });

  it("denies requests at the limit with a retry hint", async () => {
    (db.select as any).mockImplementationOnce(() =>
      chainable([row(RATE_LIMIT_MAX, new Date("2026-01-01T00:00:00Z"))])
    );
    const decision = await checkRateLimit("k", new Date("2026-01-01T00:30:00Z"));
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSec).toBe(1800);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("resets the window after expiry", async () => {
    (db.select as any).mockImplementationOnce(() =>
      chainable([row(RATE_LIMIT_MAX, new Date("2026-01-01T00:00:00Z"))])
    );
    const decision = await checkRateLimit("k", new Date("2026-01-01T02:00:01Z"));
    expect(decision).toEqual({ allowed: true });
    expect(db.insert).toHaveBeenCalled();
  });
});

describe("rateLimitKey", () => {
  it("scopes keys per tool, client, and user", () => {
    expect(rateLimitKey("catalog", "ghost", "u1")).toBe("catalog:ghost:u1");
    expect(rateLimitKey("catalog", "ghost", "u1")).not.toBe(rateLimitKey("catalog", "other", "u1"));
  });
});
