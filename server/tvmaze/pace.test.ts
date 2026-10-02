// Tests for the shared TVMaze pace gate (rate + atomic fixed-slot claims).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { db, resetDbMocks } from "../oauth/test-utils/mock-db";
import {
  tryAcquireSlot,
  ensureTvmazeGateSeeded,
  releaseSlot,
  setPaceCooldown,
  setPaceCooldownUntil,
  LEASE_TTL_SEC,
  MAX_RETRY_AFTER_SEC,
  TVMAZE_MAX_CONCURRENT,
} from "./pace";

vi.mock("../db", () => ({ db }));

// tryAcquireSlot runs in an explicit transaction; the tx double is wired
// per test so statement order and SQL shape are assertable.
let tx: { execute: ReturnType<typeof vi.fn> };
beforeEach(() => {
  resetDbMocks();
  tx = { execute: vi.fn() };
  vi.mocked(db.transaction).mockImplementation(async (cb: any) => cb(tx));
});

const NOW = new Date("2026-01-01T00:00:00Z");

const paceRow = (overrides: Record<string, unknown> = {}) => ({
  next_admit_at: new Date(NOW.getTime() - 1_000).toISOString(), // due
  cooldown_until: null,
  db_now: NOW.toISOString(), // the database clock, returned by the lock
  ...overrides,
});

// Program the tx.execute sequence: bootstrap, pace lock, slot claim.
// The admit path then runs a fourth statement (the pace advance).
function mockAcquire({
  pace = paceRow(),
  leaseId = "lease-1",
}: {
  pace?: Record<string, unknown>;
  leaseId?: string | null;
} = {}) {
  tx.execute
    .mockResolvedValueOnce({ rows: [] }) // bootstrap
    .mockResolvedValueOnce({ rows: [pace] }) // pace lock
    .mockResolvedValueOnce({ rows: leaseId ? [{ lease_id: leaseId }] : [] }); // claim
}

import { StringChunk } from "drizzle-orm";

// Nested sql fragments appear as SQL chunks inside queryChunks; walk them
// so assertions see the full statement text.
function sqlText(query: unknown): string {
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
  walk((query as { queryChunks: unknown[] }).queryChunks);
  return parts.join("?");
}

// Bound parameters of a statement: every non-text chunk that isn't a
// nested SQL fragment. A Date here would be a replica wall-clock
// timestamp leaking into the gate.
function sqlParams(query: unknown): unknown[] {
  const params: unknown[] = [];
  const walk = (chunks: unknown[]) => {
    for (const c of chunks) {
      if (c instanceof StringChunk) continue;
      else if (c && typeof c === "object" && "queryChunks" in c) {
        walk((c as { queryChunks: unknown[] }).queryChunks);
      } else params.push(c);
    }
  };
  walk((query as { queryChunks: unknown[] }).queryChunks);
  return params;
}

const txStatements = () => tx.execute.mock.calls.map(([q]) => sqlText(q));
const txParams = () => tx.execute.mock.calls.flatMap(([q]) => sqlParams(q));

