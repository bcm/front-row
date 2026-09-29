import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDiscoveryTools } from "./discovery";
import { toolRegistrar } from "../register";
import { mockStorage, testAuth, callTool } from "../test-utils/tools";

vi.mock("../../storage", () => ({ storage: mockStorage() }));
vi.mock("../../new-releases-service", () => ({ getNewReleases: vi.fn() }));
vi.mock("../../sync-job-manager", () => ({ syncJobManager: { getJob: vi.fn() } }));

import { storage } from "../../storage";
import { getNewReleases } from "../../new-releases-service";
import { syncJobManager } from "../../sync-job-manager";

const mockedStorage = storage as unknown as ReturnType<typeof mockStorage>;
const mockedReleases = getNewReleases as unknown as ReturnType<typeof vi.fn>;
const mockedJobs = syncJobManager as unknown as { getJob: ReturnType<typeof vi.fn> };

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

describe("sync_status", () => {
  it("returns job progress for a known job", async () => {
    mockedJobs.getJob.mockReturnValue({
      id: "sync_1",
      showId: 42,
      status: "running",
      phase: "fetch-episodes",
      percent: 50,
      episodesImported: 10,
      episodesUpdated: 2,
      errors: [],
      lastMessage: "Fetching episodes",
      updatedAt: new Date("2026-09-29T11:00:00Z"),
    });
    const { isError, body } = await callTool(server(), "sync_status", { view: "personal", job_id: "sync_1" });
    expect(isError).toBe(false);
    expect(body.job).toMatchObject({ id: "sync_1", show_id: 42, status: "running", percent: 50 });
  });

  it("errors for an unknown job id", async () => {
    mockedJobs.getJob.mockReturnValue(null);
    const { isError, body } = await callTool(server(), "sync_status", { view: "personal", job_id: "nope" });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/unknown sync job/);
  });
});
