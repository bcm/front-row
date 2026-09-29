import { describe, expect, it, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerLibraryTools } from "./library";
import { toolRegistrar } from "../register";
import { mockStorage, testAuth, callTool, showFixture, userShowFixture, episodeFixture } from "../test-utils/tools";

vi.mock("../../storage", () => ({ storage: mockStorage() }));

import { storage } from "../../storage";

const mocked = storage as unknown as ReturnType<typeof mockStorage>;

function server() {
  const s = new McpServer({ name: "test", version: "0" });
  registerLibraryTools(toolRegistrar(s), testAuth);
  return s;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getUserGroupIds.mockResolvedValue(["g1"]);
});

describe("library_list", () => {
  const personal = userShowFixture();
  const family = userShowFixture({ id: "us-2", groupId: "g1", isShared: true, show: showFixture({ id: 2, name: "Family Show" }) });

  it("personal view returns only non-shared shows", async () => {
    mocked.getUserShows.mockResolvedValue([personal, family]);
    const { isError, body } = await callTool(server(), "library_list", { view: "personal" });
    expect(isError).toBe(false);
    expect(body.view).toBe("personal");
    expect(body.shows.map((s: any) => s.name)).toEqual(["Test Show"]);
  });

  it("family view returns only the user's group shows", async () => {
    mocked.getUserShows.mockResolvedValue([personal, family]);
    const { body } = await callTool(server(), "library_list", { view: "family" });
    expect(body.shows.map((s: any) => s.name)).toEqual(["Family Show"]);
    expect(body.shows[0].group_id).toBe("g1");
  });

  it("family view with no groups returns an empty list with a note", async () => {
    mocked.getUserGroupIds.mockResolvedValue([]);
    mocked.getUserShows.mockResolvedValue([personal]);
    const { body } = await callTool(server(), "library_list", { view: "family" });
    expect(body.shows).toEqual([]);
    expect(body.note).toMatch(/not a member of any group/);
  });

  it("excludes removed shows by default", async () => {
    mocked.getUserShows.mockResolvedValue([personal]);
    await callTool(server(), "library_list", { view: "personal" });
    expect(mocked.getUserShows).toHaveBeenCalledWith("user-1", false);
  });
});

describe("library_search", () => {
  const show = showFixture();
  const ep = { ...episodeFixture(), show };

  it("personal view composes show and episode search", async () => {
    mocked.getUserShows.mockResolvedValue([userShowFixture({ show })]);
    mocked.searchUserShows.mockResolvedValue([show]);
    mocked.searchUserEpisodes.mockResolvedValue([ep]);
    const { isError, body } = await callTool(server(), "library_search", { view: "personal", query: "test" });
    expect(isError).toBe(false);
    expect(body.shows).toHaveLength(1);
    expect(body.episodes).toHaveLength(1);
    expect(body.episodes[0].show.tvmaze_id).toBe(1);
  });

  it("personal view excludes shows shared with a group", async () => {
    const familyShow = showFixture({ id: 2, name: "Family Drama" });
    mocked.getUserShows.mockResolvedValue([
      userShowFixture({ show }),
      userShowFixture({ show: familyShow, groupId: "g1", isShared: true }),
    ]);
    mocked.searchUserShows.mockResolvedValue([show, familyShow]);
    mocked.searchUserEpisodes.mockResolvedValue([{ ...episodeFixture(), show: familyShow }]);
    const { body } = await callTool(server(), "library_search", { view: "personal", query: "drama" });
    expect(body.shows.map((s: any) => s.name)).toEqual(["Test Show"]);
    expect(body.episodes).toEqual([]);
  });

  it("family view filters the shared library by title", async () => {
    const familyShow = showFixture({ id: 2, name: "Family Drama" });
    mocked.getUserShows.mockResolvedValue([
      userShowFixture({ show }),
      userShowFixture({ show: familyShow, groupId: "g1", isShared: true }),
    ]);
    mocked.searchUserShows.mockResolvedValue([familyShow]);
    mocked.searchUserEpisodes.mockResolvedValue([]);
    const { body } = await callTool(server(), "library_search", { view: "family", query: "drama" });
    expect(body.shows.map((s: any) => s.name)).toEqual(["Family Drama"]);
  });

  it("family view returns future episodes, unlike the old aired-only path", async () => {
    const familyShow = showFixture({ id: 2, name: "Family Drama" });
    const futureEp = { ...episodeFixture({ id: 202, airdate: "2026-12-01" }), show: familyShow };
    mocked.getUserShows.mockResolvedValue([userShowFixture({ show: familyShow, groupId: "g1", isShared: true })]);
    mocked.searchUserShows.mockResolvedValue([]);
    mocked.searchUserEpisodes.mockResolvedValue([futureEp]);
    const { body } = await callTool(server(), "library_search", { view: "family", query: "pilot" });
    expect(body.episodes).toHaveLength(1);
    expect(body.episodes[0].episode.airdate).toBe("2026-12-01");
    expect(body.episodes[0].group_id).toBe("g1");
  });

  it("family view with no groups returns empty results with a note", async () => {
    mocked.getUserGroupIds.mockResolvedValue([]);
    mocked.getUserShows.mockResolvedValue([userShowFixture({ show })]);
    mocked.searchUserShows.mockResolvedValue([show]);
    mocked.searchUserEpisodes.mockResolvedValue([]);
    const { body } = await callTool(server(), "library_search", { view: "family", query: "test" });
    expect(body.shows).toEqual([]);
    expect(body.note).toMatch(/not a member of any group/);
  });
});
