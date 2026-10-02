// Tests for the in-memory TVMaze GET cache.

import { describe, expect, it, beforeEach } from "vitest";
import { getCachedResponse, putCachedResponse, clearTvmazeCache } from "./cache";

const URL = "https://api.tvmaze.com/shows/1";

beforeEach(() => clearTvmazeCache());

describe("tvmaze cache", () => {
  it("misses on an empty cache", () => {
    expect(getCachedResponse(URL)).toBeUndefined();
  });

  it("returns the stored body and status on a hit", async () => {
    putCachedResponse(URL, 200, '{"id":1}');

    const res = getCachedResponse(URL);

    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ id: 1 });
  });

  it("expires entries after the TTL", () => {
    putCachedResponse(URL, 200, "x");
    const expiredNow = Date.now() + 61 * 60_000;

    expect(getCachedResponse(URL, expiredNow)).toBeUndefined();
    // Expired entries are evicted, so a later read still misses.
    expect(getCachedResponse(URL)).toBeUndefined();
  });

  it("evicts the oldest entry when full", () => {
    for (let i = 0; i < 500; i++) putCachedResponse(`${URL}/${i}`, 200, "x");
    putCachedResponse(`${URL}/new`, 200, "y");

    expect(getCachedResponse(`${URL}/0`)).toBeUndefined();
    expect(getCachedResponse(`${URL}/new`)).toBeDefined();
  });
});
