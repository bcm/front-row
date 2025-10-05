import { pool, db } from "../server/db.js";
import { DatabaseStorage } from "../server/storage.js";
import { users, insertEpisodeSchema, insertUserEpisodeSchema } from "../shared/schema.js";

interface SyncResult {
  userId: string;
  importedCount: number;
  skippedCount: number;
  errors: string[];
}

async function syncEpisodesForUser(userId: string, storage: DatabaseStorage): Promise<SyncResult> {
  const result: SyncResult = {
    userId,
    importedCount: 0,
    skippedCount: 0,
    errors: []
  };

  try {
    console.log(`[SYNC] Starting episode sync for user: ${userId}`);
    
    const allUserShows = await storage.getUserShows(userId);
    if (allUserShows.length === 0) {
      console.log(`[SYNC] No followed shows found for user ${userId}`);
      return result;
    }

    // Filter out finished shows (status "Ended")
    const activeShows = allUserShows.filter(userShow => userShow.show.status !== "Ended");
    
    if (activeShows.length === 0) {
      console.log(`[SYNC] No active shows to sync for user ${userId}. All shows have ended.`);
      return result;
    }

    console.log(`[SYNC] Syncing ${activeShows.length} active shows for user ${userId}`);

    for (const userShow of activeShows) {
      try {
        console.log(`[SYNC] Fetching episodes for: ${userShow.show.name} (ID: ${userShow.showId})`);
        
        const response = await fetch(`https://api.tvmaze.com/shows/${userShow.showId}/episodes`);
        
        if (!response.ok) {
          const error = `Failed to fetch episodes for show ${userShow.showId}: ${response.status}`;
          console.error(`[SYNC] ${error}`);
          result.errors.push(error);
          continue;
        }

        const episodes = await response.json();
        console.log(`[SYNC] Found ${episodes.length} episodes for ${userShow.show.name}`);

        let showImportedCount = 0;
        let showSkippedCount = 0;

        for (const episode of episodes) {
          try {
            const episodeToStore = insertEpisodeSchema.parse({
              id: episode.id,
              showId: userShow.showId,
              season: episode.season,
              number: episode.number,
              name: episode.name,
              summary: episode.summary,
              airdate: episode.airdate,
              runtime: episode.runtime,
              image: episode.image
            });
            
            await storage.createEpisode(episodeToStore);

            const userEpisodeData = insertUserEpisodeSchema.parse({
              userId,
              episodeId: episode.id,
              status: "untriaged",
              addedAt: new Date()
            });

            const { isNew } = await storage.addUserEpisode(userEpisodeData);
            if (isNew) {
              result.importedCount++;
              showImportedCount++;
            } else {
              result.skippedCount++;
              showSkippedCount++;
            }
            
          } catch (error) {
            const errorMsg = `Error importing episode ${episode.id} for ${userShow.show.name}: ${error}`;
            console.error(`[SYNC] ${errorMsg}`);
            result.errors.push(errorMsg);
          }
        }

        console.log(`[SYNC] Completed ${userShow.show.name}: ${showImportedCount} new, ${showSkippedCount} existing`);
        
      } catch (error) {
        const errorMsg = `Error processing show ${userShow.show.name}: ${error}`;
        console.error(`[SYNC] ${errorMsg}`);
        result.errors.push(errorMsg);
      }
    }

    console.log(`[SYNC] Completed sync for user ${userId}: ${result.importedCount} imported, ${result.skippedCount} skipped`);
    
  } catch (error) {
    const errorMsg = `Error syncing episodes for user ${userId}: ${error}`;
    console.error(`[SYNC] ${errorMsg}`);
    result.errors.push(errorMsg);
  }

  return result;
}

async function main() {
  console.log(`[SYNC] Starting daily episode sync at ${new Date().toISOString()}`);
  
  const storage = new DatabaseStorage();
  const allResults: SyncResult[] = [];
  
  try {
    // Get all users
    const allUsers = await db.select().from(users);
    console.log(`[SYNC] Found ${allUsers.length} users to sync`);

    for (const user of allUsers) {
      const result = await syncEpisodesForUser(user.id, storage);
      allResults.push(result);
    }

    // Print summary
    const totalImported = allResults.reduce((sum, r) => sum + r.importedCount, 0);
    const totalSkipped = allResults.reduce((sum, r) => sum + r.skippedCount, 0);
    const totalErrors = allResults.reduce((sum, r) => sum + r.errors.length, 0);

    console.log(`[SYNC] ===== Daily Sync Complete =====`);
    console.log(`[SYNC] Users synced: ${allUsers.length}`);
    console.log(`[SYNC] Episodes imported: ${totalImported}`);
    console.log(`[SYNC] Episodes skipped: ${totalSkipped}`);
    console.log(`[SYNC] Errors: ${totalErrors}`);
    
    if (totalErrors > 0) {
      console.log(`[SYNC] Error details:`);
      allResults.forEach(r => {
        if (r.errors.length > 0) {
          console.log(`[SYNC] User ${r.userId}:`);
          r.errors.forEach(err => console.log(`[SYNC]   - ${err}`));
        }
      });
    }

  } catch (error) {
    console.error(`[SYNC] Fatal error during daily sync:`, error);
    process.exit(1);
  } finally {
    // Close database connection
    await pool.end();
    console.log(`[SYNC] Database connection closed`);
  }

  console.log(`[SYNC] Daily episode sync completed successfully at ${new Date().toISOString()}`);
  process.exit(0);
}

main();
