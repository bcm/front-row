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
    "Search the user's library by show or episode title, within an explicit view. Same composition as the app's search.",
    {
      view: viewSchema,
      query: z.string().min(1).describe("Text matched against show and episode titles."),
    },
    async ({ view, query }) => {
      const resolved = await resolveView(auth.userId, view);
      if (resolved.view === "personal") {
        const [shows, episodes] = await Promise.all([
          storage.searchUserShows(auth.userId, query),
          storage.searchUserEpisodes(auth.userId, query),
        ]);
        return ok({
          view,
          shows: shows.map(trimShow),
          episodes: episodes.map((e) => ({ ...trimEpisode(e), show: trimShow(e.show) })),
        });
      }
      // Storage search is personal-only; filter the family library/episodes here.
      const [library, epRecords] = await Promise.all([
        storage.getUserShows(auth.userId),
        storage.getUserEpisodes(auth.userId, undefined, "shared", resolved.groupIds),
      ]);
      const q = query.toLowerCase();
      return ok({
        view,
        shows: library
          .filter((us) => resolved.groupIds.includes(us.groupId ?? "") && us.show.name.toLowerCase().includes(q))
          .map(trimLibraryEntry),
        episodes: epRecords
          .filter((r) => (r.episode.name ?? "").toLowerCase().includes(q))
          .map((r) => ({ ...trimEpisode(r.episode), show: trimShow(r.episode.show), group_id: r.groupId ?? null })),
      });
    }
  );
}
