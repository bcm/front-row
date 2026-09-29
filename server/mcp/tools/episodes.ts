// upcoming_episodes: episodes airing in the next N days across the view's library.

import type { ToolRegistrar } from "../register";
import { z } from "zod";
import { storage } from "../../storage";
import type { McpAuthContext } from "../../oauth/middleware";
import { viewSchema, resolveView } from "../view";
import { ok } from "../format";
import { trimShow, trimEpisode } from "../trim";

// Storage returns the soonest-first page of upcoming episodes; fetch wide
// enough that a 30-day window is complete for any realistic library, and say
// so explicitly when the page fills up.
const FETCH_LIMIT = 200;

export function registerEpisodeTools(tools: ToolRegistrar, auth: McpAuthContext): void {
  tools.registerReadTool(
    "upcoming_episodes",
    "Episodes airing in the next N days across the library for an explicit view, ordered by airdate.",
    {
      view: viewSchema,
      days: z.number().int().min(1).max(30).optional().describe("Lookahead window in days. Default 7."),
    },
    async ({ view, days }) => {
      const resolved = await resolveView(auth.userId, view);
      const episodes = await storage.getUpcomingEpisodes(auth.userId, resolved.showMode, resolved.groupIds, FETCH_LIMIT);
      const today = new Date().toISOString().split("T")[0];
      const cutoff = new Date(Date.now() + (days ?? 7) * 24 * 3600 * 1000).toISOString().split("T")[0];
      const upcoming = episodes
        .filter((ep) => (ep.airdate ?? "") >= today && (ep.airdate ?? "") <= cutoff)
        .map((ep) => ({
          show: trimShow(ep.show),
          episode: trimEpisode(ep),
          group_id: ep.groupId ?? null,
        }));
      return ok({
        view,
        days: days ?? 7,
        upcoming,
        ...(episodes.length >= FETCH_LIMIT ? { truncated: true, note: "result hit the fetch cap; narrow the window" } : {}),
        ...(resolved.view === "family" && resolved.groupIds.length === 0
          ? { note: "family view requested but the user is not a member of any group" }
          : {}),
      });
    }
  );
}
