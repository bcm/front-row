import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerShowTools } from "./shows";
import { toolRegistrar } from "../register";
import { mockStorage, testAuth, callTool, showFixture, userShowFixture, episodeFixture } from "../test-utils/tools";

vi.mock("../../storage", async () => {
  const { mockStorage } = await import("../test-utils/tools");
  return { storage: mockStorage() };
});

import { storage } from "../../storage";

const mocked = storage as unknown as ReturnType<typeof mockStorage>;

function server() {
  const s = new McpServer({ name: "test", version: "0" });
  registerShowTools(toolRegistrar(s), testAuth);
  return s;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getUserGroupIds.mockResolvedValue(["g1"]);
});

describe("show_get", () => {
  it("returns show details with per-episode statuses for the personal view", async () => {
    const show = showFixture({ lastSyncedAt: new Date("2026-09-20T12:00:00.000Z") });
    mocked.getShow.mockResolvedValue(show);
    mocked.getUserShows.mockResolvedValue([userShowFixture({ show })]);
    mocked.getEpisodes.mockResolvedValue([episodeFixture()]);
    mocked.getUserEpisodesForShow.mockResolvedValue([
      { episodeId: 101, status: "watched", watchedAt: new Date("2024-03-01"), groupId: null },
    ]);
    const { isError, body } = await callTool(server(), "show_get", { view: "personal", show_id: 1 });
    expect(isError).toBe(false);
    expect(body.show.tvmaze_id).toBe(1);
    expect(body.show.last_synced_at).toBe("2026-09-20T12:00:00.000Z");
    expect(body.show).not.toHaveProperty("tvmaze_updated_at");
    expect(body.episodes[0].statuses).toEqual([
      { group_id: null, status: "watched", watched_at: expect.any(String) },
    ]);
  });

  it("errors when the show is not in the requested view's library", async () => {
    mocked.getShow.mockResolvedValue(showFixture());
    mocked.getUserShows.mockResolvedValue([userShowFixture({ groupId: "g1", isShared: true })]);
    const { isError, body } = await callTool(server(), "show_get", { view: "personal", show_id: 1 });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/not in the personal library/);
  });

  it("errors for an unknown show", async () => {
    mocked.getShow.mockResolvedValue(undefined);
    const { isError, body } = await callTool(server(), "show_get", { view: "personal", show_id: 999 });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/not found/);
  });
});

describe("queue_next_up", () => {
  function record(showId: number, name: string, airdate: string, status: string) {
    const show = showFixture({ id: showId, name });
    return { status, groupId: null, episode: { ...episodeFixture({ showId, airdate }), show } };
  }

  it("picks the earliest actionable episode per show, ordered by airdate", async () => {
    mocked.getUserEpisodes.mockResolvedValue([
      record(1, "Alpha", "2024-05-01", "next"),
      record(1, "Alpha", "2024-04-01", "watched"),
      record(2, "Beta", "2024-03-15", "later"),
      record(2, "Beta", "2024-06-01", "untriaged"),
      record(3, "Gamma", "2024-02-01", "skipped"),
    ]);
    const { isError, body } = await callTool(server(), "queue_next_up", { view: "personal" });
    expect(isError).toBe(false);
    // Beta (2024-03-15) before Alpha (2024-05-01); Gamma excluded (all skipped).
    expect(body.queue.map((q: any) => q.show.name)).toEqual(["Beta", "Alpha"]);
    expect(body.queue[0].episode.airdate).toBe("2024-03-15");
  });

  it("exposes last_synced_at on each queued show", async () => {
    const syncedAt = new Date("2026-09-15T08:00:00.000Z");
    mocked.getUserEpisodes.mockResolvedValue([
      { status: "next", groupId: null, episode: { ...episodeFixture({ showId: 1, airdate: "2024-05-01" }), show: showFixture({ id: 1, name: "Alpha", lastSyncedAt: syncedAt }) } },
      { status: "next", groupId: null, episode: { ...episodeFixture({ showId: 2, airdate: "2024-06-01" }), show: showFixture({ id: 2, name: "Beta" }) } },
    ]);
    const { body } = await callTool(server(), "queue_next_up", { view: "personal" });
    expect(body.queue[0].show.last_synced_at).toBe("2026-09-15T08:00:00.000Z");
    expect(body.queue[1].show.last_synced_at).toBeNull();
  });

  it("respects the limit", async () => {
    mocked.getUserEpisodes.mockResolvedValue([
      record(1, "Alpha", "2024-05-01", "next"),
      record(2, "Beta", "2024-03-15", "later"),
    ]);
    const { body } = await callTool(server(), "queue_next_up", { view: "personal", limit: 1 });
    expect(body.queue).toHaveLength(1);
  });

  it("queries shared episode records for the family view", async () => {
    mocked.getUserEpisodes.mockResolvedValue([]);
    await callTool(server(), "queue_next_up", { view: "family" });
    expect(mocked.getUserEpisodes).toHaveBeenCalledWith("user-1", undefined, "shared", ["g1"]);
  });

  it("excludes ended shows when hide-finished-shows is on", async () => {
    mocked.getUserSettings.mockResolvedValue({ hideFinishedShows: true });
    const ended = { status: "next", groupId: null, episode: { ...episodeFixture({ showId: 9, airdate: "2024-01-01" }), show: showFixture({ id: 9, name: "Over", status: "Ended" }) } };
    mocked.getUserEpisodes.mockResolvedValue([
      { status: "next", groupId: null, episode: { ...episodeFixture({ showId: 1, airdate: "2024-05-01" }), show: showFixture({ id: 1, name: "Alpha" }) } },
      ended,
    ]);
    const { body } = await callTool(server(), "queue_next_up", { view: "personal" });
    expect(body.queue.map((q: any) => q.show.name)).toEqual(["Alpha"]);
  });

  it("includes ended shows when hide-finished-shows is off", async () => {
    mocked.getUserSettings.mockResolvedValue({ hideFinishedShows: false });
    const ended = { status: "next", groupId: null, episode: { ...episodeFixture({ showId: 9, airdate: "2024-01-01" }), show: showFixture({ id: 9, name: "Over", status: "Ended" }) } };
    mocked.getUserEpisodes.mockResolvedValue([ended]);
    const { body } = await callTool(server(), "queue_next_up", { view: "personal" });
    expect(body.queue.map((q: any) => q.show.name)).toEqual(["Over"]);
  });
});
