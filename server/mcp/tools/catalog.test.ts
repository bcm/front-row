import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCatalogTools } from "./catalog";
import { toolRegistrar } from "../register";
import { mockStorage, testAuth, callTool } from "../test-utils/tools";

vi.mock("../../storage", () => ({ storage: mockStorage() }));
vi.mock("../rate-limit", () => ({ checkRateLimit: vi.fn(), rateLimitKey: vi.fn(() => "k") }));

import { storage } from "../../storage";
import { checkRateLimit } from "../rate-limit";

const mockedStorage = storage as unknown as ReturnType<typeof mockStorage>;
const mockedCheck = checkRateLimit as unknown as ReturnType<typeof vi.fn>;

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
  mockedStorage.getUserShowIds.mockResolvedValue([1]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(tvmazeHits) }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("catalog_search", () => {
  it("returns trimmed hits with in_library flags", async () => {
    const { isError, body } = await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(isError).toBe(false);
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ tvmaze_id: 1, name: "Test Show", in_library: true });
    expect(body.results[1].in_library).toBe(false);
  });

  it("returns an error result when the rate limit is hit", async () => {
    mockedCheck.mockResolvedValue({ allowed: false, retryAfterSec: 42 });
    const { isError, body } = await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/rate limit exceeded.*42s/);
  });

  it("returns an error result when TVMaze fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const { isError, body } = await callTool(server(), "catalog_search", { view: "personal", query: "test" });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/503/);
  });
});
