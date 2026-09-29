// Discovery read tools: new releases and recommendations.
//
// releases_new and recommendations_list are view-independent in the data
// model (global releases, per-user recommendations); they still take the
// explicit view parameter so the interface stays uniform and deliberate.

import type { ToolRegistrar } from "../register";
import { z } from "zod";
import { storage } from "../../storage";
import { getNewReleases } from "../../new-releases-service";
import type { McpAuthContext } from "../../oauth/middleware";
import { viewSchema } from "../view";
import { ok } from "../format";

export function registerDiscoveryTools(tools: ToolRegistrar, auth: McpAuthContext): void {
  tools.registerReadTool(
    "releases_new",
    "Newly announced shows worth flagging for bookmarking, with the user's dismissals applied. " +
      "View-independent: releases are global, dismissals are per-user.",
    { view: viewSchema },
    async ({ view }) => {
      const { shows, lastChecked, fromCache } = await getNewReleases(auth.userId);
      return ok({
        view,
        releases: shows,
        last_checked: lastChecked?.toISOString() ?? null,
        from_cache: fromCache,
      });
    }
  );

  tools.registerReadTool(
    "recommendations_list",
    "The user's computed show recommendations, ranked by score. View-independent (per-user).",
    {
      view: viewSchema,
      limit: z.number().int().min(1).max(50).optional().describe("Max recommendations. Default 20."),
    },
    async ({ view, limit }) => {
      const recs = await storage.getRecommendations(auth.userId, limit ?? 20);
      return ok({
        view,
        recommendations: recs.map((r) => ({
          tmdb_id: r.tmdbId,
          name: r.name,
          overview: r.overview,
          poster_path: r.posterPath,
          vote_average: r.voteAverage,
          network: r.network,
          genres: r.genres,
          first_air_date: r.firstAirDate,
          score: r.score,
        })),
      });
    }
  );

}
