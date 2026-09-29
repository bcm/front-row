// catalog_search: TVMaze show search proxy (same upstream as GET /api/shows/search).
//
// Per-token rate limited (design §11.6): 60 requests/hour per OAuth client+user,
// enforced in Postgres so it holds across autoscale replicas.

import type { ToolRegistrar } from "../register";
import { z } from "zod";
import { storage } from "../../storage";
import type { McpAuthContext } from "../../oauth/middleware";
import { viewSchema, resolveView } from "../view";
import { ok, err } from "../format";
import { checkRateLimit, rateLimitKey } from "../rate-limit";

interface TvmazeSearchHit {
  score: number;
  show: {
    id: number;
    name: string;
    status?: string;
    premiered?: string;
    genres?: string[];
    network?: { name?: string };
    webChannel?: { name?: string };
    rating?: { average?: number };
    summary?: string;
  };
}

export function registerCatalogTools(tools: ToolRegistrar, auth: McpAuthContext): void {
  tools.registerReadTool(
    "catalog_search",
    "Search the TVMaze catalog for shows to consider adding. Rate limited to 60 requests/hour per client. " +
      "View-independent (the catalog is global); view is accepted for interface consistency and drives the in_library flag.",
    {
      view: viewSchema,
      query: z.string().min(1).describe("Show title to search for."),
      limit: z.number().int().min(1).max(10).optional().describe("Max results. Default 5."),
    },
    async ({ view, query, limit }) => {
      const decision = await checkRateLimit(rateLimitKey("catalog", auth.clientId, auth.userId));
      if (!decision.allowed) {
        return err(`catalog_search rate limit exceeded; retry in ${decision.retryAfterSec}s`);
      }
      const resolved = await resolveView(auth.userId, view);
      const [response, libraryIds] = await Promise.all([
        fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(query)}`),
        // Personal membership only: groupId == null, same as library_list.
        // getUserShowIds alone would also match shows this user added to a group.
        storage.getUserShows(auth.userId).then((rows) =>
          rows
            .filter((us) =>
              !us.isRemoved &&
              (resolved.view === "personal" ? us.groupId == null : resolved.groupIds.includes(us.groupId ?? ""))
            )
            .map((us) => us.showId)
        ),
      ]);
      if (!response.ok) {
        return err(`TVMaze catalog search failed (HTTP ${response.status})`);
      }
      const hits = (await response.json()) as TvmazeSearchHit[];
      const inLibrary = new Set(libraryIds);
      return ok({
        view,
        results: hits.slice(0, limit ?? 5).map(({ score, show }) => ({
          score,
          tvmaze_id: show.id,
          name: show.name,
          status: show.status ?? null,
          premiered: show.premiered ?? null,
          network: show.network?.name ?? show.webChannel?.name ?? null,
          genres: show.genres ?? [],
          rating: show.rating?.average ?? null,
          in_library: inLibrary.has(show.id),
        })),
      });
    }
  );
}
