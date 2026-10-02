// Tests for the shared TVMaze pace gate (rate + atomic fixed-slot claims).

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

// Nested sql fragments (e.g. the slot seed) appear as SQL chunks inside
// queryChunks; walk them so assertions see the full statement text.
function executedSQL(): string {
  const query = (db.execute as any).mock.calls[0][0];
  const parts: string[] = [];
  const walk = (chunks: unknown[]) => {
    for (const c of chunks) {
      if (c instanceof StringChunk) parts.push(c.value);
      else if (c && typeof c === "object" && "queryChunks" in c) {
        parts.push("?");
        walk((c as { queryChunks: unknown[] }).queryChunks);
      }
    }
  };
  walk(query.queryChunks);
  return parts.join("?");
}

describe("tryAcquireSlot", () => {
  it("admits with a lease id in a single statement", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-1" })]);

    const decision = await tryAcquireSlot(NOW);

    expect(decision).toEqual({ admitted: true, retryAfterMs: 0, leaseId: "lease-1" });
    // The whole acquire — row ensure, slot seed, lock, atomic claim, pace
    // advance — is exactly one round trip, including on the deny path.
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

  it("denies on slot saturation with a short poll hint", async () => {
    mockExecuteOnce([acquireRow()]); // pace due, no cooldown, no slot -> saturated

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

  it("claims a fixed slot row atomically — never count-then-insert", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-9" })]);

    await tryAcquireSlot(NOW);

    // Finding: PostgreSQL evaluates one statement against one MVCC
    // snapshot, so counting live leases then inserting is racy — two
    // concurrent acquirers can both see "3 live" and admit a fifth. The
    // claim must be a single atomic row update.
    const statement = executedSQL();
    expect(statement).toContain("UPDATE tvmaze_slots");
    expect(statement).toContain("FOR UPDATE SKIP LOCKED");
    expect(statement).not.toMatch(/COUNT\s*\(/i);
  });

  it("reclaims expired slots so crashed holders recover", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-9" })]);

    await tryAcquireSlot(NOW);

    // A slot whose acquired_at is older than the TTL is claimable again —
    // this is what reclaims slots from crashed replicas instead of
    // leaking them forever.
    const statement = executedSQL();
    expect(statement).toContain("acquired_at <");
    expect(statement).toContain("FOR UPDATE");
  });

  it("seeds one fixed row per concurrency slot", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-2" })]);

    await tryAcquireSlot(NOW);

    const statement = executedSQL();
    expect(statement).toContain("INSERT INTO tvmaze_slots");
    for (let i = 0; i < TVMAZE_MAX_CONCURRENT; i++) {
      expect(statement).toContain(`(${i})`);
    }
  });

  it("advances the pace timestamp monotonically", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-3" })]);

    await tryAcquireSlot(NOW);

    // A stale statement timestamp must never move next_admit_at backwards
    // (e.g. when FOR UPDATE waited across a pace interval).
    expect(executedSQL()).toContain("GREATEST(next_admit_at");
  });
});

describe("releaseSlot", () => {
  it("clears the caller's own slot", async () => {
    await releaseSlot("lease-1");

    expect(db.update).toHaveBeenCalledTimes(1);
    expect(db.delete).not.toHaveBeenCalled();
    // Idempotent: clearing an already-reclaimed slot matches nothing.
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
    // client.ts: 3 attempts x 15s fetch timeout = 45s worst case per slot.
    expect(LEASE_TTL_SEC).toBeGreaterThan(45);
  });
});
