import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertShowSchema, insertUserShowSchema, insertEpisodeSchema, insertUserEpisodeSchema } from "@shared/schema";
import { z } from "zod";
import { syncJobManager } from "./sync-job-manager";
import { isAuthenticated } from "./replit_integrations/auth";

function getUserId(req: Request): string {
  const user = req.user as any;
  return user?.claims?.sub || "demo-user";
}

// Async sync function for adding shows with progress reporting
async function performAsyncAddShowSync(jobId: string, showId: number, userId: string, groupId?: string | null): Promise<void> {
  const reporter = syncJobManager.createReporter(jobId);
  
  try {
    console.log(`[ADD_SHOW_SYNC] Starting async sync for show ${showId}, job ${jobId}, groupId: ${groupId || 'personal'}`);
    syncJobManager.markJobRunning(jobId);
    
    // Phase 1: Fetch scrobble data
    reporter.setPhase('fetch-scrobbles', 'Fetching your watch history from TVMaze...');
    let scrobbleData = [];
    const apiKey = process.env.TVMAZE_API_KEY;
    const username = process.env.TVMAZE_USERNAME;
    
    if (apiKey && username) {
      try {
        console.log(`[ADD_SHOW_SYNC] Fetching scrobble data for show ${showId}`);
        const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');
        const scrobbleResponse = await fetch(`https://api.tvmaze.com/v1/scrobble/shows/${showId}`, {
          headers: {
            'Accept': 'application/json',
            'Authorization': `Basic ${credentials}`
          }
        });

        if (scrobbleResponse.ok) {
          scrobbleData = await scrobbleResponse.json();
          console.log(`[ADD_SHOW_SYNC] Found ${scrobbleData.length} scrobble entries for show ${showId}`);
          
          // Log sample scrobble entries for debugging
          if (scrobbleData.length > 0) {
            console.log(`[ADD_SHOW_SYNC] Sample scrobble entries:`, JSON.stringify(scrobbleData.slice(0, 3), null, 2));
          }
        } else if (scrobbleResponse.status !== 404) {
          console.error(`[ADD_SHOW_SYNC] Error fetching scrobbles for show ${showId}: ${scrobbleResponse.status}`);
          reporter.addError(`Error fetching scrobbles: ${scrobbleResponse.status}`);
        }
      } catch (scrobbleError) {
        console.error(`[ADD_SHOW_SYNC] Error fetching scrobble data:`, scrobbleError);
        reporter.addError(`Error fetching scrobble data: ${scrobbleError}`);
      }
    } else {
      console.log(`[ADD_SHOW_SYNC] No TVMaze credentials available, proceeding without scrobble data`);
    }

    // Phase 2: Fetch episodes
    reporter.setPhase('fetch-episodes', 'Fetching episode list...');
    const episodeResponse = await fetch(`https://api.tvmaze.com/shows/${showId}/episodes`);
    
    if (!episodeResponse.ok) {
      throw new Error(`TVMaze API error: ${episodeResponse.status}`);
    }

    const episodes = await episodeResponse.json();
    console.log(`[ADD_SHOW_SYNC] Found ${episodes.length} episodes for show ${showId}`);
    
    // Phase 3: Process episodes
    reporter.setPhase('process-episodes', 'Processing episodes...');
    reporter.setTotal(episodes.length);
    
    let episodesImported = 0;
    let episodesUpdated = 0;
    
    for (const episode of episodes) {
      // Check for cancellation
      if (reporter.checkCanceled()) {
        console.log(`[ADD_SHOW_SYNC] Job ${jobId} was cancelled`);
        return;
      }

      try {
        // Create episode
        const episodeToStore = insertEpisodeSchema.parse({
          id: episode.id,
          showId: showId,
          season: episode.season,
          number: episode.number,
          name: episode.name,
          summary: episode.summary,
          airdate: episode.airdate,
          runtime: episode.runtime,
          image: episode.image
        });
        
        await storage.createEpisode(episodeToStore);

        // Check if there's scrobble data for this episode
        const episodeScrobble = scrobbleData.find((scrobble: any) => 
          scrobble.episode_id === episode.id
        );

        let initialStatus = "untriaged";
        let watchedAt = null;

        // If scrobble data exists, set status accordingly
        if (episodeScrobble) {
          console.log(`[ADD_SHOW_SYNC] Processing episode ${episode.id}: type=${episodeScrobble.type}, marked_at=${episodeScrobble.marked_at}`);
          
          // Mark type 0 = watched, Mark type 2 = skipped
          if (episodeScrobble.type === 0) {
            initialStatus = "watched";
            // Use current time if marked_at is 0 (bulk operation)
            // TVMaze timestamps are in seconds, need to multiply by 1000 for JS Date
            watchedAt = episodeScrobble.marked_at && episodeScrobble.marked_at > 0 
              ? new Date(episodeScrobble.marked_at * 1000) 
              : new Date();
            console.log(`[ADD_SHOW_SYNC] Setting episode ${episode.id} as watched`);
            episodesUpdated++;
          } else if (episodeScrobble.type === 2) {
            initialStatus = "skipped";
            console.log(`[ADD_SHOW_SYNC] Setting episode ${episode.id} as skipped`);
            episodesUpdated++;
          }
        }

        // Add user episode with determined status
        // For shared shows, use groupId; for personal shows, use userId
        const userEpisodeData = insertUserEpisodeSchema.parse({
          userId: groupId ? null : userId,
          groupId: groupId || null,
          episodeId: episode.id,
          status: initialStatus
        });
        
        const { episode: userEpisode } = await storage.addUserEpisode(userEpisodeData);
        
        // Update timestamps if needed
        if (initialStatus !== "untriaged" && (watchedAt || initialStatus === "watched" || initialStatus === "skipped")) {
          await storage.updateUserEpisode(userId, episode.id, {
            triagedAt: new Date(),
            ...(watchedAt && { watchedAt })
          }, groupId);
        }
        episodesImported++;
        
        // Update progress
        reporter.incrementCompleted();
        
      } catch (episodeError) {
        console.error(`[ADD_SHOW_SYNC] Error creating episode ${episode.id}:`, episodeError);
        reporter.addError(`Failed to import episode ${episode.id}: ${episodeError}`);
      }
    }
    
    // Phase 4: Finalize
    reporter.setPhase('finalize', 'Finishing sync...');
    console.log(`[ADD_SHOW_SYNC] Completed: ${episodesImported} episodes imported, ${episodesUpdated} episodes updated from scrobbles`);
    
    syncJobManager.markJobSuccess(jobId, episodesImported, episodesUpdated);
    
  } catch (error) {
    console.error(`[ADD_SHOW_SYNC] Error in async add show sync:`, error);
    syncJobManager.markJobError(jobId, error instanceof Error ? error.message : 'Unknown error');
  }
}

