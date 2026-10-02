import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCatalogTools } from "./catalog";
import { toolRegistrar } from "../register";
import { mockStorage, testAuth, callTool, showFixture, userShowFixture } from "../test-utils/tools";

vi.mock("../../storage", async () => {
  const { mockStorage } = await import("../test-utils/tools");
  return { storage: mockStorage() };
});
vi.mock("../rate-limit", () => ({ checkRateLimit: vi.fn(), rateLimitKey: vi.fn(() => "k") }));
vi.mock("../../tvmaze/client", () => {
  class TvmazePaceTimeout extends Error {
    retryAfterSec: number;
    constructor(retryAfterSec: number) {
      super("paced out");
      this.retryAfterSec = retryAfterSec;
    }
  }
  class TvmazeRequestFailed extends Error {}
  return {
    tvmazeFetch: vi.fn(),
    TvmazePaceTimeout,
    TvmazeRequestFailed,
    TVMAZE_MCP_TIMEOUT_MS: 8000,
  };
});

import { storage } from "../../storage";
import { checkRateLimit } from "../rate-limit";
import { tvmazeFetch, TvmazePaceTimeout, TvmazeRequestFailed } from "../../tvmaze/client";

const mockedStorage = storage as unknown as ReturnType<typeof mockStorage>;
const mockedCheck = checkRateLimit as unknown as ReturnType<typeof vi.fn>;
const mockedTvmazeFetch = tvmazeFetch as unknown as ReturnType<typeof vi.fn>;

function server() {
  const s = new McpServer({ name: "test", version: "0" });
  registerCatalogTools(toolRegistrar(s), testAuth);
  return s;
}

const tvmazeHits = [
  { score: 10, show: { id: 1, name: "Test Show", status: "Running", genres: ["Drama"], rating: { average: 8 } } },
  { score: 5, show: { id: 99, name: "Other Show", status: "Ended", genres: [], rating: {} } },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockedCheck.mockResolvedValue({ allowed: true });
  mockedStorage.getUserGroupIds.mockResolvedValue([]);
  mockedStorage.getUserShows.mockResolvedValue([userShowFixture({ show: showFixture({ id: 1 }) })]);
  mockedTvmazeFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(tvmazeHits) });
});

describe("catalog_search", () => {
  it("returns trimmed hits with in_library flags", async () => {
    const { isError, body } = await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(isError).toBe(false);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ tvmaze_id: 1, name: "Test Show", in_library: true });
    expect(body.results[1].in_library).toBe(false);
  });

  it("goes through the paced TVMaze client with the MCP timeout", async () => {
    await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(mockedTvmazeFetch).toHaveBeenCalledWith(
      expect.stringContaining("api.tvmaze.com/search/shows"),
      undefined,
      { timeoutMs: 8000 }
    );
  });

  it("returns an error result when the rate limit is hit", async () => {
    mockedCheck.mockResolvedValue({ allowed: false, retryAfterSec: 42 });
    const { isError, body } = await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/rate limit exceeded.*42s/);
    expect(mockedTvmazeFetch).not.toHaveBeenCalled();
  });

  it("returns an error result when TVMaze fails", async () => {
    mockedTvmazeFetch.mockResolvedValue({ ok: false, status: 503 });
    const { isError, body } = await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/503/);
  });

  it("returns a 429-style retry hint when the pace queue times out", async () => {
    mockedTvmazeFetch.mockRejectedValue(new TvmazePaceTimeout(10));
    const { isError, body } = await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/429.*retry in 10s/);
  });

  it("returns an error result when the queued request fails", async () => {
    mockedTvmazeFetch.mockRejectedValue(new TvmazeRequestFailed("boom"));
    const { isError, body } = await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/boom/);
  });

  it("does not mark group-shared shows as in_library in the personal view", async () => {
    mockedStorage.getUserShows.mockResolvedValue([
      userShowFixture({ show: showFixture({ id: 99 }), groupId: "g1", isShared: true }),
    ]);
    const { body } = await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(body.results.find((r: any) => r.tvmaze_id === 99).in_library).toBe(false);
  });
});
