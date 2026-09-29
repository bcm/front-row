import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEpisodeTools } from "./episodes";
import { toolRegistrar } from "../register";
import { mockStorage, testAuth, callTool, showFixture, episodeFixture } from "../test-utils/tools";

vi.mock("../../storage", () => ({ storage: mockStorage() }));

import { storage } from "../../storage";

const mocked = storage as unknown as ReturnType<typeof mockStorage>;

function server() {
  const s = new McpServer({ name: "test", version: "0" });
  registerEpisodeTools(toolRegistrar(s), testAuth);
  return s;
}

function upcoming(id: number, airdate: string, groupId: string | null = null) {
  return { ...episodeFixture({ id, airdate }), show: showFixture(), groupId };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getUserGroupIds.mockResolvedValue(["g1"]);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:00Z"));
});

describe("upcoming_episodes", () => {
  it("returns episodes within the lookahead window, ordered by airdate", async () => {
    mocked.getUpcomingEpisodes.mockResolvedValue([
      upcoming(3, "2026-10-20"),
      upcoming(1, "2026-10-01"),
      upcoming(2, "2026-09-30"),
    ]);
    const { isError, body } = await callTool(server(), "upcoming_episodes", { view: "personal", days: 7 });
    expect(isError).toBe(false);
    expect(body.days).toBe(7);
    expect(body.upcoming.map((u: any) => u.episode.tvmaze_id)).toEqual([2, 1]);
  });

  it("passes the resolved view through to storage", async () => {
    mocked.getUpcomingEpisodes.mockResolvedValue([]);
    await callTool(server(), "upcoming_episodes", { view: "family" });
    expect(mocked.getUpcomingEpisodes).toHaveBeenCalledWith("user-1", "shared", ["g1"], 200);
  });

  it("flags truncation when the fetch cap fills up", async () => {
    mocked.getUpcomingEpisodes.mockResolvedValue(
      Array.from({ length: 200 }, (_, i) => upcoming(1000 + i, "2026-10-01"))
    );
    const { body } = await callTool(server(), "upcoming_episodes", { view: "personal", days: 30 });
    expect(body.truncated).toBe(true);
  });

  it("omits the truncation flag when the page is not full", async () => {
    mocked.getUpcomingEpisodes.mockResolvedValue([upcoming(1, "2026-10-01")]);
    const { body } = await callTool(server(), "upcoming_episodes", { view: "personal", days: 30 });
    expect(body.truncated).toBeUndefined();
  });
});
