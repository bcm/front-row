// Tests for tvmazeFetch caller-budget enforcement and cache bypass.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { tryAcquireSlot, releaseSlot } from "./pace";
import { clearTvmazeCache } from "./cache";

vi.mock("./pace", () => ({
  tryAcquireSlot: vi.fn(),
  releaseSlot: vi.fn(),
  setPaceCooldown: vi.fn(),
  setPaceCooldownUntil: vi.fn(),
  MAX_RETRY_AFTER_SEC: 3600,
}));

import { tvmazeFetch, TvmazePaceTimeout } from "./client";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  clearTvmazeCache();
  vi.mocked(tryAcquireSlot).mockReset();
  vi.mocked(releaseSlot).mockReset();
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const admitted = { admitted: true, retryAfterMs: 0, leaseId: "lease-1" };
const okResponse = (body = '{"ok":true}') => new Response(body, { status: 200 });

describe("caller deadline on admitted attempts", () => {
  it("caps the admitted fetch at the remaining caller budget", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await tvmazeFetch("https://api.tvmaze.com/shows/9", undefined, { timeoutMs: 8000 });
    // Read before restore: mockRestore clears the call history.
    const capped = timeoutSpy.mock.calls[0][0];
    timeoutSpy.mockRestore();
    // Each admitted fetch used the full 15s timeout, so an 8s
    // catalog_search budget could block ~45s across retries. The abort is
    // now capped at the remaining budget.
    expect(capped).toBeGreaterThan(0);
    expect(capped).toBeLessThanOrEqual(8000);
  });

  it("never touches the gate once the budget is exhausted", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));

    const err = await tvmazeFetch("https://api.tvmaze.com/shows/10", undefined, {
      timeoutMs: 0,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TvmazePaceTimeout);
    // Finding: the old loop slept for the remaining budget, then called
    // tryAcquireSlot() after the deadline — the DB advanced next_admit_at
    // for a caller that immediately timed out, consuming a shared
    // admission and delaying live work. The deadline is now checked
    // before every acquisition, so a zero budget never reaches the gate:
    // no lease acquired, nothing to release, nothing fetched.
    expect(tryAcquireSlot).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseSlot).not.toHaveBeenCalled();
  });

  it("times out without fetching when the deadline falls inside acquisition", async () => {
    // The deadline can still expire during tryAcquireSlot() itself; the
    // admitted path re-checks and releases the slot without fetching.
    vi.mocked(tryAcquireSlot).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(admitted), 100)),
    );
    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));

    const err = await tvmazeFetch("https://api.tvmaze.com/shows/10", undefined, {
      timeoutMs: 20,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TvmazePaceTimeout);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(releaseSlot).toHaveBeenCalledWith("lease-1");
  });

  it("maps a budget-exhausted fetch to TvmazePaceTimeout, not TvmazeRequestFailed", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    // Hang until the abort signal fires, like a slow upstream.
    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    );

    const err = await tvmazeFetch("https://api.tvmaze.com/shows/11", undefined, {
      timeoutMs: 150,
    }).catch((e) => e);

    expect(err).toBeInstanceOf(TvmazePaceTimeout);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("bypassCache", () => {
  it("bypasses the cache when set", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));
    const url = "https://api.tvmaze.com/schedule?date=2026-01-01";

    await tvmazeFetch(url);
    await tvmazeFetch(url, undefined, { bypassCache: true });

    // Finding: forced refreshes (e.g. refreshNewReleases) silently replayed
    // the 60-minute in-memory schedule instead of reaching TVMaze.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(tryAcquireSlot)).toHaveBeenCalledTimes(2);
  });

  it("a bypassed fetch does not populate the cache", async () => {
    vi.mocked(tryAcquireSlot).mockResolvedValue(admitted);
    fetchMock.mockImplementation(() => Promise.resolve(okResponse()));
    const url = "https://api.tvmaze.com/schedule?date=2026-01-02";

    await tvmazeFetch(url, undefined, { bypassCache: true });
    await tvmazeFetch(url);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
