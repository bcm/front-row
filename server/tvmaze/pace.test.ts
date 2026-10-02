// Tests for the shared TVMaze pace gate (rate + concurrency, one atomic claim).

import { describe, expect, it, vi, beforeEach } from "vitest";
import { chainable, db, resetDbMocks } from "../oauth/test-utils/mock-db";
import {
  tryAcquireSlot,
  releaseSlot,
  setPaceCooldown,
  TVMAZE_MAX_CONCURRENT,
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
  inFlight: 0,
  cooldownUntil: null,
  ...overrides,
});

describe("tryAcquireSlot", () => {
  it("creates the pace row on first call, then admits", async () => {
    mockUpdateOnce([]); // no row yet
    mockInsertOnce();
    mockUpdateOnce([{ id: PACE_ROW_ID }]); // claim wins

    const decision = await tryAcquireSlot(NOW);

    expect(decision).toEqual({ admitted: true, retryAfterMs: 0 });
    expect(db.insert).toHaveBeenCalled();
  });

  it("admits when the slot is due and in-flight is below the cap", async () => {
    mockUpdateOnce([{ id: PACE_ROW_ID }]);

    const decision = await tryAcquireSlot(NOW);

    expect(decision).toEqual({ admitted: true, retryAfterMs: 0 });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });

  it("denies when the next slot is in the future, hinting at it", async () => {
    mockUpdateOnce([]);
    mockInsertOnce();
    mockUpdateOnce([]); // lost the race / not due
    mockSelectOnce([paceRow({ nextAdmitAt: new Date(NOW.getTime() + 4_000) })]);

    const decision = await tryAcquireSlot(NOW);

    expect(decision).toEqual({ admitted: false, retryAfterMs: 4000 });
  });

  it("denies when in-flight is at the cap, hinting a short poll", async () => {
    mockUpdateOnce([]);
    mockInsertOnce();
    mockUpdateOnce([]);
    mockSelectOnce([
      paceRow({ inFlight: TVMAZE_MAX_CONCURRENT }), // pace due, concurrency full
    ]);

    const decision = await tryAcquireSlot(NOW);

    // Pace due and no cooldown, so the only blocker is concurrency: the
    // hint is the short poll interval, not a future timestamp.
    expect(decision).toEqual({ admitted: false, retryAfterMs: 250 });
  });

  it("denies while a 429 cooldown is active, hinting at its expiry", async () => {
    mockUpdateOnce([]);
    mockInsertOnce();
    mockUpdateOnce([]);
    mockSelectOnce([
      paceRow({ cooldownUntil: new Date(NOW.getTime() + 9_000) }),
    ]);

    const decision = await tryAcquireSlot(NOW);

    expect(decision).toEqual({ admitted: false, retryAfterMs: 9000 });
  });
});

describe("releaseSlot", () => {
  it("issues an update that can only decrement toward zero", async () => {
    await releaseSlot();
    expect(db.update).toHaveBeenCalled();
  });
});

describe("setPaceCooldown", () => {
  it("upserts the cooldown row", async () => {
    await setPaceCooldown(30, NOW);
    expect(db.insert).toHaveBeenCalled();
  });
});
