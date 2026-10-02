// Tests for the shared TVMaze pace gate (rate + atomic fixed-slot claims).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { db, resetDbMocks } from "../oauth/test-utils/mock-db";
import {
  tryAcquireSlot,
  ensureTvmazeGateSeeded,
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
  db_now: NOW.toISOString(), // the database clock, returned by the statement
  ...overrides,
});

function mockExecuteOnce(rows: unknown[]) {
  (db.execute as any).mockResolvedValueOnce({ rows });
}

import { StringChunk } from "drizzle-orm";

// Nested sql fragments (e.g. the slot seed) appear as SQL chunks inside
// queryChunks; walk them so assertions see the full statement text.
function executedSQL(callIndex = 0): string {
  const query = (db.execute as any).mock.calls[callIndex][0];
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

// Bound parameters of the executed statement: every non-text chunk that
// isn't a nested SQL fragment. A Date here would be a replica wall-clock
// timestamp leaking into the gate.
function boundParams(callIndex = 0): unknown[] {
  const query = (db.execute as any).mock.calls[callIndex][0];
  const params: unknown[] = [];
  const walk = (chunks: unknown[]) => {
    for (const c of chunks) {
      if (c instanceof StringChunk) continue;
      else if (c && typeof c === "object" && "queryChunks" in c) {
        walk((c as { queryChunks: unknown[] }).queryChunks);
      } else params.push(c);
    }
  };
  walk(query.queryChunks);
  return params;
}

describe("tryAcquireSlot", () => {
  it("admits with a lease id in a single statement", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-1" })]);

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: true, retryAfterMs: 0, leaseId: "lease-1" });
    // The whole acquire — pace upsert, lock, atomic claim, pace advance —
    // is exactly one round trip, including on the deny path.
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("denies with a single round trip when the pace slot is not due", async () => {
    mockExecuteOnce([
      acquireRow({ next_admit_at: new Date(NOW.getTime() + 4_000).toISOString() }),
    ]);

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: false, retryAfterMs: 4000 });
    expect(db.execute).toHaveBeenCalledTimes(1);
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("denies on slot saturation with a short poll hint", async () => {
    mockExecuteOnce([acquireRow()]); // pace due, no cooldown, no slot -> saturated

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: false, retryAfterMs: 250 });
  });

  it("denies while a 429 cooldown is active, hinting at its expiry", async () => {
    mockExecuteOnce([
      acquireRow({ cooldown_until: new Date(NOW.getTime() + 9_000).toISOString() }),
    ]);

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: false, retryAfterMs: 9000 });
  });

  it("computes retry hints against the database clock, not the replica's", async () => {
    // The statement returns db_now; the hint is next_admit_at - db_now.
    // A replica whose wall clock disagrees still waits the right amount.
    mockExecuteOnce([
      acquireRow({
        next_admit_at: new Date(NOW.getTime() + 4_000).toISOString(),
        db_now: new Date(NOW.getTime() - 30_000).toISOString(), // db behind replica
      }),
    ]);

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: false, retryAfterMs: 34000 });
  });

  it("takes no clock argument — the gate never sees a replica timestamp", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-1" })]);

    await tryAcquireSlot();

    expect(tryAcquireSlot.length).toBe(0);
    // No bound parameter may be a Date: every timestamp in the gate comes
    // from PostgreSQL now(). This is what makes the gate immune to
    // replica wall-clock skew.
    for (const param of boundParams()) {
      expect(param).not.toBeInstanceOf(Date);
    }
    expect(executedSQL()).toContain("now()");
  });

  it("bootstraps the pace row via upsert-RETURNING so a fresh DB admits", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-1" })]);

    const decision = await tryAcquireSlot();

    // Finding: sibling data-modifying CTEs share one snapshot, so a plain
    // SELECT can't see a row inserted by a sibling seed CTE — the first
    // acquire on a fresh database was reported as a denial. The upsert's
    // no-op DO UPDATE takes the row lock (serializing acquirers) and feeds
    // RETURNING into the rest of the statement, so the row is always
    // visible — fresh database or not.
    const statement = executedSQL();
    expect(statement).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
    expect(statement).toContain("RETURNING");
    expect(statement).toContain("FROM ensured_pace");
    expect(decision.admitted).toBe(true);
  });

  it("claims a fixed slot row atomically — never count-then-insert", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-9" })]);

    await tryAcquireSlot();

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

    await tryAcquireSlot();

    // A slot whose acquired_at is older than the TTL is claimable again —
    // this is what reclaims slots from crashed replicas instead of
    // leaking them forever. Expiry is measured against the database
    // clock, so a skewed replica can't expire live slots early.
    const statement = executedSQL();
    expect(statement).toContain("acquired_at < now()");
    expect(statement).toContain("FOR UPDATE");
  });

  it("advances the pace timestamp monotonically", async () => {
    mockExecuteOnce([acquireRow({ lease_id: "lease-3" })]);

    await tryAcquireSlot();

    // A stale statement timestamp must never move next_admit_at backwards
    // (e.g. when the row lock waited across a pace interval).
    expect(executedSQL()).toContain("GREATEST(next_admit_at");
  });
});

describe("ensureTvmazeGateSeeded", () => {
  it("seeds the pace row and one fixed row per concurrency slot", async () => {
    await ensureTvmazeGateSeeded();

    expect(db.execute).toHaveBeenCalledTimes(2);
    const paceSQL = executedSQL(0);
    expect(paceSQL).toContain("INSERT INTO tvmaze_pace");
    expect(paceSQL).toContain("ON CONFLICT (id) DO NOTHING");
    const slotsSQL = executedSQL(1);
    expect(slotsSQL).toContain("INSERT INTO tvmaze_slots");
    for (let i = 0; i < TVMAZE_MAX_CONCURRENT; i++) {
      expect(slotsSQL).toContain(`(${i})`);
    }
    expect(slotsSQL).toContain("ON CONFLICT (slot) DO NOTHING");
    // Idempotent: safe to run on every replica boot.
    for (const param of [...boundParams(0), ...boundParams(1)]) {
      expect(param).not.toBeInstanceOf(Date);
    }
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
  it("anchors the cooldown to the database clock, keeping the longest", async () => {
    await setPaceCooldown(30);

    expect(db.execute).toHaveBeenCalledTimes(1);
    const statement = executedSQL();
    // Finding: the cooldown was derived from the handling replica's
    // clock — a replica behind the database reopened the shared gate
    // early. now() + interval is a single clock source with acquisition.
    expect(statement).toContain("now() + make_interval");
    expect(statement).toContain("GREATEST(");
    expect(statement).toContain("EXCLUDED.cooldown_until");
    for (const param of boundParams()) {
      expect(param).not.toBeInstanceOf(Date);
    }
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("lease TTL", () => {
  it("outlives the longest possible attempt", () => {
    // client.ts: 3 attempts x 15s fetch timeout = 45s worst case per slot.
    expect(LEASE_TTL_SEC).toBeGreaterThan(45);
  });
});
