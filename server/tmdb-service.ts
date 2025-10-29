import type { Recommendation } from "@shared/schema";

const TMDB_API_KEY = process.env.TMDB_ACCESS_TOKEN;
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

const isV4Token = TMDB_API_KEY?.startsWith('eyJ');
const authMethod = isV4Token ? 'v4 bearer token' : 'v3 API key';

if (!TMDB_API_KEY) {
  console.error('[TMDB] WARNING: TMDB_ACCESS_TOKEN secret not found');
} else {
  console.log(`[TMDB] Authentication configured using ${authMethod} from TMDB_ACCESS_TOKEN secret`);
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
  userGenres: string[],
  engagedTmdbIds: number[] = []
): Promise<Map<number, { show: TMDBSearchResult; score: number; sources: number[] }>> {
  const genreMap = await fetchGenres();
  const recommendationMap = new Map<number, { show: TMDBSearchResult; score: number; sources: number[] }>();
  const engagedSet = new Set(engagedTmdbIds);
  
  for (const tmdbId of tmdbIds) {
    const recommendations = await getTMDBRecommendations(tmdbId);
    const isEngagedShow = engagedSet.has(tmdbId);
    
    for (const rec of recommendations) {
      if (!recommendationMap.has(rec.id)) {
        const genres = rec.genre_ids.map(id => genreMap[id] || "Unknown");
        const genreMatchScore = genres.filter(g => userGenres.includes(g)).length;
        
        const frequencyScore = 1;
        const qualityScore = Math.round(rec.vote_average * 10);
        const genreScore = genreMatchScore * 20;
        
        let totalScore = frequencyScore + qualityScore + genreScore;
        
        // Apply 2x multiplier if this recommendation comes from an engaged show
        if (isEngagedShow) {
          totalScore *= 2;
        }
        
        recommendationMap.set(rec.id, {
          show: rec,
          score: totalScore,
          sources: [tmdbId]
        });
      } else {
        const existing = recommendationMap.get(rec.id)!;
        existing.sources.push(tmdbId);
        
        // Add frequency bonus (1 point per additional source)
        let bonusScore = 1;
        
        // If this additional source is engaged, apply 2x multiplier to the bonus
        if (isEngagedShow) {
          bonusScore *= 2;
        }
        
        existing.score += bonusScore;
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
