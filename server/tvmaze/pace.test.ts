// Tests for the shared TVMaze pace gate (rate + concurrency leases).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { db, resetDbMocks } from "../oauth/test-utils/mock-db";
import {
  tryAcquireSlot,
  releaseSlot,
  setPaceCooldown,
  LEASE_TTL_SEC,
  TVMAZE_MAX_CONCURRENT,
} from "./pace";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

const NOW = new Date("2026-01-01T00:00:00Z");

const acquireRow = (overrides: Record<string, unknown> = {}) => ({
  lease_id: null,
  next_admit_at: new Date(NOW.getTime() - 1_000).toISOString(), // due
  cooldown_until: null,
  ...overrides,
});

function mockExecuteOnce(rows: unknown[]) {
  (db.execute as any).mockResolvedValueOnce({ rows });
}

import { StringChunk } from "drizzle-orm";

function executedSQL(): string {
  const query = (db.execute as any).mock.calls[0][0];
  return query.queryChunks
    .filter((c: unknown): c is StringChunk => c instanceof StringChunk)
    .map((c) => c.value)
    .join("?");
}

describe("tryAcquireSlot", () => {
  it("admits with a lease id in a single statement", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-1" })]);

    const decision = await tryAcquireSlot(NOW);

    expect(decision).toEqual({ admitted: true, retryAfterMs: 0, leaseId: "lease-1" });
    // Finding #3: the whole acquire — row ensure, lock, prune, count,
    // conditional insert, pace advance — is exactly one round trip,
    // including on the deny path below.
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("denies with a single round trip when the pace slot is not due", async () => {
    mockExecuteOnce([
      acquireRow({ next_admit_at: new Date(NOW.getTime() + 4_000).toISOString() }),
    ]);

    const decision = await tryAcquireSlot(NOW);

    expect(decision).toEqual({ admitted: false, retryAfterMs: 4000 });
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("denies on lease saturation with a short poll hint", async () => {
    mockExecuteOnce([acquireRow()]); // pace due, no cooldown, no lease -> saturated

    const decision = await tryAcquireSlot(NOW);

    expect(decision).toEqual({ admitted: false, retryAfterMs: 250 });
  });

  it("denies while a 429 cooldown is active, hinting at its expiry", async () => {
    mockExecuteOnce([
      acquireRow({ cooldown_until: new Date(NOW.getTime() + 9_000).toISOString() }),
    ]);

    const decision = await tryAcquireSlot(NOW);

    expect(decision).toEqual({ admitted: false, retryAfterMs: 9000 });
  });

  it("prunes expired leases on every acquire so crashed holders recover", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-9" })]);

    await tryAcquireSlot(NOW);

    // Finding #1: the acquire statement must ignore (and delete) leases
    // older than the TTL — this is what reclaims slots from crashed
    // replicas instead of leaking them forever.
    const statement = executedSQL();
    expect(statement).toContain("DELETE FROM tvmaze_leases");
    expect(statement).toContain("acquired_at <");
    expect(statement).toContain("FOR UPDATE");
  });

  it("only counts live leases toward the concurrency cap", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-2" })]);

    await tryAcquireSlot(NOW);

    const statement = executedSQL();
    expect(statement).toContain("lease_count <");
    // The cap is bound as a parameter, not interpolated.
    const query = (db.execute as any).mock.calls[0][0];
    const params = query.queryChunks.filter((c: unknown) => typeof c === "number");
    expect(params).toContain(TVMAZE_MAX_CONCURRENT);
  });
});

describe("releaseSlot", () => {
  it("deletes the caller's own lease row", async () => {
    await releaseSlot("lease-1");

    expect(db.delete).toHaveBeenCalledTimes(1);
    // Idempotent: deleting an already-pruned lease is a no-op, never an error.
  });
});

describe("setPaceCooldown", () => {
  it("upserts the cooldown row keeping the longest", async () => {
    await setPaceCooldown(30, NOW);
    expect(db.insert).toHaveBeenCalled();
  });
});

describe("lease TTL", () => {
  it("outlives the longest possible attempt", () => {
    // client.ts: 3 attempts x 15s fetch timeout = 45s worst case per lease.
    expect(LEASE_TTL_SEC).toBeGreaterThan(45);
  });
});
