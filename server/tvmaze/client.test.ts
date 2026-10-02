// Tests for the TVMaze client: gate admission, cache, retries, timeouts.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { tryAcquireSlot, releaseSlot, setPaceCooldown, setPaceCooldownUntil } from "./pace";
import { clearTvmazeCache } from "./cache";

vi.mock("./pace", () => ({
  tryAcquireSlot: vi.fn(),
  releaseSlot: vi.fn(),
  setPaceCooldown: vi.fn(),
  // Echo the requested instant: the real one returns the DB-applied
  // instant, which equals the input when the anomaly bound doesn't bite.
  setPaceCooldownUntil: vi.fn(async (d: Date) => d),
  MAX_RETRY_AFTER_SEC: 3600,
}));

import {
  tvmazeFetch,
  parseRetryAfter,
  parseRetryAfterInstant,
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
  // mockClear, not reset: keep the echo implementation (input instant is
  // the DB-applied one when the anomaly bound doesn't bite).
  vi.mocked(setPaceCooldownUntil).mockClear();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const admitted = { admitted: true, retryAfterMs: 0, leaseId: "lease-1" };
const okResponse = (body = '{"ok":true}') => new Response(body, { status: 200 });

// HTTP-date headers carry whole seconds; floor so round-trips compare exactly.
const atSecond = (ms: number) => new Date(Math.floor(ms / 1000) * 1000);

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
    expect(setPaceCooldownUntil).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(releaseSlot).toHaveBeenCalledTimes(2);
  });

  it("stores the HTTP-date Retry-After instant against the database clock", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    const at = atSecond(Date.now() + 30 * 60_000);
    fetchMock
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": at.toUTCString() },
        }),
      )
      .mockResolvedValueOnce(okResponse());

    const res = await tvmazeFetch("https://api.tvmaze.com/shows/1");

    // The absolute instant is preserved — not converted to seconds
    // against the replica clock — so SQL can compare it to now().
    expect(setPaceCooldownUntil).toHaveBeenCalledWith(at);
    expect(setPaceCooldown).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("logs when the database clamps an anomalous HTTP-date", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    const at = atSecond(Date.now() + 2 * 3_600_000);
    const appliedAt = atSecond(Date.now() + 3_600_000);
    vi.mocked(setPaceCooldownUntil).mockResolvedValueOnce(appliedAt);
    fetchMock
      .mockResolvedValueOnce(
        new Response("slow down", {
          status: 429,
          headers: { "retry-after": at.toUTCString() },
        }),
      )
      .mockResolvedValueOnce(okResponse());
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await tvmazeFetch("https://api.tvmaze.com/shows/1");

    // The 1h LEAST bound is evaluated against PostgreSQL now() inside
    // setPaceCooldownUntil; the client only reports when it bit.
    const events = logSpy.mock.calls.map(([line]) => JSON.parse(String(line)).event);
    expect(events).toContain("retry_after_clamped");
    expect(events).toContain("cooldown");
    logSpy.mockRestore();
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

  it("returns null for the HTTP-date form — it keeps its absolute instant", () => {
    // Finding: HTTP-date values were converted to seconds against the
    // replica's clock, baking skew into the cooldown. They now travel the
    // parseRetryAfterInstant + setPaceCooldownUntil path instead.
    const thirtyMin = new Date(Date.now() + 30 * 60_000).toUTCString();
    expect(parseRetryAfter(thirtyMin)).toBeNull();
  });

  it("clamps absurd values to the anomaly bound instead of forever", () => {
    // A malformed/malicious header must not block the shared gate
    // indefinitely (no admin UI to clear it); the gate self-heals.
    expect(parseRetryAfter("999999999")).toBe(3600);
  });

  it("returns null for missing, negative, or unparsable values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("not-a-time")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });
});

describe("parseRetryAfterInstant", () => {
  it("preserves the absolute instant of an HTTP-date value", () => {
    const at = atSecond(Date.now() + 30 * 60_000);
    expect(parseRetryAfterInstant(at.toUTCString())).toEqual(at);
  });

  it("returns null for the delta-seconds form", () => {
    expect(parseRetryAfterInstant("90")).toBeNull();
  });

  it("returns null for missing or unparsable values", () => {
    expect(parseRetryAfterInstant(null)).toBeNull();
    expect(parseRetryAfterInstant("")).toBeNull();
    expect(parseRetryAfterInstant("not-a-time")).toBeNull();
  });

  it("preserves absurd futures untouched — the anomaly bound lives in SQL", () => {
    // Finding: the 1h clamp used the replica clock (Date.now()) — a
    // replica behind the database shortened a valid cooldown, one ahead
    // stretched an anomalous one past a database hour. Parsing now
    // preserves the instant; setPaceCooldownUntil applies LEAST against
    // PostgreSQL now().
    const twoHours = new Date(Date.now() + 2 * 3_600_000).toUTCString();
    expect(parseRetryAfterInstant(twoHours)!.getTime()).toBe(Date.parse(twoHours));
  });

  it("does not shorten the instant when the replica clock is ahead", () => {
    // Finding: converting via Date.now() shortened the delay by the
    // replica's skew before setPaceCooldown anchored it to the DB clock.
    // The instant must survive skew untouched — SQL compares it to now().
    const at = atSecond(Date.now() + 30 * 60_000);
    const skewNow = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    try {
      expect(parseRetryAfterInstant(at.toUTCString())).toEqual(at);
    } finally {
      skewNow.mockRestore();
    }
  });
});
