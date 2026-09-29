// show_get + queue_next_up: show details and the "what's next" queue.

import type { ToolRegistrar } from "../register";
import { z } from "zod";
import { storage } from "../../storage";
import type { McpAuthContext } from "../../oauth/middleware";
import { viewSchema, resolveView } from "../view";
import { ok, err } from "../format";
import { trimShow, trimEpisode } from "../trim";

// Episode statuses that mean "still to watch".
const ACTIONABLE = new Set(["untriaged", "later", "next"]);

export function registerShowTools(tools: ToolRegistrar, auth: McpAuthContext): void {
  tools.registerReadTool(
    "show_get",
    "Show details plus its episode list with the user's watch statuses for an explicit view. " +
      "tvmaze_updated_at lets the caller qualify staleness.",
    {
      view: viewSchema,
      show_id: z.number().int().describe("TVMaze show ID."),
    },
    async ({ view, show_id }) => {
      const resolved = await resolveView(auth.userId, view);
      const show = await storage.getShow(show_id);
      if (!show) {
        return err(`show not found: ${show_id}`);
      }
      const library = await storage.getUserShows(auth.userId);
      const memberships = library.filter((us) =>
        us.showId === show_id &&
        !us.isRemoved &&
        (resolved.view === "personal" ? us.groupId == null : resolved.groupIds.includes(us.groupId ?? ""))
      );
      if (memberships.length === 0) {
        return err(`show ${show_id} is not in the ${view} library`);
      }
      // Statuses: personal view reads the user's own records; family view
      // unions the shared records of each group carrying the show.
      const statusByEpisode = new Map<number, Array<{ group_id: string | null; status: string; watched_at: string | null }>>();
      const groups = resolved.view === "personal" ? [null] : memberships.map((m) => m.groupId);
      for (const groupId of new Set(groups)) {
        const records = await storage.getUserEpisodesForShow(auth.userId, show_id, groupId ?? undefined);
        for (const r of records) {
          const list = statusByEpisode.get(r.episodeId) ?? [];
          list.push({ group_id: groupId, status: r.status, watched_at: r.watchedAt?.toISOString() ?? null });
          statusByEpisode.set(r.episodeId, list);
        }
      }
      const episodes = await storage.getEpisodes(show_id);
      return ok({
        view,
        show: { ...trimShow(show), tvmaze_updated_at: show.updated ?? null },
        episodes: episodes.map((ep) => ({ ...trimEpisode(ep), statuses: statusByEpisode.get(ep.id) ?? [] })),
      });
    }
  );

  tools.registerReadTool(
    "queue_next_up",
    "The next unwatched episode per followed show, ordered by airdate — 'what's next in the queue', computed server-side. " +
      "Removed shows are excluded; shows with no unwatched aired episodes do not appear.",
    {
      view: viewSchema,
      limit: z.number().int().min(1).max(50).optional().describe("Max shows. Default 20."),
    },
    async ({ view, limit }) => {
      const resolved = await resolveView(auth.userId, view);
      const records = await storage.getUserEpisodes(auth.userId, undefined, resolved.showMode, resolved.groupIds);
      const nextByShow = new Map<number, (typeof records)[number]>();
      for (const r of records) {
        if (!ACTIONABLE.has(r.status)) continue;
        const cur = nextByShow.get(r.episode.show.id);
        if (!cur || (r.episode.airdate ?? "") < (cur.episode.airdate ?? "")) {
          nextByShow.set(r.episode.show.id, r);
        }
      }
      const queue = [...nextByShow.values()]
        .sort((a, b) => (a.episode.airdate ?? "").localeCompare(b.episode.airdate ?? ""))
        .slice(0, limit ?? 20)
        .map((r) => ({
          show: trimShow(r.episode.show),
          episode: trimEpisode(r.episode),
          status: r.status,
          group_id: r.groupId ?? null,
        }));
      return ok({
        view,
        queue,
        ...(resolved.view === "family" && resolved.groupIds.length === 0
          ? { note: "family view requested but the user is not a member of any group" }
          : {}),
      });
    }
  );
}
