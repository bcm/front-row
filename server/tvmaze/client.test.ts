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
  parseRetryAfter,
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

const admitted = { admitted: true, retryAfterMs: 0, leaseId: "lease-1" };
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
    expect(releaseSlot).toHaveBeenCalledWith("lease-1");
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

describe("parseRetryAfter", () => {
  it("honors long delta-seconds values in full", () => {
    // Finding #2: values above 60s used to be shortened to 60, letting the
    // gate resume before the upstream-requested cooldown expired.
    expect(parseRetryAfter("90")).toBe(90);
    expect(parseRetryAfter("300")).toBe(300);
  });

  it("honors HTTP-date values in full within the bound", () => {
    const thirtyMin = new Date(Date.now() + 30 * 60_000).toUTCString();
    const delay = parseRetryAfter(thirtyMin)!;
    expect(delay).toBeGreaterThan(1_700);
    expect(delay).toBeLessThanOrEqual(1_800);
  });

  it("clamps absurd values to the anomaly bound instead of forever", () => {
    // A malformed/malicious header must not block the shared gate
    // indefinitely (no admin UI to clear it); the gate self-heals.
    expect(parseRetryAfter("999999999")).toBe(3600);
    const twoHours = new Date(Date.now() + 2 * 3_600_000).toUTCString();
    expect(parseRetryAfter(twoHours)).toBe(3600);
  });

  it("returns null for missing or unparsable values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("not-a-time")).toBeNull();
    // "-5" parses as a year in V8 -> a past date -> 0 (pre-existing).
    expect(parseRetryAfter("-5")).toBe(0);
  });
});
