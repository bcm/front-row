import type { Recommendation } from "@shared/schema";

const TMDB_READ_ACCESS_TOKEN = process.env['tmdb access token'];
const TMDB_BASE_URL = "https://api.themoviedb.org/3";

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

function getAuthHeaders(): HeadersInit {
  return {
    'Authorization': `Bearer ${TMDB_READ_ACCESS_TOKEN}`,
    'Accept': 'application/json',
  };
}

async function fetchGenres(): Promise<Record<number, string>> {
  if (genreCache) return genreCache;
  
  const response = await fetch(
    `${TMDB_BASE_URL}/genre/tv/list`,
    { headers: getAuthHeaders() }
  );
  
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
    const response = await fetch(
      `${TMDB_BASE_URL}/search/tv?query=${encodeURIComponent(showName)}`,
      { headers: getAuthHeaders() }
    );
    
    if (!response.ok) {
      console.error(`TMDB search failed for "${showName}": ${response.statusText}`);
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
    const response = await fetch(
      `${TMDB_BASE_URL}/tv/${tmdbId}/recommendations`,
      { headers: getAuthHeaders() }
    );
    
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
