// library_list + library_search: read the user's library within an explicit view.

import { z } from "zod";
import { storage } from "../../storage";
import type { McpAuthContext } from "../../oauth/middleware";
import type { ToolRegistrar } from "../register";
import { viewSchema, resolveView } from "../view";
import { ok } from "../format";
import { trimLibraryEntry, trimShow, trimEpisode } from "../trim";

export function registerLibraryTools(tools: ToolRegistrar, auth: McpAuthContext): void {
  tools.registerReadTool(
    "library_list",
    "List shows in the user's library for an explicit view. 'personal' returns only the user's own shows; 'family' returns shows shared with the user's groups.",
    {
      view: viewSchema,
      include_removed: z
        .boolean()
        .optional()
        .describe("Include soft-removed shows. Default false."),
    },
    async ({ view, include_removed }) => {
      const resolved = await resolveView(auth.userId, view);
      const all = await storage.getUserShows(auth.userId, include_removed ?? false);
      const rows = all.filter((us) =>
        resolved.view === "personal" ? us.groupId == null : resolved.groupIds.includes(us.groupId ?? "")
      );
      return ok({
        view,
        shows: rows.map(trimLibraryEntry),
        ...(resolved.view === "family" && resolved.groupIds.length === 0
          ? { note: "family view requested but the user is not a member of any group" }
          : {}),
      });
    }
  );

  tools.registerReadTool(
    "library_search",
    "Search the user's library by show or episode title, within an explicit view. 'personal' matches only the user's own shows; 'family' matches shows shared with the user's groups.",
    {
      view: viewSchema,
      query: z.string().min(1).describe("Text matched against show and episode titles."),
    },
    async ({ view, query }) => {
      const resolved = await resolveView(auth.userId, view);
      // View membership, same rule as library_list: personal means no group,
      // family means one of the user's groups. The storage search methods are
      // view-unaware (searchUserEpisodes unions group records; neither
      // filters on groupId), so enforcement happens here.
      const library = await storage.getUserShows(auth.userId, false);
      const inView = (us: (typeof library)[number]) =>
        !us.isRemoved &&
        (resolved.view === "personal" ? us.groupId == null : resolved.groupIds.includes(us.groupId ?? ""));
      const viewRows = library.filter(inView);
      const viewShowIds = new Set(viewRows.map((us) => us.showId));
      const groupByShow = new Map<number, string | null>();
      for (const us of viewRows) {
        if (!groupByShow.has(us.showId)) groupByShow.set(us.showId, us.groupId ?? null);
      }
      // searchUserEpisodes has no airdate restriction, so unlike the old
      // family path (getUserEpisodes, aired-only) future episodes are
      // searchable in both views.
      const [shows, episodes] = await Promise.all([
        storage.searchUserShows(auth.userId, query),
        storage.searchUserEpisodes(auth.userId, query),
      ]);
      return ok({
        view,
        shows: shows.filter((s) => viewShowIds.has(s.id)).map(trimShow),
        episodes: episodes
          .filter((e) => viewShowIds.has(e.show.id))
          .map((e) => ({
            ...trimEpisode(e),
            show: trimShow(e.show),
            group_id: groupByShow.get(e.show.id) ?? null,
          })),
        ...(resolved.view === "family" && resolved.groupIds.length === 0
          ? { note: "family view requested but the user is not a member of any group" }
          : {}),
      });
    }
  );
}
