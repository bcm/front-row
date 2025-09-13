import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertShowSchema, insertUserShowSchema, insertEpisodeSchema, insertUserEpisodeSchema } from "@shared/schema";

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
      const userId = "demo-user"; // Mock user ID
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
                airstamp: episode.airstamp,
                runtime: episode.runtime,
                rating: episode.rating,
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
                  if (episodeScrobble.marked_at && episodeScrobble.type === 0) {
                    initialStatus = "watched";
                    watchedAt = new Date(episodeScrobble.marked_at);
                  } else if (episodeScrobble.marked_at && episodeScrobble.type === 2) {
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

                const userEpisode = await storage.addUserEpisode(userEpisodeData);
                
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
      const userId = "demo-user"; // Mock user ID
      
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
      const { q } = req.query;
      if (!q) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
      }

      const query = q as string;
      const userId = "demo-user"; // Mock user ID
      
      // Search both shows and episodes in user's library in parallel
      const [shows, episodes] = await Promise.all([
        storage.searchUserShows(userId, query),
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

  // Import followed shows from TVMaze into local database
  app.post("/api/library/import", async (req, res) => {
    try {
      const apiKey = process.env.TVMAZE_API_KEY;
      const username = process.env.TVMAZE_USERNAME;
      const userId = "demo-user"; // Mock user ID
      
      if (!apiKey || !username) {
        return res.status(500).json({ error: "TVMaze API credentials not configured" });
      }

      // Fetch followed shows from TVMaze API
      const credentials = Buffer.from(`${username}:${apiKey}`).toString('base64');
      const response = await fetch(`https://api.tvmaze.com/v1/user/follows/shows?embed=show`, {
        headers: {
          'Accept': 'application/json',
          'Authorization': `Basic ${credentials}`
        }
      });
      
      if (!response.ok) {
        if (response.status === 401) {
          return res.status(401).json({ error: "Invalid TVMaze API credentials" });
        }
        if (response.status === 404) {
          return res.status(404).json({ 
            error: "TVMaze User API endpoint not found. This might mean the user doesn't have a premium account or the username is incorrect." 
          });
        }
        throw new Error(`TVMaze User API error: ${response.status}`);
      }

      const followedShows = await response.json();
      let importedCount = 0;
      let skippedCount = 0;

      // Process each followed show
      for (const followedShow of followedShows) {
        const show = followedShow._embedded.show;
        
        try {
          // Check if show already exists in user's collection
          const existingUserShow = await storage.getUserShow(userId, show.id);
          if (existingUserShow) {
            skippedCount++;
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
            status: "later",
            priority: 0
          });

          await storage.addUserShow(userShowData);
          importedCount++;
        } catch (error) {
          console.error(`Error importing show ${show.name}:`, error);
          // Continue with other shows even if one fails
        }
      }

      res.json({ 
        message: "Import completed", 
        imported: importedCount, 
        skipped: skippedCount,
        total: followedShows.length
      });
    } catch (error) {
      console.error("Error importing followed shows:", error);
      res.status(500).json({ error: "Failed to import followed shows" });
    }
  });

  // Get library from local database
  app.get("/api/library", async (req, res) => {
    try {
      const userId = "demo-user"; // Mock user ID
      
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
      const { status } = req.query;
      // For demo purposes, using a mock user ID
      const userId = "demo-user";
      
      const shows = await storage.getUserShows(userId, status as string);
      res.json(shows);
    } catch (error) {
      console.error("Error fetching user shows:", error);
      res.status(500).json({ error: "Failed to fetch user shows" });
    }
  });

  app.post("/api/user/shows", async (req, res) => {
    try {
      const userId = "demo-user"; // Mock user ID
      const showData = req.body;

      // Validate the request body
      const validatedData = insertUserShowSchema.parse({
        ...showData,
        userId,
      });

      // Check if show already exists in user's collection
      const existingUserShow = await storage.getUserShow(userId, validatedData.showId);
      if (existingUserShow) {
        return res.status(400).json({ error: "Show already in your collection" });
      }

      // Fetch show details from TVMaze API and store locally
      const showResponse = await fetch(`https://api.tvmaze.com/shows/${validatedData.showId}`);
      if (showResponse.ok) {
        const showDetails = await showResponse.json();
        const showToStore = insertShowSchema.parse({
          id: showDetails.id,
          name: showDetails.name,
          summary: showDetails.summary,
          image: showDetails.image,
          network: showDetails.network,
          genres: showDetails.genres || [],
          status: showDetails.status,
          premiered: showDetails.premiered,
          rating: showDetails.rating,
          runtime: showDetails.runtime,
          officialSite: showDetails.officialSite,
          language: showDetails.language,
          type: showDetails.type,
          updated: showDetails.updated,
        });
        
        await storage.createShow(showToStore);
      }

      const userShow = await storage.addUserShow(validatedData);
      res.status(201).json(userShow);
    } catch (error) {
      console.error("Error adding show:", error);
      res.status(500).json({ error: "Failed to add show" });
    }
  });

  app.patch("/api/user/shows/:showId", async (req, res) => {
    try {
      const userId = "demo-user"; // Mock user ID
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
      const userId = "demo-user"; // Mock user ID
      const { showId } = req.params;

      const success = await storage.removeUserShow(userId, parseInt(showId));
      if (!success) {
        return res.status(404).json({ error: "Show not found in your collection" });
      }

      res.status(204).send();
    } catch (error) {
      console.error("Error removing show:", error);
      res.status(500).json({ error: "Failed to remove show" });
    }
  });

  // Import episodes for all followed shows
  app.post("/api/episodes/import", async (req, res) => {
    try {
      const userId = "demo-user"; // Mock user ID
      
      // Get all user shows (followed shows)
      const userShows = await storage.getUserShows(userId);
      
      if (userShows.length === 0) {
        return res.json({ 
          message: "No followed shows found. Import shows first.", 
          imported: 0,
          total: 0 
        });
      }

      let importedCount = 0;
      let skippedCount = 0;
      let totalProcessed = 0;

      // Process each followed show
      for (const userShow of userShows) {
        try {
          console.log(`Importing episodes for show: ${userShow.show.name} (ID: ${userShow.showId})`);
          
          // Fetch episodes from TVMaze API
          const response = await fetch(`https://api.tvmaze.com/shows/${userShow.showId}/episodes`);
          
          if (!response.ok) {
            console.error(`Failed to fetch episodes for show ${userShow.showId}: ${response.status}`);
            continue;
          }

          const episodes = await response.json();
          console.log(`Found ${episodes.length} episodes for ${userShow.show.name}`);

          // Process each episode
          for (const episode of episodes) {
            try {
              // Prepare episode data for storage
              const episodeToStore = insertEpisodeSchema.parse({
                id: episode.id,
                showId: userShow.showId,
                season: episode.season,
                number: episode.number,
                name: episode.name,
                summary: episode.summary,
                airdate: episode.airdate,
                airstamp: episode.airstamp,
                runtime: episode.runtime,
                rating: episode.rating,
                image: episode.image
              });
              
              // Store episode in database (will skip if already exists due to onConflictDoUpdate)
              await storage.createEpisode(episodeToStore);

              // Create user episode with "untriaged" status (addUserEpisode handles duplicates)
              const userEpisodeData = insertUserEpisodeSchema.parse({
                userId,
                episodeId: episode.id,
                status: "untriaged",
                addedAt: new Date()
              });

              const userEpisode = await storage.addUserEpisode(userEpisodeData);
              if (userEpisode.id) {
                importedCount++;
              } else {
                skippedCount++;
              }
              
              totalProcessed++;
            } catch (episodeError) {
              console.error(`Error processing episode ${episode.id} for show ${userShow.show.name}:`, episodeError);
              // Continue with other episodes
            }
          }
        } catch (showError) {
          console.error(`Error processing show ${userShow.show.name}:`, showError);
          // Continue with other shows
        }
      }

      res.json({ 
        message: "Episode import completed", 
        imported: importedCount,
        skipped: skippedCount,
        totalProcessed,
        showsProcessed: userShows.length
      });
    } catch (error) {
      console.error("Error importing episodes:", error);
      res.status(500).json({ error: "Failed to import episodes" });
    }
  });

  // Get user episodes with filtering by status
  app.get("/api/user/episodes", async (req, res) => {
    try {
      const { status } = req.query;
      const userId = "demo-user"; // Mock user ID
      
      const episodes = await storage.getUserEpisodes(userId, status as string);
      res.json(episodes);
    } catch (error) {
      console.error("Error fetching user episodes:", error);
      res.status(500).json({ error: "Failed to fetch user episodes" });
    }
  });

  // Update user episode status
  app.patch("/api/user/episodes/:episodeId", async (req, res) => {
    try {
      const userId = "demo-user"; // Mock user ID
      const { episodeId } = req.params;
      const updates = req.body;

      // Add timestamp fields based on status
      if (updates.status === "watched" && !updates.watchedAt) {
        updates.watchedAt = new Date();
      }
      if (updates.status !== "untriaged" && !updates.triagedAt) {
        updates.triagedAt = new Date();
      }

      const updatedUserEpisode = await storage.updateUserEpisode(userId, parseInt(episodeId), updates);
      if (!updatedUserEpisode) {
        return res.status(404).json({ error: "Episode not found in your collection" });
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
      const userId = "demo-user"; // Mock user ID
      
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
                watchedAt = new Date(episodeScrobble.marked_at);
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

  const httpServer = createServer(app);
  return httpServer;
}
