import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDiscoveryTools } from "./discovery";
import { toolRegistrar } from "../register";
import { mockStorage, testAuth, callTool } from "../test-utils/tools";

vi.mock("../../storage", async () => {
  const { mockStorage } = await import("../test-utils/tools");
  return { storage: mockStorage() };
});
vi.mock("../../new-releases-service", () => ({ getNewReleases: vi.fn() }));

import { storage } from "../../storage";
import { getNewReleases } from "../../new-releases-service";

const mockedStorage = storage as unknown as ReturnType<typeof mockStorage>;
const mockedReleases = getNewReleases as unknown as ReturnType<typeof vi.fn>;

function server() {
  const s = new McpServer({ name: "test", version: "0" });
  registerDiscoveryTools(toolRegistrar(s), testAuth);
  return s;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("releases_new", () => {
  it("returns releases with freshness metadata", async () => {
    mockedReleases.mockResolvedValue({
      shows: [{ id: 7, name: "New Hit" }],
      lastChecked: new Date("2026-09-29T10:00:00Z"),
      fromCache: true,
    });
    const { isError, body } = await callTool(server(), "releases_new", { view: "personal" });
    expect(isError).toBe(false);
    expect(body.releases).toEqual([{ id: 7, name: "New Hit" }]);
    expect(body.from_cache).toBe(true);
    expect(body.last_checked).toBe("2026-09-29T10:00:00.000Z");
    expect(mockedReleases).toHaveBeenCalledWith("user-1");
  });
});

describe("recommendations_list", () => {
  it("returns trimmed recommendations for the token's user", async () => {
    mockedStorage.getRecommendations.mockResolvedValue([
      {
        tmdbId: 123,
        name: "Rec Show",
        overview: "Great show",
        posterPath: "/p.jpg",
        voteAverage: 8,
        network: "HBO",
        genres: ["Drama"],
        firstAirDate: "2021-01-01",
        score: 95,
      },
    ]);
    const { isError, body } = await callTool(server(), "recommendations_list", { view: "family", limit: 10 });
    expect(isError).toBe(false);
    expect(body.recommendations[0]).toMatchObject({ tmdb_id: 123, name: "Rec Show", score: 95 });
    expect(mockedStorage.getRecommendations).toHaveBeenCalledWith("user-1", 10);
  });
});
