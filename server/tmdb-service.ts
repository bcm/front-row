import type { Recommendation } from "@shared/schema";

const TMDB_API_KEY = process.env['tmdb access token'] || process.env.TMDB_API_KEY;
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

const isV4Token = TMDB_API_KEY?.startsWith('eyJ');
const authMethod = isV4Token ? 'v4 bearer token' : 'v3 API key';
const secretSource = process.env['tmdb access token'] ? '"tmdb access token"' : 'TMDB_API_KEY';

if (!TMDB_API_KEY) {
  console.error('[TMDB] WARNING: No TMDB credentials found');
  console.error('[TMDB] Available TMDB env keys:', Object.keys(process.env).filter(k => k.toLowerCase().includes('tmdb')));
} else {
  console.log(`[TMDB] Authentication configured using ${authMethod} from ${secretSource} secret`);
}

interface TMDBSearchResult {
  id: number;
  name: string;
  overview: string;
  poster_path: string | null;
  backdrop_path: string | null;
  vote_average: number;
  vote_count: number;
  genre_ids: number[];
  first_air_date: string;
}

interface TMDBRecommendationResult {
  results: TMDBSearchResult[];
}

interface TMDBGenre {
  id: number;
  name: string;
}

let genreCache: Record<number, string> | null = null;

function buildFetchOptions(url: string): { url: string; options: RequestInit } {
  if (isV4Token) {
    return {
      url,
      options: {
        headers: {
          'Authorization': `Bearer ${TMDB_API_KEY}`,
          'Accept': 'application/json',
        }
      }
    };
  } else {
    const separator = url.includes('?') ? '&' : '?';
    return {
      url: `${url}${separator}api_key=${TMDB_API_KEY}`,
      options: {
        headers: {
          'Accept': 'application/json',
        }
      }
    };
  }
}

async function fetchGenres(): Promise<Record<number, string>> {
  if (genreCache) return genreCache;
  
  const { url, options } = buildFetchOptions(`${TMDB_BASE_URL}/genre/tv/list`);
  const response = await fetch(url, options);
  
  if (!response.ok) {
    throw new Error(`TMDB API error: ${response.statusText}`);
  }
  
  const data = await response.json();
  genreCache = Object.fromEntries(
    data.genres.map((g: TMDBGenre) => [g.id, g.name])
  );
  
  return genreCache;
}

export async function searchTMDBShow(showName: string): Promise<number | null> {
  try {
    const { url, options } = buildFetchOptions(
      `${TMDB_BASE_URL}/search/tv?query=${encodeURIComponent(showName)}`
    );
    const response = await fetch(url, options);
    
    if (!response.ok) {
      if (response.status === 401) {
        const errorBody = await response.text();
        console.error(`[TMDB] Authentication failed. Please check your TMDB API key/token.`);
        console.error(`[TMDB] Error details:`, errorBody);
      } else {
        console.error(`TMDB search failed for "${showName}": ${response.statusText}`);
      }
      return null;
    }
    
    const data = await response.json();
    
    if (data.results && data.results.length > 0) {
      return data.results[0].id;
    }
    
    return null;
  } catch (error) {
    console.error(`Error searching TMDB for "${showName}":`, error);
    return null;
  }
}

export async function getTMDBRecommendations(tmdbId: number): Promise<TMDBSearchResult[]> {
  try {
    const { url, options } = buildFetchOptions(
      `${TMDB_BASE_URL}/tv/${tmdbId}/recommendations`
    );
    const response = await fetch(url, options);
    
    if (!response.ok) {
      console.error(`TMDB recommendations failed for ID ${tmdbId}: ${response.statusText}`);
      return [];
    }
    
    const data: TMDBRecommendationResult = await response.json();
    return data.results || [];
  } catch (error) {
    console.error(`Error fetching TMDB recommendations for ID ${tmdbId}:`, error);
    return [];
  }
}

export async function aggregateRecommendations(
  tmdbIds: number[],
  userGenres: string[]
): Promise<Map<number, { show: TMDBSearchResult; score: number; sources: number[] }>> {
  const genreMap = await fetchGenres();
  const recommendationMap = new Map<number, { show: TMDBSearchResult; score: number; sources: number[] }>();
  
  for (const tmdbId of tmdbIds) {
    const recommendations = await getTMDBRecommendations(tmdbId);
    
    for (const rec of recommendations) {
      if (!recommendationMap.has(rec.id)) {
        const genres = rec.genre_ids.map(id => genreMap[id] || "Unknown");
        const genreMatchScore = genres.filter(g => userGenres.includes(g)).length;
        
        const frequencyScore = 1;
        const qualityScore = Math.round(rec.vote_average * 10);
        const genreScore = genreMatchScore * 20;
        
        const totalScore = frequencyScore + qualityScore + genreScore;
        
        recommendationMap.set(rec.id, {
          show: rec,
          score: totalScore,
          sources: [tmdbId]
        });
      } else {
        const existing = recommendationMap.get(rec.id)!;
        existing.sources.push(tmdbId);
        existing.score += 1;
      }
    }
  }
  
  return recommendationMap;
}

export async function convertTMDBResultToRecommendation(
  userId: string,
  tmdbId: number,
  result: TMDBSearchResult,
  score: number,
  sources: number[]
): Promise<Omit<Recommendation, 'id' | 'createdAt' | 'refreshedAt'>> {
  const genreMap = await fetchGenres();
  const genres = result.genre_ids.map(id => genreMap[id] || "Unknown");
  
  return {
    userId,
    tmdbId,
    name: result.name,
    overview: result.overview || null,
    posterPath: result.poster_path || null,
    backdropPath: result.backdrop_path || null,
    voteAverage: Math.round(result.vote_average * 10) || null,
    voteCount: result.vote_count || null,
    genres,
    firstAirDate: result.first_air_date || null,
    score,
    sourceShowIds: sources.map(String),
  };
}
