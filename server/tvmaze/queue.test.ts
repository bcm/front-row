// Tests for the TVMaze paced queue: enqueue, wait, and the drain pass.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { chainable, db, resetDbMocks } from "../oauth/test-utils/mock-db";
import { claimRelayRows } from "../relay";
import { admitPacedCall, setPaceCooldown } from "./pace";
import {
  drainTvmazeQueue,
  enqueueTvmazeRequest,
  getQueuedRow,
  pruneCompletedRows,
  requeueStuckRows,
  waitForRow,
  MAX_ATTEMPTS,
} from "./queue";

vi.mock("../db", () => ({ db }));
vi.mock("../relay", () => ({ claimRelayRows: vi.fn() }));
vi.mock("./pace", () => ({ admitPacedCall: vi.fn(), setPaceCooldown: vi.fn() }));

beforeEach(() => {
  resetDbMocks();
  vi.mocked(claimRelayRows).mockReset();
  // Default: empty queue, so drain loops terminate after the scripted claims.
  vi.mocked(claimRelayRows).mockResolvedValue([]);
  vi.mocked(admitPacedCall).mockReset();
  vi.mocked(setPaceCooldown).mockReset();
});

const CLAIMED = {
  id: "row-1",
  method: "GET",
  url: "https://api.tvmaze.com/search/shows?q=x",
  headers: null,
  body: null,
  attempts: 1,
};

function mockUpdateChain() {
  const chain = chainable([]);
  (db.update as any).mockReturnValue(chain);
  return chain;
}

function okFetch(body = "[]", status = 200) {
  return vi.fn(async () => new Response(body, { status }));
}

describe("enqueueTvmazeRequest", () => {
  it("inserts a queued row and returns its id", async () => {
    (db.insert as any).mockReturnValue(chainable([{ id: "new-id" }]));
    const id = await enqueueTvmazeRequest({ url: "https://api.tvmaze.com/shows/1" });
    expect(id).toBe("new-id");
  });
});

describe("getQueuedRow / waitForRow", () => {
  it("returns the row once it reaches done", async () => {
    const done = { id: "r", status: "done", responseStatus: 200, responseBody: "[]" };
    (db.select as any).mockReturnValue(chainable([done]));
    const row = await waitForRow("r", 1000);
    expect(row).toEqual(done);
  });

  it("returns null when the waiter gives up", async () => {
    (db.select as any).mockReturnValue(chainable([{ id: "r", status: "queued" }]));
    const row = await waitForRow("r", 30, 10);
    expect(row).toBeNull();
  });
});

describe("drainTvmazeQueue", () => {
  it("claims, fetches, and records the upstream response", async () => {
    vi.mocked(claimRelayRows)
      .mockResolvedValueOnce([CLAIMED])
      .mockResolvedValueOnce([]);
    vi.mocked(admitPacedCall).mockResolvedValue({ admitted: true, retryAfterSec: 0 });
    const fetchFn = okFetch('[{"id":1}]');
    const updateChain = mockUpdateChain();

    const completed = await drainTvmazeQueue(fetchFn);

    expect(completed).toBe(1);
    expect(claimRelayRows).toHaveBeenCalledWith(
      expect.objectContaining({ table: "tvmaze_queue", limit: 1 })
    );
    expect(fetchFn).toHaveBeenCalledWith(
      CLAIMED.url,
      expect.objectContaining({ method: "GET", headers: expect.objectContaining({ "User-Agent": expect.any(String) }) })
    );
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "done", responseStatus: 200, responseBody: '[{"id":1}]' })
    );
  });

  it("does nothing when the queue is empty", async () => {
    const fetchFn = okFetch();
    expect(await drainTvmazeQueue(fetchFn)).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("releases the row and stops when the pace gate denies", async () => {
    vi.mocked(claimRelayRows).mockResolvedValueOnce([CLAIMED]);
    vi.mocked(admitPacedCall).mockResolvedValue({ admitted: false, retryAfterSec: 9 });
    const fetchFn = okFetch();
    const updateChain = mockUpdateChain();

    expect(await drainTvmazeQueue(fetchFn)).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued", claimedAt: null })
    );
  });

  it("honors Retry-After on upstream 429 and requeues the row", async () => {
    vi.mocked(claimRelayRows).mockResolvedValueOnce([CLAIMED]);
    vi.mocked(admitPacedCall).mockResolvedValue({ admitted: true, retryAfterSec: 0 });
    const fetchFn = vi.fn(async () => new Response("", { status: 429, headers: { "retry-after": "4" } }));
    const updateChain = mockUpdateChain();

    expect(await drainTvmazeQueue(fetchFn)).toBe(0);
    expect(setPaceCooldown).toHaveBeenCalledWith(4);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued", claimedAt: null })
    );
  });

  it("fails the row after max attempts", async () => {
    vi.mocked(claimRelayRows).mockResolvedValueOnce([{ ...CLAIMED, attempts: MAX_ATTEMPTS }]);
    vi.mocked(admitPacedCall).mockResolvedValue({ admitted: true, retryAfterSec: 0 });
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const updateChain = mockUpdateChain();

    await drainTvmazeQueue(fetchFn);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", error: "boom" })
    );
  });

  it("requeues the row below max attempts on fetch failure", async () => {
    vi.mocked(claimRelayRows).mockResolvedValueOnce([CLAIMED]);
    vi.mocked(admitPacedCall).mockResolvedValue({ admitted: true, retryAfterSec: 0 });
    const fetchFn = vi.fn(async () => {
      throw new Error("boom");
    });
    const updateChain = mockUpdateChain();

    await drainTvmazeQueue(fetchFn);
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued", claimedAt: null })
    );
  });
});

describe("maintenance", () => {
  it("requeues rows claimed too long ago", async () => {
    const updateChain = mockUpdateChain();
    await requeueStuckRows();
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "queued", claimedAt: null })
    );
  });

  it("prunes old completed rows", async () => {
    const deleteChain = chainable([]);
    (db.delete as any).mockReturnValue(deleteChain);
    await pruneCompletedRows();
    expect(deleteChain.where).toHaveBeenCalled();
  });
});
