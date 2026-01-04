import { storage } from "./storage";
import { type NewReleaseShow } from "@shared/schema";

const CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const DAYS_BACK = 30; // Look back 30 days
const DAYS_FORWARD = 14; // Look forward 14 days

interface TVMazeScheduleItem {
  id: number;
  airdate: string;
  airstamp: string;
  season: number;
  number: number;
  show: {
    id: number;
    name: string;
    summary: string | null;
    image: { medium?: string; original?: string } | null;
    premiered: string | null;
    genres: string[];
    network: { name: string } | null;
    webChannel: { name: string } | null;
    status: string | null;
  };
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
  const freshShows = await fetchNewReleases();
  
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

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

async function fetchScheduleForDate(date: string, isWeb: boolean = false): Promise<TVMazeScheduleItem[]> {
  try {
    const endpoint = isWeb 
      ? `https://api.tvmaze.com/schedule/web?date=${date}`
      : `https://api.tvmaze.com/schedule?date=${date}`;
    
    const response = await fetch(endpoint);
    if (!response.ok) return [];
    
    return await response.json();
  } catch {
    return [];
  }
}

async function fetchNewReleases(): Promise<NewReleaseShow[]> {
  try {
    const today = new Date();
    const seenShowIds = new Set<number>();
    const newReleases: NewReleaseShow[] = [];

    // Generate date range: past 30 days + next 14 days
    const dates: string[] = [];
    for (let i = -DAYS_BACK; i <= DAYS_FORWARD; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() + i);
      dates.push(formatDate(date));
    }

    console.log(`[NEW_RELEASES] Checking ${dates.length} days for new show premieres...`);

    // Fetch schedules in parallel batches (to respect rate limits)
    const batchSize = 5;
    for (let i = 0; i < dates.length; i += batchSize) {
      const batch = dates.slice(i, i + batchSize);
      
      const batchPromises = batch.flatMap(date => [
        fetchScheduleForDate(date, false), // Regular TV
        fetchScheduleForDate(date, true)   // Web/streaming
      ]);

      const results = await Promise.all(batchPromises);
      
      for (const scheduleItems of results) {
        for (const item of scheduleItems) {
          // Web schedule has _embedded.show, regular schedule has show directly
          const show = item.show || (item as any)._embedded?.show;
          if (!show) continue;
          
          // Only include Season 1, Episode 1 (true series premieres)
          if (item.season !== 1 || item.number !== 1) continue;
          
          // Skip if we've already seen this show
          if (seenShowIds.has(show.id)) continue;
          seenShowIds.add(show.id);

          // Skip shows without images (usually low-quality entries)
          if (!show.image?.medium) continue;

          newReleases.push({
            id: show.id,
            name: show.name,
            summary: show.summary,
            image: show.image,
            premiered: show.premiered || item.airdate,
            genres: show.genres || [],
            network: show.network?.name || null,
            webChannel: show.webChannel?.name || null,
            status: show.status
          } as NewReleaseShow);
        }
      }

      // Small delay between batches to be nice to TVMaze API
      if (i + batchSize < dates.length) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }

    // Sort by premiere date (newest/upcoming first)
    newReleases.sort((a, b) => {
      if (!a.premiered) return 1;
      if (!b.premiered) return -1;
      return b.premiered.localeCompare(a.premiered);
    });

    console.log(`[NEW_RELEASES] Found ${newReleases.length} new show premieres`);
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
  // Force refresh by fetching fresh data
  const freshShows = await fetchNewReleases();
  const now = Math.floor(Date.now() / 1000);
  await storage.updateNewReleasesState(now, freshShows);
  return freshShows;
}