// Async sync function with progress reporting
async function performAsyncSync(jobId: string, showId: number, userId: string): Promise<void> {
  const reporter = syncJobManager.createReporter(jobId);
  
  try {
    syncJobManager.markJobRunning(jobId);
    
    // Phase 1: Sync show details
    reporter.setPhase('fetch-show', 'Fetching show details...');
    const syncedShow = await storage.syncShowFromTVMaze(showId);
    
    if (!syncedShow) {
      throw new Error("Show not found or failed to sync");
    }

    // Phase 2: Fetch scrobble data
    reporter.setPhase('fetch-scrobbles', 'Fetching watch history from TVMaze...');
    let scrobbleData = [];
    const apiKey = process.env.TVMAZE_API_KEY;
    const username = process.env.TVMAZE_USERNAME;
    
    if (apiKey && username) {
      try {
        const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');
        const scrobbleResponse = await fetch(`https://api.tvmaze.com/v1/scrobble/shows/${showId}`, {
          headers: {
            'Accept': 'application/json',
            'Authorization': `Basic ${credentials}`
          }
        });

        if (scrobbleResponse.ok) {
          scrobbleData = await scrobbleResponse.json();
        } else if (scrobbleResponse.status !== 404) {
          reporter.addError(`Error fetching scrobbles: ${scrobbleResponse.status}`);
        }
      } catch (scrobbleError) {
        reporter.addError(`Error fetching scrobble data: ${scrobbleError}`);
      }
    }

    // Phase 3: Fetch episodes
    reporter.setPhase('fetch-episodes', 'Fetching episode list...');
    const response = await fetch(`https://api.tvmaze.com/shows/${showId}/episodes`);
    
    if (!response.ok) {
      throw new Error(`TVMaze API error: ${response.status}`);
    }

    const episodes = await response.json();
    
    // Phase 4: Process episodes
    reporter.setPhase('process-episodes', 'Processing episodes...');
    reporter.setTotal(episodes.length);
    
    let episodesImported = 0;
    let episodesUpdated = 0;
    
    for (const episode of episodes) {
      // Check for cancellation
      if (reporter.checkCanceled()) {
        return;
      }

      try {
        // Create episode
        const episodeToStore = insertEpisodeSchema.parse({
          id: episode.id,
          showId: showId,
          season: episode.season,
          number: episode.number,
          name: episode.name,
          summary: episode.summary,
          airdate: episode.airdate,
          runtime: episode.runtime,
          image: episode.image
        });
        
        await storage.createEpisode(episodeToStore);

        // Add user episode if user follows this show
        const userShow = await storage.getUserShow(userId, showId);
        if (userShow) {
          // Check if there's scrobble data for this episode
          const episodeScrobble = scrobbleData.find((scrobble: any) => 
            scrobble.episode_id === episode.id
          );

          let initialStatus = "untriaged";
          let watchedAt = null;

          // If scrobble data exists, set status accordingly
          if (episodeScrobble) {
            // Mark type 0 = watched, Mark type 2 = skipped
            if (episodeScrobble.type === 0) {
              initialStatus = "watched";
              // Use current time if marked_at is 0 (bulk operation)
              // TVMaze timestamps are in seconds, need to multiply by 1000 for JS Date
              watchedAt = episodeScrobble.marked_at && episodeScrobble.marked_at > 0 
                ? new Date(episodeScrobble.marked_at * 1000) 
                : new Date();
            } else if (episodeScrobble.type === 2) {
              initialStatus = "skipped";
            }
          }

          const userEpisodeData = insertUserEpisodeSchema.parse({
            userId,
            episodeId: episode.id,
            status: initialStatus,
            addedAt: new Date(),
            ...(watchedAt && { watchedAt })
          });

          const { episode: userEpisode } = await storage.addUserEpisode(userEpisodeData);
          
          // If episode already existed and we have scrobble data, update its status
          if (episodeScrobble && userEpisode.id) {
            const existingUserEpisode = await storage.getUserEpisode(userId, episode.id);
            if (existingUserEpisode && existingUserEpisode.status !== initialStatus) {
              const updates: any = { status: initialStatus };
              if (watchedAt) {
                updates.watchedAt = watchedAt;
              }
              await storage.updateUserEpisode(userId, episode.id, updates);
              episodesUpdated++;
            }
          }
          
          episodesImported++;
        }
        
        reporter.incrementCompleted(`Processed episode: ${episode.name || `S${episode.season}E${episode.number}`}`);
        
      } catch (episodeError) {
        reporter.addError(`Error importing episode ${episode.id}: ${episodeError}`);
      }
    }

    // Phase 5: Finalize
    reporter.setPhase('finalize', 'Finishing sync...');
    
    syncJobManager.markJobSuccess(jobId, episodesImported, episodesUpdated);
    
  } catch (error) {
    console.error("Error in async sync:", error);
    syncJobManager.markJobError(jobId, error instanceof Error ? error.message : 'Unknown error');
  }
}

// Async library import function with progress reporting
async function performAsyncLibraryImport(jobId: string, userId: string): Promise<void> {
  const reporter = syncJobManager.createReporter(jobId);
  
  try {
    console.log(`[LIBRARY_IMPORT] Starting async library import, job ${jobId}`);
    syncJobManager.markJobRunning(jobId);
    
    const apiKey = process.env.TVMAZE_API_KEY;
    const username = process.env.TVMAZE_USERNAME;
    
    if (!apiKey || !username) {
      throw new Error("TVMaze API credentials not configured");
    }

    // Phase 1: Fetch followed shows
    reporter.setPhase('fetch-show', 'Fetching your followed shows from TVMaze...');
    
    const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');
    const response = await fetch(`https://api.tvmaze.com/v1/user/follows/shows?embed=show`, {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Basic ${credentials}`
      }
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("Invalid TVMaze API credentials");
      }
      if (response.status === 404) {
        throw new Error("TVMaze User API endpoint not found. This might mean the user doesn't have a premium account or the username is incorrect.");
      }
      throw new Error(`TVMaze User API error: ${response.status}`);
    }

    const followedShows = await response.json();
    let importedCount = 0;
    let skippedCount = 0;

    // Phase 2: Process shows
    reporter.setPhase('process-episodes', 'Importing shows to your library...'); // Reusing episodes phase
    reporter.setTotal(followedShows.length);

    // Process each followed show
    for (const followedShow of followedShows) {
      const show = followedShow._embedded.show;
      
      try {
        // Check if show already exists in user's collection
        const existingUserShow = await storage.getUserShow(userId, show.id);
        if (existingUserShow) {
          skippedCount++;
          reporter.incrementCompleted(`Skipped: ${show.name} (already in library)`);
          continue;
        }

        // Prepare show data for storage
        const showToStore = insertShowSchema.parse({
          id: show.id,
          name: show.name,
          summary: show.summary,
          image: show.image,
          network: show.network,
          genres: show.genres || [],
          status: show.status,
          premiered: show.premiered,
          rating: show.rating,
          runtime: show.runtime,
          officialSite: show.officialSite,
          language: show.language,
          type: show.type,
          updated: show.updated,
        });
        
        // Store show in database
        await storage.createShow(showToStore);

        // Add to user's collection with "later" status
        const userShowData = insertUserShowSchema.parse({
          userId,
          showId: show.id,
          status: "later"
        });

        await storage.addUserShow(userShowData);
        importedCount++;
        reporter.incrementCompleted(`Imported: ${show.name}`);
        
      } catch (error) {
        console.error(`Error importing show ${show.name}:`, error);
        reporter.addError(`Error importing ${show.name}: ${error}`);
        // Continue with other shows even if one fails
      }
    }

    // Phase 3: Finalize
    reporter.setPhase('finalize', 'Import completed!');
    
    syncJobManager.markJobSuccess(jobId, importedCount, skippedCount);
    
  } catch (error) {
    console.error("Error in library import:", error);
    syncJobManager.markJobError(jobId, error instanceof Error ? error.message : 'Unknown error');
  }
}

// Async episode import function with progress reporting
async function performAsyncEpisodeImport(jobId: string, userId: string): Promise<void> {
  const reporter = syncJobManager.createReporter(jobId);
  
  try {
    console.log(`[EPISODE_IMPORT] Starting async episode import, job ${jobId}`);
    syncJobManager.markJobRunning(jobId);
    
    // Phase 1: Fetch user shows
    reporter.setPhase('fetch-episodes', 'Fetching your shows...');
    
    const allUserShows = await storage.getUserShows(userId);
    if (allUserShows.length === 0) {
      throw new Error("No followed shows found. Import shows first.");
    }

    // Filter out finished shows (status "Ended")
    const userShows = allUserShows.filter(userShow => userShow.show.status !== "Ended");
    
    if (userShows.length === 0) {
      throw new Error("No active shows to sync. All your shows have ended.");
    }

    let importedCount = 0;
    let skippedCount = 0;
    let totalShows = userShows.length;
    let processedShows = 0;

    // Start processing shows immediately (no upfront counting needed)
    reporter.setPhase('process-episodes', 'Processing and updating episode information...');
    reporter.setTotal(totalShows);

    for (const userShow of userShows) {
      // Check if job has been canceled
      if (reporter.checkCanceled()) {
        console.log(`[EPISODE_IMPORT] Job ${jobId} was canceled`);
        break;
      }

      try {
        console.log(`Importing episodes for show: ${userShow.show.name} (ID: ${userShow.showId})`);
        
        const response = await fetch(`https://api.tvmaze.com/shows/${userShow.showId}/episodes`);
        
        if (!response.ok) {
          console.error(`Failed to fetch episodes for show ${userShow.showId}: ${response.status}`);
          processedShows++;
          reporter.incrementCompleted(`Processed: ${userShow.show.name} (${processedShows}/${totalShows}) - Failed to fetch episodes`);
          continue;
        }

        const episodes = await response.json();
        console.log(`Found ${episodes.length} episodes for ${userShow.show.name}`);

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

            // For shared shows (with groupId), create episodes with groupId
            // For personal shows, create episodes with userId
            const userEpisodeData = insertUserEpisodeSchema.parse({
              userId: userShow.groupId ? null : userId,
              groupId: userShow.groupId || null,
              episodeId: episode.id,
              status: "untriaged",
              addedAt: new Date()
            });

            const result = await storage.addUserEpisode(userEpisodeData);
            if (result.isNew) {
              importedCount++;
              showImportedCount++;
            } else {
              skippedCount++;
              showSkippedCount++;
            }
            
          } catch (error) {
            console.error(`Error importing episode ${episode.id}:`, error);
            reporter.addError(`Error importing ${userShow.show.name} S${episode.season}E${episode.number}: ${error}`);
          }
        }

        // Count show as processed after successful processing
        processedShows++;
        reporter.incrementCompleted(`Processed: ${userShow.show.name} (${processedShows}/${totalShows}) - ${showImportedCount} new, ${showSkippedCount} existing`);
        
      } catch (error) {
        processedShows++;
        console.error(`Error importing episodes for show ${userShow.showId}:`, error);
        reporter.addError(`Error importing episodes for ${userShow.show.name}: ${error}`);
        reporter.incrementCompleted(`Processed: ${userShow.show.name} (${processedShows}/${totalShows}) - Error occurred`);
      }
    }

    // Phase 4: Finalize
    if (reporter.checkCanceled()) {
      reporter.setPhase('finalize', 'Episode sync canceled');
      syncJobManager.markJobError(jobId, 'Sync was canceled by user');
    } else {
      reporter.setPhase('finalize', 'Episode import completed!');
      syncJobManager.markJobSuccess(jobId, importedCount, skippedCount);
    }
    
  } catch (error) {
    console.error("Error in episode import:", error);
    syncJobManager.markJobError(jobId, error instanceof Error ? error.message : 'Unknown error');
  }
}

