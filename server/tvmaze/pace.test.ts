// Tests for the shared TVMaze pace gate.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { chainable, db, resetDbMocks } from "../oauth/test-utils/mock-db";
import {
  admitPacedCall,
  setPaceCooldown,
  TVMAZE_PACE_MAX,
  TVMAZE_PACE_WINDOW_MS,
  PACE_ROW_ID,
} from "./pace";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

function mockPaceUpsert(row: Record<string, unknown>) {
  const insertChain = chainable([row]);
  (db.insert as any).mockReturnValue(insertChain);
  return insertChain;
}

const NOW = new Date("2026-01-01T00:00:00Z");

describe("admitPacedCall", () => {
  it("admits the first call in a window via a single upsert", async () => {
    const chain = mockPaceUpsert({ id: PACE_ROW_ID, windowStart: NOW, count: 1, cooldownUntil: null });
    const decision = await admitPacedCall(NOW);
    expect(decision).toEqual({ admitted: true, retryAfterSec: 0 });
    expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    expect(chain.returning).toHaveBeenCalled();
  });

  it("admits calls under the shared budget", async () => {
    mockPaceUpsert({ id: PACE_ROW_ID, windowStart: NOW, count: TVMAZE_PACE_MAX, cooldownUntil: null });
    const decision = await admitPacedCall(NOW);
    expect(decision.admitted).toBe(true);
  });

  it("denies calls over the budget with a retry hint to the window end", async () => {
    mockPaceUpsert({ id: PACE_ROW_ID, windowStart: NOW, count: TVMAZE_PACE_MAX + 1, cooldownUntil: null });
    const at = new Date(NOW.getTime() + 4_000);
    const decision = await admitPacedCall(at);
    expect(decision.admitted).toBe(false);
    expect(decision.retryAfterSec).toBe(Math.ceil((TVMAZE_PACE_WINDOW_MS - 4_000) / 1000));
  });

  it("denies calls while a 429 cooldown is active", async () => {
    mockPaceUpsert({
      id: PACE_ROW_ID,
      windowStart: NOW,
      count: 2,
      cooldownUntil: new Date(NOW.getTime() + 5_000),
    });
    const decision = await admitPacedCall(NOW);
    expect(decision).toEqual({ admitted: false, retryAfterSec: 5 });
  });

  it("admits again once the cooldown lapses", async () => {
    mockPaceUpsert({
      id: PACE_ROW_ID,
      windowStart: NOW,
      count: 2,
      cooldownUntil: new Date(NOW.getTime() - 1_000),
    });
    const decision = await admitPacedCall(NOW);
    expect(decision.admitted).toBe(true);
  });
});

describe("setPaceCooldown", () => {
  it("upserts the cooldown timestamp", async () => {
    const chain = chainable([]);
    (db.insert as any).mockReturnValue(chain);
    await setPaceCooldown(7, NOW);
    expect(chain.onConflictDoUpdate).toHaveBeenCalled();
    const setArg = (chain.onConflictDoUpdate as any).mock.calls[0][0].set;
    expect(setArg.cooldownUntil).toEqual(new Date(NOW.getTime() + 7_000));
  });
});
