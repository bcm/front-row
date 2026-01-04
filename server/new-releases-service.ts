import { storage } from "./storage";
import { type NewReleaseShow } from "@shared/schema";

const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const PREMIERE_WINDOW_DAYS = 30; // Show premieres from last 30 days or future

interface TVMazeUpdate {
  [showId: string]: number; // showId -> timestamp
}

interface TVMazeShow {
  id: number;
  name: string;
  summary: string | null;
  image: { medium?: string; original?: string } | null;
  premiered: string | null;
  genres: string[];
  network: { name: string } | null;
  webChannel: { name: string } | null;
  status: string | null;
}

export async function getNewReleases(userId: string): Promise<{
  shows: NewReleaseShow[];
  lastChecked: Date | null;
  fromCache: boolean;
}> {
  const state = await storage.getNewReleasesState();
  const now = Date.now();
  
  // Check if cache is valid
  if (state?.cachedAt && state.cachedResults) {
    const cacheAge = now - state.cachedAt.getTime();
    if (cacheAge < CACHE_DURATION_MS) {
      // Filter out user's shows and dismissed shows
      const filtered = await filterShowsForUser(userId, state.cachedResults);
      return {
        shows: filtered,
        lastChecked: state.cachedAt,
        fromCache: true
      };
    }
  }

  // Fetch fresh data
  const freshShows = await fetchNewReleases(state?.lastCheckedUnix || 0);
  
  // Update cache
  const newLastCheckedUnix = Math.floor(now / 1000);
  await storage.updateNewReleasesState(newLastCheckedUnix, freshShows);

  // Filter for user
  const filtered = await filterShowsForUser(userId, freshShows);
  
  return {
    shows: filtered,
    lastChecked: new Date(),
    fromCache: false
  };
}

async function fetchNewReleases(sinceUnix: number): Promise<NewReleaseShow[]> {
  try {
    // Fetch TVMaze updates (shows updated since last check)
    const updatesResponse = await fetch('https://api.tvmaze.com/updates/shows');
    if (!updatesResponse.ok) {
      console.error(`[NEW_RELEASES] Failed to fetch updates: ${updatesResponse.status}`);
      return [];
    }

    const updates: TVMazeUpdate = await updatesResponse.json();
    
    // Get cutoff date for "new releases" (premiered within last 30 days or in future)
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - PREMIERE_WINDOW_DAYS);
    const cutoffStr = cutoffDate.toISOString().split('T')[0];
    
    // Filter to shows updated since last check
    const recentlyUpdatedShowIds = Object.entries(updates)
      .filter(([_, timestamp]) => timestamp > sinceUnix)
      .map(([showId, _]) => parseInt(showId))
      .slice(0, 200); // Limit to avoid too many API calls

    console.log(`[NEW_RELEASES] Found ${recentlyUpdatedShowIds.length} recently updated shows`);

    // Fetch show details and filter by premiere date
    const newReleases: NewReleaseShow[] = [];
    
    // Batch fetch shows (TVMaze rate limit is generous but let's be nice)
    for (let i = 0; i < recentlyUpdatedShowIds.length; i += 20) {
      const batch = recentlyUpdatedShowIds.slice(i, i + 20);
      
      const batchPromises = batch.map(async (showId) => {
        try {
          const response = await fetch(`https://api.tvmaze.com/shows/${showId}`);
          if (!response.ok) return null;
          
          const show: TVMazeShow = await response.json();
          
          // Filter by premiere date (recent or future premieres only)
          if (!show.premiered) return null;
          if (show.premiered < cutoffStr) return null;
          
          // Only include scripted/animated shows, skip news/talk shows
          if (show.status === 'Ended' && new Date(show.premiered) < cutoffDate) return null;
          
          return {
            id: show.id,
            name: show.name,
            summary: show.summary,
            image: show.image,
            premiered: show.premiered,
            genres: show.genres || [],
            network: show.network?.name || null,
            webChannel: show.webChannel?.name || null,
            status: show.status
          } as NewReleaseShow;
        } catch (error) {
          return null;
        }
      });

      const results = await Promise.all(batchPromises);
      results.forEach(show => {
        if (show) newReleases.push(show);
      });

      // Small delay between batches to be nice to TVMaze API
      if (i + 20 < recentlyUpdatedShowIds.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    // Sort by premiere date (newest first)
    newReleases.sort((a, b) => {
      if (!a.premiered) return 1;
      if (!b.premiered) return -1;
      return b.premiered.localeCompare(a.premiered);
    });

    console.log(`[NEW_RELEASES] Found ${newReleases.length} new releases after filtering`);
    return newReleases;

  } catch (error) {
    console.error('[NEW_RELEASES] Error fetching new releases:', error);
    return [];
  }
}

async function filterShowsForUser(userId: string, shows: NewReleaseShow[]): Promise<NewReleaseShow[]> {
  // Get user's library show IDs
  const userShowIds = new Set(await storage.getUserShowIds(userId));
  
  // Get dismissed show IDs
  const dismissed = await storage.getDismissedNewReleases(userId);
  const dismissedIds = new Set(dismissed.map(d => d.tvmazeId));
  
  // Filter out shows already in library or dismissed
  return shows.filter(show => 
    !userShowIds.has(show.id) && !dismissedIds.has(show.id)
  );
}

export async function refreshNewReleases(): Promise<NewReleaseShow[]> {
  // Force refresh by clearing cache timestamp
  const freshShows = await fetchNewReleases(0);
  const now = Math.floor(Date.now() / 1000);
  await storage.updateNewReleasesState(now, freshShows);
  return freshShows;
}
