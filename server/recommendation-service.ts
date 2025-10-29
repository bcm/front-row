import { storage } from "./storage";
import { searchTMDBShow, aggregateRecommendations, convertTMDBResultToRecommendation } from "./tmdb-service";
import type { InsertRecommendation } from "@shared/schema";

export async function refreshRecommendationsForUser(userId: string): Promise<{ imported: number; errors: number }> {
  console.log(`[RECOMMENDATIONS] Starting refresh for user ${userId}`);
  
  try {
    const userShows = await storage.getUserShows(userId, false);
    
    if (userShows.length === 0) {
      console.log(`[RECOMMENDATIONS] User ${userId} has no shows, skipping`);
      return { imported: 0, errors: 0 };
    }

    // Identify engaged shows (shows with watched or next episodes)
    const userEpisodes = await storage.getUserEpisodes(userId);
    const engagedShowIds = new Set<number>();
    
    for (const userEpisode of userEpisodes) {
      if (userEpisode.status === "watched" || userEpisode.status === "next") {
        engagedShowIds.add(userEpisode.episode.showId);
      }
    }
    
    console.log(`[RECOMMENDATIONS] Found ${engagedShowIds.size} engaged shows out of ${userShows.length} total shows`);

    const tmdbIds: number[] = [];
    const engagedTmdbIds: number[] = [];
    const userGenres = new Set<string>();
    let mapErrors = 0;

    for (const userShow of userShows) {
      if (userShow.show.genres) {
        userShow.show.genres.forEach(g => userGenres.add(g));
      }

      let tmdbId = userShow.show.tmdbId;
      
      if (!tmdbId) {
        tmdbId = await searchTMDBShow(userShow.show.name);
        
        if (tmdbId) {
          await storage.updateShowTmdbId(userShow.show.id, tmdbId);
          console.log(`[RECOMMENDATIONS] Mapped "${userShow.show.name}" to TMDB ID ${tmdbId}`);
        } else {
          console.log(`[RECOMMENDATIONS] Could not find TMDB ID for "${userShow.show.name}"`);
          mapErrors++;
          continue;
        }
      }
      
      tmdbIds.push(tmdbId);
      
      // Track if this show is engaged
      if (engagedShowIds.has(userShow.show.id)) {
        engagedTmdbIds.push(tmdbId);
      }
    }

    if (tmdbIds.length === 0) {
      console.log(`[RECOMMENDATIONS] No TMDB IDs found for user ${userId}`);
      return { imported: 0, errors: mapErrors };
    }

    console.log(`[RECOMMENDATIONS] Aggregating recommendations from ${tmdbIds.length} shows (${engagedTmdbIds.length} engaged)`);
    const aggregated = await aggregateRecommendations(tmdbIds, Array.from(userGenres), engagedTmdbIds);
    
    const dismissed = await storage.getDismissedRecommendations(userId);
    const dismissedIds = new Set(dismissed.map(d => d.tmdbId));
    
    const existingShowIds = new Set(userShows.map(us => us.show.tmdbId).filter(Boolean));
    
    const recommendationsToInsert: InsertRecommendation[] = [];
    
    for (const [tmdbId, data] of Array.from(aggregated.entries())) {
      if (dismissedIds.has(tmdbId)) continue;
      if (existingShowIds.has(tmdbId)) continue;
      
      const rec = await convertTMDBResultToRecommendation(
        userId,
        tmdbId,
        data.show,
        data.score,
        data.sources
      );
      
      recommendationsToInsert.push(rec);
    }

    await storage.createRecommendations(recommendationsToInsert);
    
    console.log(`[RECOMMENDATIONS] Imported ${recommendationsToInsert.length} recommendations for user ${userId}`);
    
    return { imported: recommendationsToInsert.length, errors: mapErrors };
  } catch (error) {
    console.error(`[RECOMMENDATIONS] Error refreshing recommendations for user ${userId}:`, error);
    return { imported: 0, errors: 1 };
  }
}

