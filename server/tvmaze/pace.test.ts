// Tests for the shared TVMaze pace gate (evenly-spaced admissions).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { chainable, db, resetDbMocks } from "../oauth/test-utils/mock-db";
import {
  admitPacedCall,
  setPaceCooldown,
  TVMAZE_PACE_INTERVAL_MS,
  PACE_ROW_ID,
} from "./pace";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

const NOW = new Date("2026-01-01T00:00:00Z");

function mockUpdateOnce(result: unknown) {
  (db.update as any).mockReturnValueOnce(chainable(result));
}
function mockInsertOnce(result: unknown = []) {
  (db.insert as any).mockReturnValueOnce(chainable(result));
}
function mockSelectOnce(result: unknown) {
  (db.select as any).mockReturnValueOnce(chainable(result));
}

const paceRow = (overrides: Record<string, unknown> = {}) => ({
  id: PACE_ROW_ID,
  nextAdmitAt: new Date(NOW.getTime() - 1_000), // due
  cooldownUntil: null,
  ...overrides,
});

describe("admitPacedCall", () => {
  it("creates the pace row on first call, then admits", async () => {
    mockUpdateOnce([]); // no row yet
    mockInsertOnce();
    mockUpdateOnce([{ id: PACE_ROW_ID }]); // claim wins

    const decision = await admitPacedCall(NOW);

    expect(decision).toEqual({ admitted: true, retryAfterSec: 0 });
    expect(db.insert).toHaveBeenCalled();
  });

  it("admits when the next slot is due via a single conditional update", async () => {
    mockUpdateOnce([{ id: PACE_ROW_ID }]);

    const decision = await admitPacedCall(NOW);

    expect(decision).toEqual({ admitted: true, retryAfterSec: 0 });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("denies when the next slot is in the future, hinting at it", async () => {
    mockUpdateOnce([]);
    mockInsertOnce();
    mockUpdateOnce([]); // lost the race / not due
    mockSelectOnce([paceRow({ nextAdmitAt: new Date(NOW.getTime() + 4_000) })]);

    const decision = await admitPacedCall(NOW);

    expect(decision).toEqual({ admitted: false, retryAfterSec: 4 });
  });

  it("denies while a 429 cooldown is active, hinting at its expiry", async () => {
    mockUpdateOnce([]);
    mockInsertOnce();
    mockUpdateOnce([]);
    mockSelectOnce([
      paceRow({
        nextAdmitAt: new Date(NOW.getTime() - 1_000),
        cooldownUntil: new Date(NOW.getTime() + 9_000),
      }),
    ]);

    const decision = await admitPacedCall(NOW);

    expect(decision).toEqual({ admitted: false, retryAfterSec: 9 });
  });

  it("admits again once the cooldown lapses", async () => {
    mockUpdateOnce([{ id: PACE_ROW_ID }]);

    const decision = await admitPacedCall(
      new Date(NOW.getTime() + 10_000) // past the cooldown
    );

    expect(decision.admitted).toBe(true);
  });

  it("spaces admissions by 10s/18", () => {
    expect(TVMAZE_PACE_INTERVAL_MS).toBe(Math.ceil(10_000 / 18));
  });
});

describe("setPaceCooldown", () => {
  it("keeps the longest cooldown under concurrency", async () => {
    const chain = chainable([]);
    (db.insert as any).mockReturnValue(chain);
    await setPaceCooldown(7, NOW);
    expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    const setArg = (chain.onConflictDoUpdate as any).mock.calls[0][0].set;
    const chunks = setArg.cooldownUntil?.queryChunks ?? [];
    const text = chunks
      .map((c: any) => (typeof c === "string" ? c : (c?.value ?? []).join("")))
      .join("")
      .toUpperCase();
    // GREATEST alone returns NULL when no cooldown exists; COALESCE guards it.
    expect(text).toContain("GREATEST");
    expect(text).toContain("COALESCE");
  });
});