describe("tryAcquireSlot", () => {
  it("admits with a lease id inside one transaction", async () => {
    mockAcquire({ leaseId: "lease-1" });

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: true, retryAfterMs: 0, leaseId: "lease-1" });
    // One transaction; the statements are bootstrap, lock, claim, advance.
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(4);
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("denies when the pace slot is not due, without modifying the pace row", async () => {
    mockAcquire({
      pace: paceRow({ next_admit_at: new Date(NOW.getTime() + 4_000).toISOString() }),
    });

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: false, retryAfterMs: 4000 });
    // Bootstrap + lock only; the deny path never reaches the claim or
    // the advance, and modifies nothing.
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(txStatements().join("\n")).not.toMatch(/UPDATE\s+tvmaze_pace/);
  });

  it("denies on slot saturation with a short poll hint", async () => {
    mockAcquire({ leaseId: null }); // pace due, no cooldown, no slot -> saturated

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: false, retryAfterMs: 250 });
    expect(txStatements().join("\n")).not.toMatch(/UPDATE\s+tvmaze_pace/);
  });

  it("denies while a 429 cooldown is active, hinting at its expiry", async () => {
    mockAcquire({
      pace: paceRow({ cooldown_until: new Date(NOW.getTime() + 9_000).toISOString() }),
    });

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: false, retryAfterMs: 9000 });
  });

  it("computes retry hints against the database clock, not the replica's", async () => {
    // The lock returns db_now; the hint is next_admit_at - db_now.
    // A replica whose wall clock disagrees still waits the right amount.
    mockAcquire({
      pace: paceRow({
        next_admit_at: new Date(NOW.getTime() + 4_000).toISOString(),
        db_now: new Date(NOW.getTime() - 30_000).toISOString(), // db behind replica
      }),
    });

    const decision = await tryAcquireSlot();

    expect(decision).toEqual({ admitted: false, retryAfterMs: 34000 });
  });

  it("modifies tvmaze_pace exactly once per acquisition", async () => {
    mockAcquire({ leaseId: "lease-1" });

    await tryAcquireSlot();

    // Finding: the old single statement ran ON CONFLICT DO UPDATE and
    // then updated the same row again — PostgreSQL applies only one of
    // the two modifications, unreliably, so next_admit_at could silently
    // stop advancing. The bootstrap is now a no-op DO NOTHING on
    // conflict; the advance below is the single modification.
    const paceUpdates = txStatements().filter((s) => /UPDATE\s+tvmaze_pace/.test(s));
    expect(paceUpdates).toHaveLength(1);
    expect(txStatements()[0]).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  it("locks the pace row before claiming a slot", async () => {
    mockAcquire({ leaseId: "lease-1" });

    await tryAcquireSlot();

    const lock = txStatements()[1];
    expect(lock).toContain("FROM tvmaze_pace");
    expect(lock).toContain("FOR UPDATE");
    // clock_timestamp(), not now(): the SELECT target list evaluates
    // after the row lock is taken, so this is post-lock database time.
    expect(lock).toContain("clock_timestamp() AS db_now");
    expect(lock).not.toContain("now() AS db_now");
  });

  it("claims a fixed slot row atomically — never count-then-insert", async () => {
    mockAcquire({ leaseId: "lease-9" });

    await tryAcquireSlot();

    // Finding: PostgreSQL evaluates one statement against one MVCC
    // snapshot, so counting live leases then inserting is racy — two
    // concurrent acquirers can both see "3 live" and admit a fifth. The
    // claim must be a single atomic row update, and inside the
    // transaction the pace-row lock serializes the claimers.
    const claim = txStatements()[2];
    expect(claim).toContain("UPDATE tvmaze_slots");
    expect(claim).toContain("FOR UPDATE SKIP LOCKED");
    expect(claim).not.toMatch(/COUNT\s*\(/i);
  });

  it("reclaims expired slots so crashed holders recover", async () => {
    mockAcquire({ leaseId: "lease-9" });

    await tryAcquireSlot();

    // A slot whose acquired_at is older than the TTL is claimable again —
    // this is what reclaims slots from crashed replicas instead of
    // leaking them forever. Expiry is measured against the post-lock
    // database instant, so a stale transaction can't expire live slots
    // early and a skewed replica can't either (it never supplies time).
    const claim = txStatements()[2];
    expect(claim).not.toMatch(/acquired_at < now\(\)/);
    expect(claim).toMatch(/acquired_at < \?+::timestamptz - make_interval/);
    expect(claim).toContain("FOR UPDATE");
  });

  it("uses one post-lock database instant for lease, expiry, and advance", async () => {
    mockAcquire({ leaseId: "lease-1" });

    await tryAcquireSlot();

    // Finding: now() is the transaction's start time — under contention
    // a lock wait makes it stale, so waiters with different start times
    // could be admitted back-to-back and acquired_at could be old enough
    // to expire a live lease early. The lock SELECT's clock_timestamp()
    // is post-lock time; that one value binds into the claim
    // (acquired_at, expiry) and the pace advance.
    const statements = txStatements();
    const claim = statements[2];
    expect(claim).not.toMatch(/acquired_at = now\(\)/);
    expect(statements[3]).not.toMatch(/GREATEST\(next_admit_at, now\(\)\)/);
    // The mock's db_now string is the bound value: twice in the claim
    // (acquired_at, expiry) and once in the advance.
    const dbNowParams = txParams().filter((p) => p === NOW.toISOString());
    expect(dbNowParams).toHaveLength(3);
  });

  it("advances the pace timestamp monotonically", async () => {
    mockAcquire({ leaseId: "lease-3" });

    await tryAcquireSlot();

    // A stale lock wait must never move next_admit_at backwards.
    expect(txStatements()[3]).toContain("GREATEST(next_admit_at");
  });

  it("takes no clock argument — the gate never sees a replica timestamp", async () => {
    mockAcquire({ leaseId: "lease-1" });

    await tryAcquireSlot();

    expect(tryAcquireSlot.length).toBe(0);
    // No bound parameter may be a Date: every timestamp in the gate comes
    // from PostgreSQL clock_timestamp(). This is what makes the gate
    // immune to replica wall-clock skew. (ISO strings bound below are
    // that database time, echoed back from the lock SELECT.)
    for (const param of txParams()) {
      expect(param).not.toBeInstanceOf(Date);
    }
    expect(txStatements().join("\n")).toContain("clock_timestamp()");
  });
});

describe("ensureTvmazeGateSeeded", () => {
  it("seeds the pace row and one fixed row per concurrency slot", async () => {
    (db.execute as any).mockResolvedValue({ rows: [] });

    await ensureTvmazeGateSeeded();

    expect(db.execute).toHaveBeenCalledTimes(2);
    const calls = (db.execute as any).mock.calls.map(([q]: any[]) => sqlText(q));
    const paceSQL = calls[0];
    expect(paceSQL).toContain("INSERT INTO tvmaze_pace");
    expect(paceSQL).toContain("ON CONFLICT (id) DO NOTHING");
    const slotsSQL = calls[1];
    expect(slotsSQL).toContain("INSERT INTO tvmaze_slots");
    for (let i = 0; i < TVMAZE_MAX_CONCURRENT; i++) {
      expect(slotsSQL).toContain(`(${i})`);
    }
    expect(slotsSQL).toContain("ON CONFLICT (slot) DO NOTHING");
    // Idempotent: safe to run on every replica boot.
    for (const param of (db.execute as any).mock.calls.flatMap(([q]: any[]) =>
      sqlParams(q),
    )) {
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
    (db.execute as any).mockResolvedValue({ rows: [] });

    await setPaceCooldown(30);

    expect(db.execute).toHaveBeenCalledTimes(1);
    const statement = sqlText((db.execute as any).mock.calls[0][0]);
    // Finding: the cooldown was derived from the handling replica's
    // clock — a replica behind the database reopened the shared gate
    // early. now() + interval is a single clock source with acquisition.
    expect(statement).toContain("now() + make_interval");
    expect(statement).toContain("GREATEST(");
    expect(statement).toContain("EXCLUDED.cooldown_until");
    for (const param of sqlParams((db.execute as any).mock.calls[0][0])) {
      expect(param).not.toBeInstanceOf(Date);
    }
    expect(db.insert).not.toHaveBeenCalled();
  });
});

describe("setPaceCooldownUntil", () => {
  it("stores the absolute instant against the database clock, keeping the longest", async () => {
    const appliedAt = "2026-06-01T12:00:00.000Z";
    (db.execute as any).mockResolvedValue({ rows: [{ applied_at: appliedAt }] });
    const instant = new Date("2026-06-01T12:00:00Z");

    const applied = await setPaceCooldownUntil(instant);

    expect(db.execute).toHaveBeenCalledTimes(1);
    const statement = sqlText((db.execute as any).mock.calls[0][0]);
    // Finding: the HTTP-date instant was converted to seconds against the
    // replica's clock before setPaceCooldown anchored it — a replica
    // ahead shortened the delay and the gate reopened early. SQL compares
    // the instant itself against now().
    expect(statement).toContain("GREATEST(");
    expect(statement).toContain("now()");
    expect(statement).toContain("EXCLUDED.cooldown_until");
    const params = sqlParams((db.execute as any).mock.calls[0][0]);
    // The instant binds as an ISO string, not a Date: it is TVMaze's
    // stated instant, not a replica clock reading.
    expect(params).toContain(instant.toISOString());
    for (const param of params) {
      expect(param).not.toBeInstanceOf(Date);
    }
    expect(applied.toISOString()).toBe(appliedAt);
  });

  it("clamps absurd futures to one database hour in SQL", async () => {
    (db.execute as any).mockResolvedValue({
      rows: [{ applied_at: "2026-06-01T13:00:00.000Z" }],
    });

    await setPaceCooldownUntil(new Date("2026-06-03T12:00:00Z"));

    // Finding: the 1h clamp used the replica clock (Date.now()) — a
    // replica behind the database shortened a valid cooldown, while one
    // ahead let an anomalous date block the shared gate for more than
    // one database hour. The LEAST bound is evaluated against
    // PostgreSQL now() inside setPaceCooldownUntil.
    const call = (db.execute as any).mock.calls[0][0];
    expect(sqlText(call)).toContain("LEAST(");
    expect(sqlText(call)).toContain("make_interval");
    expect(sqlParams(call)).toContain(MAX_RETRY_AFTER_SEC);
  });

  it("returns the stored cooldown on conflict, not just the proposal", async () => {
    // Finding: on the conflict path GREATEST may keep a later stored
    // cooldown, but RETURNING yielded only the proposal — the caller
    // logged an incorrect retryAfterAt. RETURNING yields the row's final
    // value, the cooldown actually stored.
    const storedAt = "2026-06-01T12:30:00.000Z"; // later than the proposal
    (db.execute as any).mockResolvedValue({ rows: [{ applied_at: storedAt }] });

    const applied = await setPaceCooldownUntil(new Date("2026-06-01T12:00:00Z"));

    expect(sqlText((db.execute as any).mock.calls[0][0])).toContain(
      "RETURNING cooldown_until",
    );
    expect(applied.toISOString()).toBe(storedAt);
  });
});

describe("lease TTL", () => {
  it("outlives the longest possible attempt", () => {
    // client.ts: 3 attempts x 15s fetch timeout = 45s worst case per slot.
    expect(LEASE_TTL_SEC).toBeGreaterThan(45);
  });
});
