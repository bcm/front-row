import { type User, type InsertUser, type Show, type InsertShow, type UserShow, type InsertUserShow, type Episode, type InsertEpisode } from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Show methods
  getShow(id: number): Promise<Show | undefined>;
  createShow(show: InsertShow): Promise<Show>;
  updateShow(id: number, show: Partial<InsertShow>): Promise<Show | undefined>;
  searchShows(query: string): Promise<Show[]>;
  
  // User show methods
  getUserShows(userId: string, status?: string): Promise<(UserShow & { show: Show })[]>;
  getUserShow(userId: string, showId: number): Promise<UserShow | undefined>;
  addUserShow(userShow: InsertUserShow): Promise<UserShow>;
  updateUserShow(userId: string, showId: number, updates: Partial<UserShow>): Promise<UserShow | undefined>;
  removeUserShow(userId: string, showId: number): Promise<boolean>;
  
  // Episode methods
  getEpisodes(showId: number): Promise<Episode[]>;
  createEpisode(episode: InsertEpisode): Promise<Episode>;
  getLatestEpisodes(showIds: number[]): Promise<Episode[]>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private shows: Map<number, Show>;
  private userShows: Map<string, UserShow>;
  private episodes: Map<number, Episode>;

  constructor() {
    this.users = new Map();
    this.shows = new Map();
    this.userShows = new Map();
    this.episodes = new Map();
  }

  // User methods
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  // Show methods
  async getShow(id: number): Promise<Show | undefined> {
    return this.shows.get(id);
  }

  async createShow(show: InsertShow): Promise<Show> {
    const newShow: Show = { 
      ...show,
      summary: show.summary ?? null,
      image: show.image ? {
        medium: typeof show.image.medium === 'string' ? show.image.medium : undefined,
        original: typeof show.image.original === 'string' ? show.image.original : undefined
      } : null,
      network: show.network ? {
        name: typeof (show.network as any).name === 'string' ? (show.network as any).name : undefined,
        country: show.network.country ? {
          name: typeof (show.network as any).country?.name === 'string' ? (show.network as any).country.name : undefined
        } : undefined
      } : null,
      genres: show.genres ?? [],
      status: show.status ?? null,
      premiered: show.premiered ?? null,
      rating: show.rating ? {
        average: typeof (show.rating as any).average === 'number' ? (show.rating as any).average : undefined
      } : null,
      runtime: show.runtime ?? null,
      officialSite: show.officialSite ?? null,
      language: show.language ?? null,
      type: show.type ?? null,
      updated: show.updated ?? null,
      createdAt: new Date()
    };
    this.shows.set(show.id, newShow);
    return newShow;
  }

  async updateShow(id: number, updates: Partial<InsertShow>): Promise<Show | undefined> {
    const existingShow = this.shows.get(id);
    if (!existingShow) return undefined;
    
    const updatedShow = { 
      ...existingShow, 
      ...updates,
      summary: updates.summary !== undefined ? updates.summary : existingShow.summary,
      image: updates.image !== undefined ? (updates.image ? {
        medium: typeof (updates.image as any).medium === 'string' ? (updates.image as any).medium : undefined,
        original: typeof (updates.image as any).original === 'string' ? (updates.image as any).original : undefined
      } : null) : existingShow.image,
      network: updates.network !== undefined ? (updates.network ? {
        name: typeof (updates.network as any).name === 'string' ? (updates.network as any).name : undefined,
        country: (updates.network as any).country && typeof (updates.network as any).country === 'object' ? {
          name: typeof (updates.network as any).country?.name === 'string' ? (updates.network as any).country.name : undefined
        } : undefined
      } : null) : existingShow.network,
      rating: updates.rating !== undefined ? (updates.rating ? {
        average: typeof (updates.rating as any).average === 'number' ? (updates.rating as any).average : undefined
      } : null) : existingShow.rating
    };
    this.shows.set(id, updatedShow);
    return updatedShow;
  }

  async searchShows(query: string): Promise<Show[]> {
    const searchTerm = query.toLowerCase();
    return Array.from(this.shows.values()).filter(show =>
      show.name.toLowerCase().includes(searchTerm) ||
      (show.genres && show.genres.some(genre => genre.toLowerCase().includes(searchTerm)))
    );
  }

  // User show methods
  async getUserShows(userId: string, status?: string): Promise<(UserShow & { show: Show })[]> {
    const userShowsArray = Array.from(this.userShows.values())
      .filter(us => us.userId === userId && (!status || us.status === status))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    
    const result = [];
    for (const userShow of userShowsArray) {
      const show = this.shows.get(userShow.showId);
      if (show) {
        result.push({ ...userShow, show });
      }
    }
    return result;
  }

  async getUserShow(userId: string, showId: number): Promise<UserShow | undefined> {
    return Array.from(this.userShows.values()).find(
      us => us.userId === userId && us.showId === showId
    );
  }

  async addUserShow(userShow: InsertUserShow): Promise<UserShow> {
    const id = randomUUID();
    const newUserShow: UserShow = {
      ...userShow,
      id,
      priority: userShow.priority ?? null,
      currentSeason: userShow.currentSeason ?? null,
      currentEpisode: userShow.currentEpisode ?? null,
      isShared: userShow.isShared ?? null,
      addedAt: new Date(),
      watchedAt: null,
    };
    this.userShows.set(id, newUserShow);
    return newUserShow;
  }

  async updateUserShow(userId: string, showId: number, updates: Partial<UserShow>): Promise<UserShow | undefined> {
    const userShow = Array.from(this.userShows.values()).find(
      us => us.userId === userId && us.showId === showId
    );
    
    if (!userShow) return undefined;
    
    const updatedUserShow = { ...userShow, ...updates };
    this.userShows.set(userShow.id, updatedUserShow);
    return updatedUserShow;
  }

  async removeUserShow(userId: string, showId: number): Promise<boolean> {
    const userShow = Array.from(this.userShows.values()).find(
      us => us.userId === userId && us.showId === showId
    );
    
    if (!userShow) return false;
    
    this.userShows.delete(userShow.id);
    return true;
  }

  // Episode methods
  async getEpisodes(showId: number): Promise<Episode[]> {
    return Array.from(this.episodes.values()).filter(ep => ep.showId === showId);
  }

  async createEpisode(episode: InsertEpisode): Promise<Episode> {
    const newEpisode: Episode = {
      ...episode,
      name: episode.name ?? null,
      season: episode.season ?? null,
      number: episode.number ?? null,
      airdate: episode.airdate ?? null,
      runtime: episode.runtime ?? null,
      summary: episode.summary ?? null,
      image: episode.image ? {
        medium: typeof episode.image.medium === 'string' ? episode.image.medium : undefined,
        original: typeof episode.image.original === 'string' ? episode.image.original : undefined
      } : null
    };
    this.episodes.set(episode.id, newEpisode);
    return newEpisode;
  }

  async getLatestEpisodes(showIds: number[]): Promise<Episode[]> {
    const episodes = Array.from(this.episodes.values())
      .filter(ep => showIds.includes(ep.showId))
      .sort((a, b) => (b.airdate || '').localeCompare(a.airdate || ''));
    
    // Get the latest episode for each show
    const latestByShow = new Map<number, Episode>();
    for (const episode of episodes) {
      if (!latestByShow.has(episode.showId)) {
        latestByShow.set(episode.showId, episode);
      }
    }
    
    return Array.from(latestByShow.values());
  }
}

export const storage = new MemStorage();
