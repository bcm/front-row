import { storage } from "./storage";
import { searchTMDBShow, aggregateRecommendations, convertTMDBResultToRecommendation, getMinRecommendationScore } from "./tmdb-service";
import type { InsertRecommendation } from "@shared/schema";

export async function refreshRecommendationsForUser(userId: string): Promise<{ imported: number; errors: number }> {
  console.log(`[RECOMMENDATIONS] Starting refresh for user ${userId}`);
  
  try {
    const userShows = await storage.getUserShows(userId, false);
    
    if (userShows.length === 0) {
      console.log(`[RECOMMENDATIONS] User ${userId} has no shows, skipping`);
      return { imported: 0, errors: 0 };
    }

    // Identify engaged shows by type
    const userEpisodes = await storage.getUserEpisodes(userId);
    const highlyEngagedShowIds = new Set<number>(); // Shows with watched episodes
    const moderatelyEngagedShowIds = new Set<number>(); // Shows with next episodes
    
    for (const userEpisode of userEpisodes) {
      if (userEpisode.status === "watched") {
        highlyEngagedShowIds.add(userEpisode.episode.showId);
      } else if (userEpisode.status === "next") {
        moderatelyEngagedShowIds.add(userEpisode.episode.showId);
      }
    }
    
    console.log(`[RECOMMENDATIONS] Found ${highlyEngagedShowIds.size} highly engaged shows (watched) and ${moderatelyEngagedShowIds.size} moderately engaged shows (next) out of ${userShows.length} total shows`);

    const tmdbIds: number[] = [];
    const highlyEngagedTmdbIds: number[] = [];
    const moderatelyEngagedTmdbIds: number[] = [];
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
      
      // Track engagement level for this show
      if (highlyEngagedShowIds.has(userShow.show.id)) {
        highlyEngagedTmdbIds.push(tmdbId);
      } else if (moderatelyEngagedShowIds.has(userShow.show.id)) {
        moderatelyEngagedTmdbIds.push(tmdbId);
      }
    }

    if (tmdbIds.length === 0) {
      console.log(`[RECOMMENDATIONS] No TMDB IDs found for user ${userId}`);
      return { imported: 0, errors: mapErrors };
    }

    console.log(`[RECOMMENDATIONS] Aggregating recommendations from ${tmdbIds.length} shows (${highlyEngagedTmdbIds.length} highly engaged, ${moderatelyEngagedTmdbIds.length} moderately engaged)`);
    const aggregated = await aggregateRecommendations(tmdbIds, Array.from(userGenres), highlyEngagedTmdbIds, moderatelyEngagedTmdbIds);
    
    // Clear old recommendations before adding new ones
    await storage.clearRecommendations(userId);
    console.log(`[RECOMMENDATIONS] Cleared old recommendations for user ${userId}`);
    
    const dismissed = await storage.getDismissedRecommendations(userId);
    const dismissedIds = new Set(dismissed.map(d => d.tmdbId));
    
    const existingShowIds = new Set(userShows.map(us => us.show.tmdbId).filter(Boolean));
    
    const recommendationsToInsert: InsertRecommendation[] = [];
    
    const minScore = getMinRecommendationScore();
    
    for (const [tmdbId, data] of Array.from(aggregated.entries())) {
      if (dismissedIds.has(tmdbId)) continue;
      if (existingShowIds.has(tmdbId)) continue;
      if (data.score < minScore) continue; // Filter by minimum score threshold
      
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

