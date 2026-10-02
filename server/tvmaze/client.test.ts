// Tests for the TVMaze client: gate admission, cache, retries, timeouts.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { tryAcquireSlot, releaseSlot, setPaceCooldown } from "./pace";
import { clearTvmazeCache } from "./cache";

vi.mock("./pace", () => ({
  tryAcquireSlot: vi.fn(),
  releaseSlot: vi.fn(),
  setPaceCooldown: vi.fn(),
}));

import {
  tvmazeFetch,
  TvmazePaceTimeout,
  TvmazeRequestFailed,
  TVMAZE_USER_AGENT,
} from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  clearTvmazeCache();
  vi.mocked(tryAcquireSlot).mockReset();
  vi.mocked(releaseSlot).mockReset();
  vi.mocked(setPaceCooldown).mockReset();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const admitted = { admitted: true, retryAfterMs: 0 };
const okResponse = (body = '{"ok":true}') => new Response(body, { status: 200 });

describe("tvmazeFetch", () => {
  it("admits through the gate, fetches, and releases the slot", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    fetchMock.mockResolvedValue(okResponse());

    const res = await tvmazeFetch("https://api.tvmaze.com/shows/1");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tvmaze.com/shows/1",
      expect.objectContaining({
        headers: expect.objectContaining({ "User-Agent": TVMAZE_USER_AGENT }),
      }),
    );
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("serves a repeated GET from cache without touching the gate", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    fetchMock.mockResolvedValue(okResponse());

    await tvmazeFetch("https://api.tvmaze.com/shows/1");
    const res = await tvmazeFetch("https://api.tvmaze.com/shows/1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tryAcquireSlot)).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("does not cache non-GET requests", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));

    await tvmazeFetch("https://api.tvmaze.com/shows/1", { method: "POST", body: "{}" });
    await tvmazeFetch("https://api.tvmaze.com/shows/1", { method: "POST", body: "{}" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits on denial and fetches once admitted", async () => {
    vi.mocked(tryAcquireSlot)
      .mockResolvedValueOnce({ admitted: false, retryAfterMs: 5 })
      .mockResolvedValue(admitted);
    fetchMock.mockResolvedValue(okResponse());

    const res = await tvmazeFetch("https://api.tvmaze.com/search/shows?q=x", undefined, {
      timeoutMs: 2000,
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(releaseSlot).toHaveBeenCalledTimes(1);
  });

  it("throws TvmazePaceTimeout when the caller budget runs out", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue({ admitted: false, retryAfterMs: 60_000 });

    const err = await tvmazeFetch("https://api.tvmaze.com/shows/1", undefined, {
      timeoutMs: 30,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TvmazePaceTimeout);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets a cooldown on 429 and retries within budget", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    fetchMock
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(okResponse());

    const res = await tvmazeFetch("https://api.tvmaze.com/shows/1");

    expect(setPaceCooldown).toHaveBeenCalledWith(2);
    expect(res.status).toBe(200);
    expect(releaseSlot).toHaveBeenCalledTimes(2);
  });

  it("throws TvmazeRequestFailed after repeated transport failures", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    fetchMock.mockRejectedValue(new Error("boom"));

    const err = await tvmazeFetch("https://api.tvmaze.com/shows/1").catch((e) => e);

    expect(err).toBeInstanceOf(TvmazeRequestFailed);
    expect(err.message).toContain("boom");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(releaseSlot).toHaveBeenCalledTimes(3);
  });
});
