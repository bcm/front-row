// Tests for the public TVMaze client: enqueue + wait + Response shaping.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { db } from "../oauth/test-utils/mock-db";
import { cancelQueuedRow, enqueueTvmazeRequest, waitForRow } from "./queue";

vi.mock("../db", () => ({ db }));
vi.mock("./queue", () => ({
  cancelQueuedRow: vi.fn(),
  enqueueTvmazeRequest: vi.fn(),
  waitForRow: vi.fn(),
}));

import {
  tvmazeFetch,
  TvmazePaceTimeout,
  TvmazeRequestFailed,
  TVMAZE_MCP_TIMEOUT_MS,
} from "./client";

beforeEach(() => {
  vi.mocked(cancelQueuedRow).mockReset();
  vi.mocked(enqueueTvmazeRequest).mockReset();
  vi.mocked(waitForRow).mockReset();
});

describe("tvmazeFetch", () => {
  it("enqueues and resolves with the upstream response", async () => {
    vi.mocked(enqueueTvmazeRequest).mockResolvedValue("row-1");
    vi.mocked(waitForRow).mockResolvedValue({
      id: "row-1",
      status: "done",
      responseStatus: 200,
      responseBody: '{"ok":true}',
    } as any);

    const res = await tvmazeFetch("https://api.tvmaze.com/shows/1");

    expect(enqueueTvmazeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://api.tvmaze.com/shows/1", method: "GET" })
    );
    expect(waitForRow).toHaveBeenCalledWith("row-1", TVMAZE_MCP_TIMEOUT_MS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("cancels the queued row and throws TvmazePaceTimeout when the waiter gives up", async () => {
    vi.mocked(enqueueTvmazeRequest).mockResolvedValue("row-1");
    vi.mocked(waitForRow).mockResolvedValue(null);
    vi.mocked(cancelQueuedRow).mockResolvedValue(true);

    const err = await tvmazeFetch("https://api.tvmaze.com/shows/1", undefined, {
      timeoutMs: 100,
    }).catch((e) => e);

    expect(cancelQueuedRow).toHaveBeenCalledWith("row-1");
    expect(err).toBeInstanceOf(TvmazePaceTimeout);
    expect(err.retryAfterSec).toBe(10); // one pace window
  });

  it("throws TvmazeRequestFailed when the row failed", async () => {
    vi.mocked(enqueueTvmazeRequest).mockResolvedValue("row-1");
    vi.mocked(waitForRow).mockResolvedValue({ id: "row-1", status: "failed", error: "boom" } as any);

    const err = await tvmazeFetch("https://api.tvmaze.com/shows/1").catch((e) => e);

    expect(err).toBeInstanceOf(TvmazeRequestFailed);
    expect(err.message).toContain("boom");
  });
});
