import cron from "node-cron";
import { db } from "./db";
import { users } from "@shared/schema";
import { DatabaseStorage } from "./storage";
import { insertEpisodeSchema, insertUserEpisodeSchema } from "@shared/schema";

async function syncEpisodesForAllUsers() {
  console.log(`[SCHEDULER] Starting daily episode sync at ${new Date().toISOString()}`);
  
  const storage = new DatabaseStorage();
  let totalImported = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  
  try {
    const allUsers = await db.select().from(users);
    console.log(`[SCHEDULER] Found ${allUsers.length} users to sync`);

    for (const user of allUsers) {
      try {
        console.log(`[SCHEDULER] Syncing episodes for user: ${user.id}`);
        
        const allUserShows = await storage.getUserShows(user.id);
        if (allUserShows.length === 0) {
          console.log(`[SCHEDULER] No followed shows found for user ${user.id}`);
          continue;
        }

        const activeShows = allUserShows.filter(userShow => userShow.show.status !== "Ended");
        
        if (activeShows.length === 0) {
          console.log(`[SCHEDULER] No active shows to sync for user ${user.id}. All shows have ended.`);
          continue;
        }

        console.log(`[SCHEDULER] Syncing ${activeShows.length} active shows for user ${user.id}`);
        let userImportedCount = 0;
        let userSkippedCount = 0;

        for (const userShow of activeShows) {
          try {
            console.log(`[SCHEDULER] Fetching episodes for: ${userShow.show.name} (ID: ${userShow.showId})`);
            
            const response = await fetch(`https://api.tvmaze.com/shows/${userShow.showId}/episodes`);
            
            if (!response.ok) {
              console.error(`[SCHEDULER] Failed to fetch episodes for show ${userShow.showId}: ${response.status}`);
              totalErrors++;
              continue;
            }

            const episodes = await response.json();
            console.log(`[SCHEDULER] Found ${episodes.length} episodes for ${userShow.show.name}`);

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

                // For shared shows (with groupId), create episodes with groupId
                // For personal shows, create episodes with userId
                const userEpisodeData = insertUserEpisodeSchema.parse({
                  userId: userShow.groupId ? null : user.id,
                  groupId: userShow.groupId || null,
                  episodeId: episode.id,
                  status: "untriaged",
                  addedAt: new Date()
                });

                const { isNew } = await storage.addUserEpisode(userEpisodeData);
                if (isNew) {
                  userImportedCount++;
                } else {
                  userSkippedCount++;
                }
                
              } catch (error) {
                console.error(`[SCHEDULER] Error importing episode ${episode.id} for ${userShow.show.name}:`, error);
                totalErrors++;
              }
            }
            
          } catch (error) {
            console.error(`[SCHEDULER] Error processing show ${userShow.show.name}:`, error);
            totalErrors++;
          }
        }

        console.log(`[SCHEDULER] Completed sync for user ${user.id}: ${userImportedCount} imported, ${userSkippedCount} skipped`);
        totalImported += userImportedCount;
        totalSkipped += userSkippedCount;
        
      } catch (error) {
        console.error(`[SCHEDULER] Error syncing episodes for user ${user.id}:`, error);
        totalErrors++;
      }
    }

    console.log(`[SCHEDULER] ===== Daily Sync Complete =====`);
    console.log(`[SCHEDULER] Users synced: ${allUsers.length}`);
    console.log(`[SCHEDULER] Episodes imported: ${totalImported}`);
    console.log(`[SCHEDULER] Episodes skipped: ${totalSkipped}`);
    console.log(`[SCHEDULER] Errors: ${totalErrors}`);

  } catch (error) {
    console.error(`[SCHEDULER] Fatal error during daily sync:`, error);
  }

  console.log(`[SCHEDULER] Daily episode sync completed at ${new Date().toISOString()}`);
}

export function startEpisodeScheduler() {
  cron.schedule('0 3 * * *', async () => {
    await syncEpisodesForAllUsers();
  }, {
    timezone: "America/New_York"
  });

  console.log(`[SCHEDULER] Episode sync scheduler initialized - will run daily at 3:00 AM Eastern Time`);
}