export async function registerRoutes(app: Express): Promise<Server> {
  // TVMaze API proxy routes
  app.get("/api/shows/search", async (req, res) => {
    try {
      const { q } = req.query;
      if (!q) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
      }

      const response = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q as string)}`);
      if (!response.ok) {
        throw new Error(`TVMaze API error: ${response.status}`);
      }

      const data = await response.json();
      res.json(data);
    } catch (error) {
      console.error("Error searching shows:", error);
      res.status(500).json({ error: "Failed to search shows" });
    }
  });

  app.get("/api/shows/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const showId = parseInt(id);
      
      // Try to get from database first
      let show = await storage.getShow(showId);
      
      // If not in database or missing extended info, sync from TVMaze
      if (!show || !show.webChannel) {
        const syncedShow = await storage.syncShowFromTVMaze(showId);
        if (syncedShow) {
          show = syncedShow;
        }
      }
      
      // If still no show, try direct TVMaze API as fallback
      if (!show) {
        const response = await fetch(`https://api.tvmaze.com/shows/${id}`);
        
        if (!response.ok) {
          if (response.status === 404) {
            return res.status(404).json({ error: "Show not found" });
          }
          throw new Error(`TVMaze API error: ${response.status}`);
        }

        show = await response.json();
      }

      res.json(show);
    } catch (error) {
      console.error("Error fetching show:", error);
      res.status(500).json({ error: "Failed to fetch show" });
    }
  });

  // Endpoint to manually sync show data from TVMaze
  app.post("/api/shows/:id/sync", async (req, res) => {
    try {
      const { id } = req.params;
      const showId = parseInt(id);
      const userId = getUserId(req);
      const apiKey = process.env.TVMAZE_API_KEY;
      const username = process.env.TVMAZE_USERNAME;
      
      // Sync show details first
      const syncedShow = await storage.syncShowFromTVMaze(showId);
      
      if (!syncedShow) {
        return res.status(404).json({ error: "Show not found or failed to sync" });
      }

      // Fetch user's marked state from scrobble API if credentials are available
      let scrobbleData = [];
      if (apiKey && username) {
        try {
          const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');
          const scrobbleResponse = await fetch(`https://api.tvmaze.com/v1/scrobble/shows/${showId}`, {
            headers: {
              'Accept': 'application/json',
              'Authorization': `Basic ${credentials}`
            }
          });

          if (scrobbleResponse.ok) {
            scrobbleData = await scrobbleResponse.json();
            console.log(`Found ${scrobbleData.length} scrobble entries for show ${showId}`);
            
            // Debug: Log first few scrobble entries to see structure
            console.log("Sample scrobble entries:", JSON.stringify(scrobbleData.slice(0, 3), null, 2));
            
            // Debug: Count by type
            const typeCounts = scrobbleData.reduce((acc: any, entry: any) => {
              acc[entry.type] = (acc[entry.type] || 0) + 1;
              return acc;
            }, {});
            console.log(`Scrobble type breakdown:`, typeCounts);
            
            // Debug: Count entries with marked_at = 0
            const zeroMarkedAt = scrobbleData.filter((entry: any) => entry.marked_at === 0).length;
            console.log(`Episodes with marked_at = 0: ${zeroMarkedAt}`);
            
          } else if (scrobbleResponse.status !== 404) {
            console.error(`Error fetching scrobbles for show ${showId}: ${scrobbleResponse.status}`);
          }
        } catch (scrobbleError) {
          console.error("Error fetching scrobble data:", scrobbleError);
        }
      }

      // Sync episodes for this show
      let episodesImported = 0;
      let episodesUpdated = 0;
      try {
        const response = await fetch(`https://api.tvmaze.com/shows/${showId}/episodes`);
        
        if (response.ok) {
          const episodes = await response.json();
          
          for (const episode of episodes) {
            try {
              // Create episode
              const episodeToStore = insertEpisodeSchema.parse({
                id: episode.id,
                showId: showId,
                season: episode.season,
                number: episode.number,
                name: episode.name,
                summary: episode.summary,
                airdate: episode.airdate,
                runtime: episode.runtime,
                image: episode.image
              });
              
              await storage.createEpisode(episodeToStore);

              // Add user episode if user follows this show
              const userShow = await storage.getUserShow(userId, showId);
              if (userShow) {
                // Check if there's scrobble data for this episode
                const episodeScrobble = scrobbleData.find((scrobble: any) => 
                  scrobble.episode_id === episode.id
                );

                let initialStatus = "untriaged";
                let watchedAt = null;

                // If scrobble data exists, set status accordingly
                if (episodeScrobble) {
                  console.log(`Processing episode ${episode.id}: type=${episodeScrobble.type}, marked_at=${episodeScrobble.marked_at}`);
                  
                  // Mark type 0 = watched, Mark type 2 = skipped
                  if (episodeScrobble.type === 0) {
                    initialStatus = "watched";
                    // Use current time if marked_at is 0 (bulk operation)
                    // TVMaze timestamps are in seconds, need to multiply by 1000 for JS Date
                    watchedAt = episodeScrobble.marked_at && episodeScrobble.marked_at > 0 
                      ? new Date(episodeScrobble.marked_at * 1000) 
                      : new Date();
                    console.log(`Setting episode ${episode.id} as watched`);
                  } else if (episodeScrobble.type === 2) {
                    initialStatus = "skipped";
                    console.log(`Setting episode ${episode.id} as skipped`);
                  }
                }

                const userEpisodeData = insertUserEpisodeSchema.parse({
                  userId,
                  episodeId: episode.id,
                  status: initialStatus,
                  addedAt: new Date(),
                  ...(watchedAt && { watchedAt })
                });

                const { episode: userEpisode } = await storage.addUserEpisode(userEpisodeData);
                
                // If episode already existed and we have scrobble data, update its status
                if (episodeScrobble && userEpisode.id) {
                  const existingUserEpisode = await storage.getUserEpisode(userId, episode.id);
                  if (existingUserEpisode && existingUserEpisode.status !== initialStatus) {
                    const updates: any = { status: initialStatus };
                    if (watchedAt) {
                      updates.watchedAt = watchedAt;
                    }
                    await storage.updateUserEpisode(userId, episode.id, updates);
                    episodesUpdated++;
                  }
                }
                
                episodesImported++;
              }
            } catch (episodeError) {
              console.error(`Error importing episode ${episode.id}:`, episodeError);
            }
          }
        }
      } catch (episodeError) {
        console.error("Error syncing episodes:", episodeError);
      }

      const message = episodesUpdated > 0 
        ? `Show synced successfully. ${episodesImported} episodes imported, ${episodesUpdated} episodes updated from scrobble data.`
        : `Show synced successfully. ${episodesImported} episodes imported.`;

      res.json({ 
        show: syncedShow, 
        episodesImported,
        episodesUpdated,
        message
      });
    } catch (error) {
      console.error("Error syncing show:", error);
      res.status(500).json({ error: "Failed to sync show" });
    }
  });

  // Async sync endpoints with progress tracking
  app.post("/api/shows/:id/sync/start", async (req, res) => {
    try {
      const { id } = req.params;
      const showId = parseInt(id);
      const userId = getUserId(req);
      
      // Create new sync job
      const jobId = syncJobManager.createJob(showId);
      
      // Start async sync process
      setImmediate(async () => {
        await performAsyncSync(jobId, showId, userId);
      });
      
      res.json({ jobId });
    } catch (error) {
      console.error("Error starting async sync:", error);
      res.status(500).json({ error: "Failed to start sync" });
    }
  });

  app.get("/api/sync/:id/events", (req, res) => {
    const { id } = req.params;
    const job = syncJobManager.getJob(id);
    
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send initial job state
    res.write(`data: ${JSON.stringify({ 
      type: 'init', 
      data: {
        status: job.status,
        phase: job.phase,
        percent: job.percent,
        completedShows: job.completedShows,
        totalShows: job.totalShows,
        etaSeconds: job.etaSeconds,
        message: job.lastMessage,
        errors: job.errors
      },
      timestamp: Date.now()
    })}\n\n`);

    // Subscribe to job updates
    const unsubscribe = syncJobManager.subscribe(id, (event) => {
      res.write(event);
    });

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
    }, 15000);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Get sync job status (for polling fallback)
  app.get("/api/sync/:id/status", (req, res) => {
    const { id } = req.params;
    const job = syncJobManager.getJob(id);
    
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json({
      status: job.status,
      phase: job.phase,
      percent: job.percent,
      completedShows: job.completedShows,
      totalShows: job.totalShows,
      etaSeconds: job.etaSeconds,
      lastMessage: job.lastMessage,
      errors: job.errors,
      episodesImported: job.episodesImported,
      episodesUpdated: job.episodesUpdated
    });
  });

  // Cancel sync job
  app.delete("/api/sync/:id", (req, res) => {
    const { id } = req.params;
    const job = syncJobManager.getJob(id);
    
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (job.status === 'running') {
      syncJobManager.cancelJob(id);
      res.json({ message: "Sync job canceled" });
    } else {
      res.json({ message: "Job already completed or not running" });
    }
  });


  app.get("/api/shows/:id/episodes", async (req, res) => {
    try {
      const { id } = req.params;
      const response = await fetch(`https://api.tvmaze.com/shows/${id}/episodes`);
      
      if (!response.ok) {
        throw new Error(`TVMaze API error: ${response.status}`);
      }

      const episodes = await response.json();
      res.json(episodes);
    } catch (error) {
      console.error("Error fetching episodes:", error);
      res.status(500).json({ error: "Failed to fetch episodes" });
    }
  });

  // Get user episode statuses for a specific show
  app.get("/api/shows/:id/user-episodes", async (req, res) => {
    try {
      const { id } = req.params;
      const showId = parseInt(id);
      const userId = getUserId(req);
      
      const userEpisodes = await storage.getUserEpisodesForShow(userId, showId);
      
      // Convert to a map for easy lookup by episode ID
      const episodeStatusMap = userEpisodes.reduce((acc, userEpisode) => {
        acc[userEpisode.episodeId] = {
          status: userEpisode.status,
          watchedAt: userEpisode.watchedAt,
          triagedAt: userEpisode.triagedAt,
          addedAt: userEpisode.addedAt
        };
        return acc;
      }, {} as Record<number, any>);
      
      res.json(episodeStatusMap);
    } catch (error) {
      console.error("Error fetching user episodes for show:", error);
      res.status(500).json({ error: "Failed to fetch user episodes for show" });
    }
  });

  // Get episode count and stats for a show
  app.get("/api/shows/:id/stats", async (req, res) => {
    try {
      const { id } = req.params;
      const response = await fetch(`https://api.tvmaze.com/shows/${id}/episodes`);
      
      if (!response.ok) {
        if (response.status === 404) {
          return res.status(404).json({ error: "Show not found" });
        }
        throw new Error(`TVMaze API error: ${response.status}`);
      }

      const episodes = await response.json();
      const totalEpisodes = episodes.length;
      const seasons = Array.from(new Set(episodes.map((ep: any) => ep.season))).filter(Boolean).length;
      
      res.json({
        totalEpisodes,
        seasons,
        lastEpisode: episodes[episodes.length - 1] || null
      });
    } catch (error) {
      console.error("Error fetching episode stats:", error);
      res.status(500).json({ error: "Failed to fetch episode stats" });
    }
  });

  // Library search routes
  app.get("/api/search", async (req, res) => {
    try {
      const { q, includeRemoved } = req.query;
      if (!q) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
      }

      const query = q as string;
      const userId = getUserId(req);
      const shouldIncludeRemoved = includeRemoved === 'true';
      
      // Search both shows and episodes in user's library in parallel
      const [shows, episodes] = await Promise.all([
        storage.searchUserShows(userId, query, shouldIncludeRemoved),
        storage.searchUserEpisodes(userId, query)
      ]);

      // Combine results with type indicators
      const results = [
        ...shows.map(show => ({ resultType: 'show', ...show })),
        ...episodes.map(episode => ({ resultType: 'episode', ...episode }))
      ];

      res.json(results);
    } catch (error) {
      console.error("Error searching library:", error);
      res.status(500).json({ error: "Failed to search library" });
    }
  });

  // TVMaze User API routes
  app.get("/api/tvmaze/followed-shows", async (req, res) => {
    try {
      const apiKey = process.env.TVMAZE_API_KEY;
      const username = process.env.TVMAZE_USERNAME;
      
      if (!apiKey || !username) {
        return res.status(500).json({ error: "TVMaze API credentials not configured" });
      }

      // Create Basic Auth header
      const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');
      const response = await fetch(`https://api.tvmaze.com/v1/user/follows/shows?embed=show`, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${credentials}`
        }
      });
      
      
      if (!response.ok) {
        let errorMessage = `TVMaze User API error: ${response.status}`;
        try {
          const errorData = await response.text();
          console.log(`TVMaze API error response:`, errorData);
          if (errorData) {
            errorMessage += ` - ${errorData}`;
          }
        } catch (e) {
          console.log('Could not read error response body');
        }
        
        if (response.status === 401) {
          return res.status(401).json({ error: "Invalid TVMaze API credentials" });
        }
        
        if (response.status === 404) {
          return res.status(404).json({ 
            error: "TVMaze User API endpoint not found. This might mean the user doesn't have a premium account or the username is incorrect." 
          });
        }
        
        throw new Error(errorMessage);
      }

      const followedShows = await response.json();
      res.json(followedShows);
    } catch (error) {
      console.error("Error fetching followed shows:", error);
      res.status(500).json({ error: "Failed to fetch followed shows" });
    }
  });

  // Import followed shows from TVMaze into local database with progress tracking
  app.post("/api/library/import", async (req, res) => {
    try {
      const userId = getUserId(req);
      
      // Create new library import job
      const jobId = syncJobManager.createJob(0);
      
      // Start async import process
      setImmediate(async () => {
        await performAsyncLibraryImport(jobId, userId);
      });
      
      res.json({ jobId, message: "Library import started" });
    } catch (error) {
      console.error("Error starting library import:", error);
      res.status(500).json({ error: "Failed to start library import" });
    }
  });

  // SSE endpoint for library import progress
  app.get("/api/library/import/:id/events", (req, res) => {
    const { id } = req.params;
    const job = syncJobManager.getJob(id);
    
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Cache-Control'
    });

    // Send initial job state
    res.write(`data: ${JSON.stringify({ 
      type: 'init', 
      data: {
        status: job.status,
        phase: job.phase,
        percent: job.percent,
        completedShows: job.completedShows,
        totalShows: job.totalShows,
        etaSeconds: job.etaSeconds,
        message: job.lastMessage,
        errors: job.errors,
        episodesImported: job.episodesImported,
        episodesUpdated: job.episodesUpdated
      },
      timestamp: Date.now()
    })}\n\n`);

    // Subscribe to job updates
    const unsubscribe = syncJobManager.subscribe(id, (event) => {
      res.write(event);
    });

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`);
    }, 15000);

    // Cleanup on client disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // Get library from local database
  app.get("/api/library", async (req, res) => {
    try {
      const userId = getUserId(req);
      
      const userShows = await storage.getUserShows(userId);
      res.json(userShows);
    } catch (error) {
      console.error("Error fetching library:", error);
      res.status(500).json({ error: "Failed to fetch library" });
    }
  });

  // User show management routes
  app.get("/api/user/shows", async (req, res) => {
    try {
      // For demo purposes, using a mock user ID
      const userId = getUserId(req);
      
      const shows = await storage.getUserShows(userId);
      res.json(shows);
    } catch (error) {
      console.error("Error fetching user shows:", error);
      res.status(500).json({ error: "Failed to fetch user shows" });
    }
  });

  // Enhanced POST endpoint - Async job processing for adding shows with scrobble sync
  app.post("/api/user/shows", async (req, res) => {
    try {
      const userId = getUserId(req);
      const showData = req.body;

      console.log(`[ADD_SHOW] Starting add show process for show ${showData.showId}`);

      // Validate the request body
      const validatedData = insertUserShowSchema.parse({
        ...showData,
        userId,
      });

      const showId = validatedData.showId;
      console.log(`[ADD_SHOW] Validated show ID: ${showId}`);

      // Check if show already exists in user's collection
      const existingUserShow = await storage.getUserShow(userId, showId);
      if (existingUserShow && !existingUserShow.isRemoved) {
        console.log(`[ADD_SHOW] Show ${showId} already exists in active collection`);
        return res.status(400).json({ error: "Show already in your collection" });
      }
      
      // Handle soft-deleted shows by "undeleting" them
      if (existingUserShow && existingUserShow.isRemoved) {
        console.log(`[ADD_SHOW] Show ${showId} exists but is soft-deleted, restoring it...`);
        await storage.updateUserShow(userId, showId, { 
          isRemoved: false,
          addedAt: new Date() // Update the added date
        });
        console.log(`[ADD_SHOW] Successfully restored show ${showId}`);
      }

      // Sync show details from TVMaze first
      console.log(`[ADD_SHOW] Syncing show ${showId} from TVMaze...`);
      const syncedShow = await storage.syncShowFromTVMaze(showId);
      
      if (!syncedShow) {
        console.log(`[ADD_SHOW] Failed to sync show ${showId} from TVMaze`);
        return res.status(404).json({ error: "Show not found or failed to sync from TVMaze" });
      }

      console.log(`[ADD_SHOW] Successfully synced show: ${syncedShow.name}`);

      // Add user show to collection (or use existing restored one)
      let userShow;
      if (existingUserShow && existingUserShow.isRemoved) {
        // Already restored above, fetch the updated record
        userShow = await storage.getUserShow(userId, showId);
        console.log(`[ADD_SHOW] Using restored userShow: ${userShow!.id}`);
      } else {
        // Add new user show to collection
        console.log(`[ADD_SHOW] Adding show ${showId} to user collection...`);
        userShow = await storage.addUserShow(validatedData);
        console.log(`[ADD_SHOW] Successfully added userShow: ${userShow.id}`);
      }

      // Follow the show on TVMaze if credentials are available
      const apiKey = process.env.TVMAZE_API_KEY;
      const username = process.env.TVMAZE_USERNAME;
      
      if (apiKey && username) {
        try {
          console.log(`[ADD_SHOW] Following show ${showId} on TVMaze...`);
          const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');
          const followResponse = await fetch(`https://api.tvmaze.com/v1/user/follows/shows/${showId}`, {
            method: 'PUT',
            headers: {
              'Accept': 'application/json',
              'Authorization': `Basic ${credentials}`
            }
          });

          if (followResponse.ok) {
            console.log(`[ADD_SHOW] Successfully followed show ${showId} on TVMaze`);
          } else if (followResponse.status !== 409) { // 409 = already following
            console.warn(`[ADD_SHOW] Failed to follow show ${showId} on TVMaze: ${followResponse.status}`);
          } else {
            console.log(`[ADD_SHOW] Show ${showId} already followed on TVMaze`);
          }
        } catch (followError) {
          console.error(`[ADD_SHOW] Error following show ${showId} on TVMaze:`, followError);
        }
      }

      // Create async job for episode sync
      const jobId = syncJobManager.createJob(showId);
      console.log(`[ADD_SHOW] Created sync job: ${jobId}`);

      // Start async episode sync process - pass groupId for shared shows
      const episodeGroupId = userShow?.groupId;
      setImmediate(async () => {
        await performAsyncAddShowSync(jobId, showId, userId, episodeGroupId);
      });

      // Return 202 with job ID for progress tracking
      res.status(202).json({ 
        userShow,
        jobId,
        message: "Show added to collection. Episodes are being imported in the background..."
      });

      console.log(`[ADD_SHOW] Returned 202 response with jobId: ${jobId}`);
    } catch (error) {
      console.error("Error adding show:", error);
      res.status(500).json({ error: "Failed to add show" });
    }
  });

  app.patch("/api/user/shows/:showId", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { showId } = req.params;
      const updates = req.body;

      const updatedUserShow = await storage.updateUserShow(userId, parseInt(showId), updates);
      if (!updatedUserShow) {
        return res.status(404).json({ error: "Show not found in your collection" });
      }

      res.json(updatedUserShow);
    } catch (error) {
      console.error("Error updating show:", error);
      res.status(500).json({ error: "Failed to update show" });
    }
  });

  app.delete("/api/user/shows/:showId", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { showId } = req.params;
      const apiKey = process.env.TVMAZE_API_KEY;
      const username = process.env.TVMAZE_USERNAME;

      // Soft remove the show from user's library
      const removedShow = await storage.softRemoveUserShow(userId, parseInt(showId));
      if (!removedShow) {
        return res.status(404).json({ error: "Show not found in your collection" });
      }

      // Try to unfollow the show on TVMaze if credentials are available
      if (apiKey && username) {
        try {
          const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');
          const unfollowResponse = await fetch(`https://api.tvmaze.com/v1/user/follows/shows/${showId}`, {
            method: 'DELETE',
            headers: {
              'Accept': 'application/json',
              'Authorization': `Basic ${credentials}`
            }
          });

          if (unfollowResponse.ok) {
            console.log(`Successfully unfollowed show ${showId} on TVMaze`);
          } else if (unfollowResponse.status !== 404) {
            console.warn(`Failed to unfollow show ${showId} on TVMaze: ${unfollowResponse.status}`);
          }
        } catch (unfollowError) {
          console.error(`Error unfollowing show ${showId} on TVMaze:`, unfollowError);
        }
      }

      res.status(204).send();
    } catch (error) {
      console.error("Error removing show:", error);
      res.status(500).json({ error: "Failed to remove show" });
    }
  });

  // Update show group assignment (null = personal, groupId = shared with group)
  app.patch("/api/user/shows/:showId/group", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { showId } = req.params;
      
      // Validate request body - groupId can be null (personal) or a string (group ID)
      const groupSchema = z.object({
        groupId: z.string().nullable()
      });
      
      const validatedData = groupSchema.parse(req.body);

      // If groupId is provided, verify user is a member of that group
      if (validatedData.groupId) {
        const userGroupIds = await storage.getUserGroupIds(userId);
        if (!userGroupIds.includes(validatedData.groupId)) {
          return res.status(403).json({ error: "You are not a member of this group" });
        }
      }

      const updatedUserShow = await storage.updateUserShow(userId, parseInt(showId), { 
        groupId: validatedData.groupId,
        isShared: validatedData.groupId !== null // Keep isShared in sync for backward compatibility
      });
      if (!updatedUserShow) {
        return res.status(404).json({ error: "Show not found in your collection" });
      }

      res.json(updatedUserShow);
    } catch (error) {
      console.error("Error updating show group:", error);
      res.status(500).json({ error: "Failed to update show group" });
    }
  });

  // Import episodes for all followed shows
  app.post("/api/episodes/import", async (req, res) => {
    try {
      const userId = getUserId(req);
      
      // Get all user shows (followed shows)
      const userShows = await storage.getUserShows(userId);
      
      console.log(`[DEBUG] Episode import: Found ${userShows.length} user shows`);
      
      if (userShows.length === 0) {
        return res.json({ 
          message: "No followed shows found. Import shows first.", 
          imported: 0,
          total: 0 
        });
      }

      // For small collections (5 shows or less), do direct import for speed
      if (userShows.length <= 5) {
        console.log(`[DEBUG] Using synchronous import for ${userShows.length} shows`);
      } else {
        console.log(`[DEBUG] Using async job-based import for ${userShows.length} shows`);
      }
      
      if (userShows.length <= 5) {
        let importedCount = 0;
        let skippedCount = 0;

        for (const userShow of userShows) {
          try {
            console.log(`Importing episodes for show: ${userShow.show.name} (ID: ${userShow.showId})`);
            
            const response = await fetch(`https://api.tvmaze.com/shows/${userShow.showId}/episodes`);
            
            if (!response.ok) {
              console.error(`Failed to fetch episodes for show ${userShow.showId}: ${response.status}`);
              continue;
            }

            const episodes = await response.json();
            console.log(`Found ${episodes.length} episodes for ${userShow.show.name}`);

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

                const { episode: userEpisode, isNew } = await storage.addUserEpisode(userEpisodeData);
                if (isNew) {
                  importedCount++;
                } else {
                  skippedCount++;
                }
                
              } catch (episodeError) {
                console.error(`Error processing episode ${episode.id} for show ${userShow.show.name}:`, episodeError);
              }
            }
          } catch (showError) {
            console.error(`Error processing show ${userShow.show.name}:`, showError);
          }
        }

        return res.json({ 
          message: "Episode import completed", 
          imported: importedCount,
          skipped: skippedCount
        });
      }

      // For larger collections, use job-based async import with progress tracking
      const jobId = syncJobManager.createJob(0);
      
      // Start async episode import
      performAsyncEpisodeImport(jobId, userId).catch(error => {
        console.error("Async episode import failed:", error);
      });
      
      res.json({ 
        jobId,
        message: "Episode import started"
      });
      
    } catch (error) {
      console.error("Error importing episodes:", error);
      res.status(500).json({ error: "Failed to import episodes" });
    }
  });

  // Episode import progress via JSON polling (no more SSE)
  app.get("/api/episodes/import/progress/:id", (req, res) => {
    const { id } = req.params;
    
    console.log(`[PROGRESS] Polling request for job ${id}`);

    // Get job status
    const job = syncJobManager.getJob(id);
    if (!job) {
      console.log(`[PROGRESS] Job ${id} not found`);
      return res.status(404).json({ error: 'Job not found' });
    }
    
    console.log(`[PROGRESS] Job ${id} status: ${job.status}, ${job.completedShows}/${job.totalShows} shows`);
    
    // Always return JSON response for polling
    res.json({
      status: job.status,
      phase: job.phase,
      percent: job.percent,
      completedShows: job.completedShows,
      totalShows: job.totalShows,
      etaSeconds: job.etaSeconds,
      message: job.lastMessage,
      errors: job.errors,
      episodesImported: job.episodesImported,
      episodesUpdated: job.episodesUpdated
    });
  });

  // Cancel episode import job
  app.post("/api/episodes/import/cancel/:id", (req, res) => {
    const { id } = req.params;
    
    const success = syncJobManager.cancelJob(id);
    
    if (success) {
      res.json({ message: "Episode sync canceled successfully" });
    } else {
      res.status(404).json({ error: "Job not found or not running" });
    }
  });

  // Check for active episode import jobs
  app.get("/api/episodes/import/status", (req, res) => {
    const activeJobs = syncJobManager.getActiveJobs();
    const activeJob = activeJobs.length > 0 ? activeJobs[0] : null;
    
    if (activeJob) {
      res.json({
        hasActiveJob: true,
        jobId: activeJob.id,
        status: activeJob.status,
        phase: activeJob.phase,
        percent: activeJob.percent,
        completedShows: activeJob.completedShows,
        totalShows: activeJob.totalShows,
        message: activeJob.lastMessage
      });
    } else {
      res.json({
        hasActiveJob: false
      });
    }
  });

  // Get user episodes with filtering by status
  app.get("/api/user/episodes", async (req, res) => {
    try {
      const { status, showMode } = req.query;
      const userId = getUserId(req);
      
      // Validate showMode parameter
      const validShowModes = ['personal', 'shared', 'all'];
      const parsedShowMode = typeof showMode === 'string' && validShowModes.includes(showMode) 
        ? showMode 
        : undefined;
      
      // Get user's group IDs for shared mode filtering
      let groupIds: string[] | undefined;
      if (parsedShowMode === 'shared') {
        groupIds = await storage.getUserGroupIds(userId);
        console.log('[DEBUG] Shared mode - userId:', userId, 'groupIds:', groupIds);
      }
      
      const episodes = await storage.getUserEpisodes(userId, status as string, parsedShowMode, groupIds);
      console.log('[DEBUG] getUserEpisodes returned', episodes.length, 'episodes for showMode:', parsedShowMode);
      res.json(episodes);
    } catch (error) {
      console.error("Error fetching user episodes:", error);
      res.status(500).json({ error: "Failed to fetch user episodes" });
    }
  });

  // Get upcoming episodes with future air dates
  app.get("/api/user/episodes/upcoming", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { showMode } = req.query;
      
      const validShowModes = ['personal', 'shared', 'all'];
      const parsedShowMode = typeof showMode === 'string' && validShowModes.includes(showMode) 
        ? showMode 
        : undefined;
      
      // Get user's group IDs for shared mode filtering
      let groupIds: string[] | undefined;
      if (parsedShowMode === 'shared') {
        groupIds = await storage.getUserGroupIds(userId);
      }
      
      const upcomingEpisodes = await storage.getUpcomingEpisodes(userId, parsedShowMode, groupIds);
      res.json(upcomingEpisodes);
    } catch (error) {
      console.error("Error fetching upcoming episodes:", error);
      res.status(500).json({ error: "Failed to fetch upcoming episodes" });
    }
  });

  // Update user episode status
  // Get individual episode with show and user data
  app.get("/api/episodes/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const episodeId = parseInt(id);
      const userId = getUserId(req);
      
      const episodeData = await storage.getEpisodeWithShowAndUserData(userId, episodeId);
      
      if (!episodeData) {
        return res.status(404).json({ error: "Episode not found" });
      }

      res.json(episodeData);
    } catch (error) {
      console.error("Error fetching episode:", error);
      res.status(500).json({ error: "Failed to fetch episode" });
    }
  });

  app.patch("/api/user/episodes/:episodeId", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { episodeId } = req.params;
      const updates = req.body;

      // Add timestamp fields based on status
      if (updates.status === "watched" && !updates.watchedAt) {
        updates.watchedAt = new Date();
      }
      if (updates.status !== "untriaged" && !updates.triagedAt) {
        updates.triagedAt = new Date();
      }

      // Get the existing user episode to determine if it's personal or shared
      // getUserEpisode checks both personal episodes (by userId) and shared episodes (by user's group membership)
      const existingUserEpisode = await storage.getUserEpisode(userId, parseInt(episodeId));
      if (!existingUserEpisode) {
        return res.status(404).json({ error: "Episode not found in your collection" });
      }
      
      // Use the groupId from the existing record (if shared) or undefined (if personal)
      const episodeGroupId = existingUserEpisode.groupId;

      const updatedUserEpisode = await storage.updateUserEpisode(userId, parseInt(episodeId), updates, episodeGroupId);
      if (!updatedUserEpisode) {
        return res.status(404).json({ error: "Episode not found in your collection" });
      }

      // If episode is marked as watched or skipped, sync to TVMaze
      if (updates.status === "watched" || updates.status === "skipped") {
        const apiKey = process.env.TVMAZE_API_KEY;
        const username = process.env.TVMAZE_USERNAME;
        
        if (apiKey && username) {
          try {
            const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');
            const tvmazeType = updates.status === "watched" ? 0 : 2; // 0 = watched, 1 = acquired, 2 = skipped in TVMaze
            const tvmazeResponse = await fetch(`https://api.tvmaze.com/v1/user/episodes/${episodeId}`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Basic ${credentials}`
              },
              body: JSON.stringify({ type: tvmazeType })
            });

            if (tvmazeResponse.ok) {
              console.log(`Successfully marked episode ${episodeId} as ${updates.status} in TVMaze`);
            } else if (tvmazeResponse.status === 404) {
              // Episode might not exist in user's TVMaze profile, which is fine
              console.log(`Episode ${episodeId} not found in TVMaze user profile (user might not follow this show)`);
            } else {
              console.warn(`Failed to mark episode ${episodeId} as ${updates.status} in TVMaze: ${tvmazeResponse.status}`);
              const errorText = await tvmazeResponse.text();
              console.warn(`TVMaze error response: ${errorText}`);
            }
          } catch (tvmazeError) {
            console.error(`Error syncing episode ${episodeId} to TVMaze:`, tvmazeError);
            // Don't fail the main request if TVMaze sync fails
          }
        } else {
          console.log("TVMaze credentials not configured, skipping sync");
        }
      }

      res.json(updatedUserEpisode);
    } catch (error) {
      console.error("Error updating user episode:", error);
      res.status(500).json({ error: "Failed to update user episode" });
    }
  });

  // Sync episode watch status from TVMaze scrobbles
  app.post("/api/episodes/sync-scrobbles", async (req, res) => {
    try {
      const apiKey = process.env.TVMAZE_API_KEY;
      const username = process.env.TVMAZE_USERNAME;
      const userId = getUserId(req);
      
      if (!apiKey || !username) {
        return res.status(500).json({ error: "TVMaze API credentials not configured" });
      }

      // Get all untriaged episodes
      const untriagedEpisodes = await storage.getUserEpisodes(userId, "untriaged");
      
      if (untriagedEpisodes.length === 0) {
        return res.json({ message: "No untriaged episodes to sync", updated: 0 });
      }

      // Group episodes by show ID to avoid duplicate API calls
      const episodesByShow = new Map<number, typeof untriagedEpisodes>();
      for (const userEpisode of untriagedEpisodes) {
        const showId = userEpisode.episode.show.id;
        if (!episodesByShow.has(showId)) {
          episodesByShow.set(showId, []);
        }
        episodesByShow.get(showId)!.push(userEpisode);
      }

      let updatedCount = 0;
      const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');

      // Process each show
      for (const [showId, showEpisodes] of Array.from(episodesByShow.entries())) {
        try {
          // Query TVMaze scrobble API for this show
          const scrobbleResponse = await fetch(`https://api.tvmaze.com/v1/scrobble/shows/${showId}`, {
            headers: {
              'Accept': 'application/json',
              'Authorization': `Basic ${credentials}`
            }
          });

          if (!scrobbleResponse.ok) {
            if (scrobbleResponse.status === 404) {
              // No scrobbles for this show, skip it
              console.log(`No scrobbles found for show ${showId}`);
              continue;
            }
            console.error(`Error fetching scrobbles for show ${showId}: ${scrobbleResponse.status}`);
            continue;
          }

          const scrobbleData = await scrobbleResponse.json();
          
          // Process each episode for this show
          for (const userEpisode of showEpisodes) {
            const episodeId = userEpisode.episode.id;
            
            // Find scrobble data for this episode
            const episodeScrobble = scrobbleData.find((scrobble: any) => 
              scrobble.episode_id === episodeId
            );

            if (episodeScrobble) {
              let newStatus = null;
              let watchedAt = null;

              // Mark type 0 = watched, Mark type 2 = skipped
              if (episodeScrobble.marked_at && episodeScrobble.type === 0) {
                newStatus = "watched";
                // TVMaze timestamps are in seconds, need to multiply by 1000 for JS Date
                watchedAt = new Date(episodeScrobble.marked_at * 1000);
              } else if (episodeScrobble.marked_at && episodeScrobble.type === 2) {
                newStatus = "skipped";
              }

              if (newStatus) {
                const updates: any = { 
                  status: newStatus,
                  triagedAt: new Date()
                };
                
                if (watchedAt) {
                  updates.watchedAt = watchedAt;
                }

                await storage.updateUserEpisode(userId, episodeId, updates);
                updatedCount++;
                console.log(`Updated episode ${episodeId} to ${newStatus}`);
              }
            }
          }
        } catch (error) {
          console.error(`Error processing scrobbles for show ${showId}:`, error);
          continue;
        }
      }

      res.json({ 
        message: `Sync completed: ${updatedCount} episodes updated`,
        updated: updatedCount,
        totalProcessed: untriagedEpisodes.length
      });

    } catch (error) {
      console.error("Error syncing scrobbles:", error);
      res.status(500).json({ error: "Failed to sync scrobbles" });
    }
  });

  // User settings routes
  app.get("/api/user/settings", async (req, res) => {
    try {
      const userId = getUserId(req);
      
      let settings = await storage.getUserSettings(userId);
      
      // Create default settings if they don't exist
      if (!settings) {
        const defaultSettings = {
          userId,
          hideFinishedShows: true,
          showMode: "personal",
        };
        settings = await storage.createUserSettings(defaultSettings);
      }
      
      res.json(settings);
    } catch (error) {
      console.error("Error fetching user settings:", error);
      res.status(500).json({ error: "Failed to fetch user settings" });
    }
  });

  app.patch("/api/user/settings", async (req, res) => {
    try {
      const userId = getUserId(req);
      const updates = req.body;
      
      // Ensure user settings exist first
      let settings = await storage.getUserSettings(userId);
      if (!settings) {
        const defaultSettings = {
          userId,
          hideFinishedShows: true,
          showMode: "personal",
        };
        settings = await storage.createUserSettings(defaultSettings);
      }
      
      const updatedSettings = await storage.updateUserSettings(userId, updates);
      if (!updatedSettings) {
        return res.status(404).json({ error: "Settings not found" });
      }
      
      res.json(updatedSettings);
    } catch (error) {
      console.error("Error updating user settings:", error);
      res.status(500).json({ error: "Failed to update user settings" });
    }
  });

  // Recommendation routes
  app.get("/api/recommendations", async (req, res) => {
    try {
      const userId = getUserId(req);
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 25; // Default to top 25
      const recommendations = await storage.getRecommendations(userId, limit);
      res.json(recommendations);
    } catch (error) {
      console.error("Error fetching recommendations:", error);
      res.status(500).json({ error: "Failed to fetch recommendations" });
    }
  });

  app.post("/api/recommendations/refresh", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { refreshRecommendationsForUser } = await import("./recommendation-service");
      const result = await refreshRecommendationsForUser(userId);
      res.json(result);
    } catch (error) {
      console.error("Error refreshing recommendations:", error);
      res.status(500).json({ error: "Failed to refresh recommendations" });
    }
  });

  app.post("/api/recommendations/dismiss", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { tmdbId } = req.body;
      
      if (!tmdbId) {
        return res.status(400).json({ error: "tmdbId is required" });
      }
      
      await storage.dismissRecommendation(userId, tmdbId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error dismissing recommendation:", error);
      res.status(500).json({ error: "Failed to dismiss recommendation" });
    }
  });

  app.post("/api/recommendations/accept", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { tmdbId, tvmazeId } = req.body;
      
      if (!tvmazeId) {
        return res.status(400).json({ error: "tvmazeId is required" });
      }
      
      // Check if show exists, if not sync it
      let show = await storage.getShow(tvmazeId);
      if (!show) {
        show = await storage.syncShowFromTVMaze(tvmazeId);
        if (!show) {
          return res.status(404).json({ error: "Show not found on TVMaze" });
        }
      }
      
      // Update TMDB ID if provided
      if (tmdbId && !show.tmdbId) {
        await storage.updateShowTmdbId(tvmazeId, tmdbId);
      }
      
      // Always dismiss the recommendation when accepting
      if (tmdbId) {
        await storage.dismissRecommendation(userId, tmdbId);
      }
      
      // Check if user already has this show
      const existingUserShow = await storage.getUserShow(userId, tvmazeId);
      if (existingUserShow) {
        // If it was removed, unremove it
        if (existingUserShow.isRemoved) {
          await storage.updateUserShow(userId, tvmazeId, { isRemoved: false });
        }
        return res.json({ userShow: existingUserShow, show });
      }
      
      // Add show to user's library
      const userShow = await storage.addUserShow({
        userId,
        showId: tvmazeId,
        isRemoved: false,
        isShared: false,
      });
      
      // Start async episode sync
      const jobId = syncJobManager.createJob(tvmazeId);
      
      // Fire and forget the async sync
      performAsyncAddShowSync(jobId, tvmazeId, userId).catch(error => {
        console.error(`[ADD_SHOW] Async sync failed for job ${jobId}:`, error);
      });
      
      res.json({ userShow, show, syncJobId: jobId });
    } catch (error) {
      console.error("Error accepting recommendation:", error);
      res.status(500).json({ error: "Failed to accept recommendation" });
    }
  });

  app.post("/api/recommendations/accept-watched", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { tmdbId, tvmazeId } = req.body;
      
      if (!tvmazeId) {
        return res.status(400).json({ error: "tvmazeId is required" });
      }
      
      // Check if show exists, if not sync it
      let show = await storage.getShow(tvmazeId);
      if (!show) {
        show = await storage.syncShowFromTVMaze(tvmazeId);
        if (!show) {
          return res.status(404).json({ error: "Show not found on TVMaze" });
        }
      }
      
      // Update TMDB ID if provided
      if (tmdbId && !show.tmdbId) {
        await storage.updateShowTmdbId(tvmazeId, tmdbId);
      }
      
      // Always dismiss the recommendation when accepting
      if (tmdbId) {
        await storage.dismissRecommendation(userId, tmdbId);
      }
      
      // Check if user already has this show
      const existingUserShow = await storage.getUserShow(userId, tvmazeId);
      if (existingUserShow) {
        // If it was removed, unremove it
        if (existingUserShow.isRemoved) {
          await storage.updateUserShow(userId, tvmazeId, { isRemoved: false });
        }
        return res.json({ userShow: existingUserShow, show });
      }
      
      // Add show to user's library
      const userShow = await storage.addUserShow({
        userId,
        showId: tvmazeId,
        isRemoved: false,
        isShared: false,
      });
      
      // Sync episodes first
      const jobId = syncJobManager.createJob(tvmazeId);
      
      // Sync episodes and mark all as watched
      (async () => {
        try {
          // Perform the episode sync
          await performAsyncAddShowSync(jobId, tvmazeId, userId);
          
          // Get all user episodes for this show
          const userEpisodes = await storage.getUserEpisodesForShow(userId, tvmazeId);
          
          // Mark all episodes as watched
          for (const userEpisode of userEpisodes) {
            await storage.updateUserEpisode(userId, userEpisode.episodeId, {
              status: "watched",
              watchedAt: new Date()
            });
          }
          
          console.log(`[ACCEPT_WATCHED] Marked ${userEpisodes.length} episodes as watched for show ${tvmazeId}`);
        } catch (error) {
          console.error(`[ACCEPT_WATCHED] Failed for job ${jobId}:`, error);
        }
      })();
      
      res.json({ userShow, show, syncJobId: jobId });
    } catch (error) {
      console.error("Error accepting recommendation as watched:", error);
      res.status(500).json({ error: "Failed to accept recommendation" });
    }
  });

  // New Releases routes
  app.get("/api/new-releases", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { getNewReleases } = await import("./new-releases-service");
      const result = await getNewReleases(userId);
      res.json(result);
    } catch (error) {
      console.error("Error fetching new releases:", error);
      res.status(500).json({ error: "Failed to fetch new releases" });
    }
  });

  app.post("/api/new-releases/refresh", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { refreshNewReleases, getNewReleases } = await import("./new-releases-service");
      await refreshNewReleases();
      const result = await getNewReleases(userId);
      res.json(result);
    } catch (error) {
      console.error("Error refreshing new releases:", error);
      res.status(500).json({ error: "Failed to refresh new releases" });
    }
  });

  app.post("/api/new-releases/dismiss", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { tvmazeId } = req.body;
      
      if (!tvmazeId) {
        return res.status(400).json({ error: "tvmazeId is required" });
      }
      
      await storage.dismissNewRelease(userId, tvmazeId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error dismissing new release:", error);
      res.status(500).json({ error: "Failed to dismiss new release" });
    }
  });

  app.post("/api/new-releases/add", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { tvmazeId } = req.body;
      
      if (!tvmazeId) {
        return res.status(400).json({ error: "tvmazeId is required" });
      }
      
      // Check if show exists, if not sync it
      let show = await storage.getShow(tvmazeId);
      if (!show) {
        show = await storage.syncShowFromTVMaze(tvmazeId);
        if (!show) {
          return res.status(404).json({ error: "Show not found on TVMaze" });
        }
      }
      
      // Check if user already has this show
      const existingUserShow = await storage.getUserShow(userId, tvmazeId);
      if (existingUserShow) {
        if (existingUserShow.isRemoved) {
          await storage.updateUserShow(userId, tvmazeId, { isRemoved: false });
        }
        return res.json({ userShow: existingUserShow, show });
      }
      
      // Add show to user's library
      const userShow = await storage.addUserShow({
        userId,
        showId: tvmazeId,
        isRemoved: false,
        isShared: false,
      });
      
      // Also dismiss from new releases
      await storage.dismissNewRelease(userId, tvmazeId);
      
      // Start async episode sync
      const jobId = syncJobManager.createJob(tvmazeId);
      
      performAsyncAddShowSync(jobId, tvmazeId, userId).catch(error => {
        console.error(`[NEW_RELEASES_ADD] Async sync failed for job ${jobId}:`, error);
      });
      
      res.json({ userShow, show, syncJobId: jobId });
    } catch (error) {
      console.error("Error adding new release:", error);
      res.status(500).json({ error: "Failed to add new release" });
    }
  });

  app.post("/api/new-releases/add-watched", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { tvmazeId } = req.body;
      
      if (!tvmazeId) {
        return res.status(400).json({ error: "tvmazeId is required" });
      }
      
      // Check if show exists, if not sync it
      let show = await storage.getShow(tvmazeId);
      if (!show) {
        show = await storage.syncShowFromTVMaze(tvmazeId);
        if (!show) {
          return res.status(404).json({ error: "Show not found on TVMaze" });
        }
      }
      
      // Check if user already has this show
      const existingUserShow = await storage.getUserShow(userId, tvmazeId);
      if (existingUserShow) {
        if (existingUserShow.isRemoved) {
          await storage.updateUserShow(userId, tvmazeId, { isRemoved: false });
        }
        return res.json({ userShow: existingUserShow, show });
      }
      
      // Add show to user's library
      const userShow = await storage.addUserShow({
        userId,
        showId: tvmazeId,
        isRemoved: false,
        isShared: false,
      });
      
      // Also dismiss from new releases
      await storage.dismissNewRelease(userId, tvmazeId);
      
      // Sync episodes and mark all as watched
      const jobId = syncJobManager.createJob(tvmazeId);
      
      (async () => {
        try {
          await performAsyncAddShowSync(jobId, tvmazeId, userId);
          
          const userEpisodes = await storage.getUserEpisodesForShow(userId, tvmazeId);
          
          for (const userEpisode of userEpisodes) {
            await storage.updateUserEpisode(userId, userEpisode.episodeId, {
              status: "watched",
              watchedAt: new Date()
            });
          }
          
          console.log(`[NEW_RELEASES_ADD_WATCHED] Marked ${userEpisodes.length} episodes as watched for show ${tvmazeId}`);
        } catch (error) {
          console.error(`[NEW_RELEASES_ADD_WATCHED] Failed for job ${jobId}:`, error);
        }
      })();
      
      res.json({ userShow, show, syncJobId: jobId });
    } catch (error) {
      console.error("Error adding new release as watched:", error);
      res.status(500).json({ error: "Failed to add new release" });
    }
  });

  // =====================
  // Group routes
  // =====================
  
  // Get user's groups
  app.get("/api/groups", async (req, res) => {
    try {
      const userId = getUserId(req);
      const userGroups = await storage.getUserGroups(userId);
      res.json(userGroups);
    } catch (error) {
      console.error("Error fetching groups:", error);
      res.status(500).json({ error: "Failed to fetch groups" });
    }
  });

  // Create a new group
  app.post("/api/groups", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { name, description } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: "Group name is required" });
      }
      
      const group = await storage.createGroup({
        name,
        description: description || null,
        createdBy: userId,
      });
      
      // Add creator as a member
      await storage.addGroupMember({
        groupId: group.id,
        userId,
      });
      
      // Create a permanent invite link for the group
      const inviteCode = Math.random().toString(36).substring(2, 10) + 
                        Math.random().toString(36).substring(2, 10);
      await storage.createGroupInvite({
        groupId: group.id,
        inviteCode,
        invitedEmail: null,
        invitedBy: userId,
        expiresAt: null,
      });
      
      res.json(group);
    } catch (error) {
      console.error("Error creating group:", error);
      res.status(500).json({ error: "Failed to create group" });
    }
  });

  // Get a specific group
  app.get("/api/groups/:groupId", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { groupId } = req.params;
      
      const isMember = await storage.isGroupMember(groupId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      
      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      const members = await storage.getGroupMembers(groupId);
      const groupShows = await storage.getGroupShows(groupId);
      res.json({ ...group, members, shows: groupShows });
    } catch (error) {
      console.error("Error fetching group:", error);
      res.status(500).json({ error: "Failed to fetch group" });
    }
  });

  // Update a group
  app.patch("/api/groups/:groupId", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { groupId } = req.params;
      const { name, description } = req.body;
      
      const isMember = await storage.isGroupMember(groupId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      
      const updated = await storage.updateGroup(groupId, { name, description });
      res.json(updated);
    } catch (error) {
      console.error("Error updating group:", error);
      res.status(500).json({ error: "Failed to update group" });
    }
  });

  // Delete a group
  app.delete("/api/groups/:groupId", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { groupId } = req.params;
      
      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      // Only creator can delete
      if (group.createdBy !== userId) {
        return res.status(403).json({ error: "Only the group creator can delete the group" });
      }
      
      await storage.deleteGroup(groupId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting group:", error);
      res.status(500).json({ error: "Failed to delete group" });
    }
  });

  // Get group members
  app.get("/api/groups/:groupId/members", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { groupId } = req.params;
      
      const isMember = await storage.isGroupMember(groupId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      
      const members = await storage.getGroupMembers(groupId);
      res.json(members);
    } catch (error) {
      console.error("Error fetching group members:", error);
      res.status(500).json({ error: "Failed to fetch group members" });
    }
  });

  // Leave a group
  app.delete("/api/groups/:groupId/members/me", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { groupId } = req.params;
      
      const group = await storage.getGroup(groupId);
      if (!group) {
        return res.status(404).json({ error: "Group not found" });
      }
      
      // If creator is leaving, delete the group
      if (group.createdBy === userId) {
        await storage.deleteGroup(groupId);
        return res.json({ success: true, groupDeleted: true });
      }
      
      await storage.removeGroupMember(groupId, userId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error leaving group:", error);
      res.status(500).json({ error: "Failed to leave group" });
    }
  });

  // Create an invite link
  app.post("/api/groups/:groupId/invites", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { groupId } = req.params;
      const { email, expiresInDays } = req.body;
      
      const isMember = await storage.isGroupMember(groupId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      
      // Generate unique invite code
      const inviteCode = Math.random().toString(36).substring(2, 10) + 
                        Math.random().toString(36).substring(2, 10);
      
      const expiresAt = expiresInDays 
        ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;
      
      const invite = await storage.createGroupInvite({
        groupId,
        inviteCode,
        invitedEmail: email || null,
        invitedBy: userId,
        expiresAt,
      });
      
      res.json({ 
        invite, 
        inviteUrl: `/join/${inviteCode}` 
      });
    } catch (error) {
      console.error("Error creating invite:", error);
      res.status(500).json({ error: "Failed to create invite" });
    }
  });

  // Get pending invites for a group
  app.get("/api/groups/:groupId/invites", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { groupId } = req.params;
      
      const isMember = await storage.isGroupMember(groupId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      
      const invites = await storage.getPendingInvitesForGroup(groupId);
      res.json(invites);
    } catch (error) {
      console.error("Error fetching invites:", error);
      res.status(500).json({ error: "Failed to fetch invites" });
    }
  });

  // Delete an invite
  app.delete("/api/groups/:groupId/invites/:inviteId", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { groupId, inviteId } = req.params;
      
      const isMember = await storage.isGroupMember(groupId, userId);
      if (!isMember) {
        return res.status(403).json({ error: "Not a member of this group" });
      }
      
      await storage.deleteGroupInvite(inviteId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting invite:", error);
      res.status(500).json({ error: "Failed to delete invite" });
    }
  });

  // Get pending invites for current user (by email)
  app.get("/api/invites/pending", async (req, res) => {
    try {
      const userId = getUserId(req);
      const user = await storage.getUser(userId);
      
      if (!user?.email) {
        return res.json([]);
      }
      
      const invites = await storage.getGroupInvitesByEmail(user.email);
      res.json(invites);
    } catch (error) {
      console.error("Error fetching pending invites:", error);
      res.status(500).json({ error: "Failed to fetch pending invites" });
    }
  });

  // Get invite info (public endpoint)
  app.get("/api/invites/:inviteCode", async (req, res) => {
    try {
      const { inviteCode } = req.params;
      
      const invite = await storage.getGroupInvite(inviteCode);
      if (!invite) {
        return res.status(404).json({ error: "Invite not found" });
      }
      
      if (invite.usedAt) {
        return res.status(400).json({ error: "Invite already used" });
      }
      
      if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
        return res.status(400).json({ error: "Invite has expired" });
      }
      
      const group = await storage.getGroup(invite.groupId);
      res.json({ invite, group });
    } catch (error) {
      console.error("Error fetching invite:", error);
      res.status(500).json({ error: "Failed to fetch invite" });
    }
  });

  // Accept an invite
  app.post("/api/invites/:inviteCode/accept", async (req, res) => {
    try {
      const userId = getUserId(req);
      const { inviteCode } = req.params;
      
      const invite = await storage.getGroupInvite(inviteCode);
      if (!invite) {
        return res.status(404).json({ error: "Invite not found" });
      }
      
      if (invite.usedAt) {
        return res.status(400).json({ error: "Invite already used" });
      }
      
      if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
        return res.status(400).json({ error: "Invite has expired" });
      }
      
      // Check if already a member
      const isMember = await storage.isGroupMember(invite.groupId, userId);
      if (isMember) {
        return res.status(400).json({ error: "Already a member of this group" });
      }
      
      // Add user to group
      await storage.addGroupMember({
        groupId: invite.groupId,
        userId,
      });
      
      // Mark invite as used (only for email-specific invites)
      if (invite.invitedEmail) {
        await storage.useGroupInvite(inviteCode, userId);
      }
      
      const group = await storage.getGroup(invite.groupId);
      res.json({ success: true, group });
    } catch (error) {
      console.error("Error accepting invite:", error);
      res.status(500).json({ error: "Failed to accept invite" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}
