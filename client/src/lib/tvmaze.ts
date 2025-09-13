export interface TVMazeShow {
  id: number;
  name: string;
  type?: string;
  language?: string;
  genres?: string[];
  status?: string;
  runtime?: number;
  averageRuntime?: number;
  premiered?: string;
  ended?: string;
  officialSite?: string;
  rating?: {
    average?: number;
  };
  network?: {
    id?: number;
    name?: string;
    country?: {
      name?: string;
      code?: string;
      timezone?: string;
    };
  };
  webChannel?: {
    id?: number;
    name?: string;
    country?: {
      name?: string;
      code?: string;
      timezone?: string;
    };
    officialSite?: string;
  };
  schedule?: {
    time?: string;
    days?: string[];
  };
  image?: {
    medium?: string;
    original?: string;
  };
  summary?: string;
  updated?: number;
}

export interface TVMazeSearchResult {
  score: number;
  show: TVMazeShow;
}

export interface TVMazeEpisode {
  id: number;
  name: string;
  season: number;
  number: number;
  airdate?: string;
  runtime?: number;
  rating?: {
    average?: number;
  };
  image?: {
    medium?: string;
    original?: string;
  };
  summary?: string;
}

export class TVMazeAPI {
  private baseURL = '/api';

  async searchShows(query: string): Promise<TVMazeSearchResult[]> {
    const response = await fetch(`${this.baseURL}/shows/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) {
      throw new Error(`Failed to search shows: ${response.statusText}`);
    }
    return response.json();
  }

  async getShow(id: number): Promise<TVMazeShow> {
    const response = await fetch(`${this.baseURL}/shows/${id}`);
    if (!response.ok) {
      throw new Error(`Failed to get show: ${response.statusText}`);
    }
    return response.json();
  }

  async getEpisodes(showId: number): Promise<TVMazeEpisode[]> {
    const response = await fetch(`${this.baseURL}/shows/${showId}/episodes`);
    if (!response.ok) {
      throw new Error(`Failed to get episodes: ${response.statusText}`);
    }
    return response.json();
  }
}

export const tvmaze = new TVMazeAPI();
