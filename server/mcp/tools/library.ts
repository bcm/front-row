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
      // family means one of the user's groups.
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
      // Show title matching runs over the already-loaded view rows instead of
      // storage.searchUserShows: that query only matches the token user's own
      // rows (missing shows another member added to a shared group) and caps
      // at 20 before any view filtering, either of which can displace
      // in-view matches. The library is small; filter it directly.
      const q = query.toLowerCase();
      const matchedShows = new Map<number, (typeof viewRows)[number]["show"]>();
      for (const us of viewRows) {
        if (!matchedShows.has(us.showId) && us.show.name.toLowerCase().includes(q)) {
          matchedShows.set(us.showId, us.show);
        }
      }
      // searchUserEpisodes unions group records and has no airdate
      // restriction (so future episodes are searchable in both views). The
      // view predicate applies in SQL before the limit, so out-of-view rows
      // can't displace in-view matches; the filter below stays as a backstop.
      const episodes = await storage.searchUserEpisodes(auth.userId, query, 200, {
        mode: resolved.showMode,
        groupIds: resolved.groupIds,
      });
      return ok({
        view,
        shows: [...matchedShows.values()].map(trimShow),
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
