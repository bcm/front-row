import { type User, type InsertUser, type Show, type InsertShow, type UserShow, type InsertUserShow, type Episode, type InsertEpisode, type UserEpisode, type InsertUserEpisode } from "@shared/schema";
import { users, shows, userShows, episodes, userEpisodes } from "@shared/schema";
import { db } from "./db";
import { eq, and, ilike, inArray, desc, asc } from "drizzle-orm";
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
  
  // User episode methods
  getUserEpisodes(userId: string, status?: string): Promise<(UserEpisode & { episode: Episode & { show: Show } })[]>;
  addUserEpisode(userEpisode: InsertUserEpisode): Promise<UserEpisode>;
  updateUserEpisode(userId: string, episodeId: number, updates: Partial<UserEpisode>): Promise<UserEpisode | undefined>;
  getUserEpisode(userId: string, episodeId: number): Promise<UserEpisode | undefined>;
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

  // User episode methods (stub implementations - not used in production)
  async getUserEpisodes(userId: string, status?: string): Promise<(UserEpisode & { episode: Episode & { show: Show } })[]> {
    return []; // Stub implementation
  }

  async getUserEpisode(userId: string, episodeId: number): Promise<UserEpisode | undefined> {
    return undefined; // Stub implementation
  }

  async addUserEpisode(userEpisode: InsertUserEpisode): Promise<UserEpisode> {
    throw new Error("MemStorage user episode methods not implemented");
  }

  async updateUserEpisode(userId: string, episodeId: number, updates: Partial<UserEpisode>): Promise<UserEpisode | undefined> {
    throw new Error("MemStorage user episode methods not implemented");
  }
}

export class DatabaseStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db
      .insert(users)
      .values([insertUser])
      .returning();
    return user;
  }

  // Show methods
  async getShow(id: number): Promise<Show | undefined> {
    const [show] = await db.select().from(shows).where(eq(shows.id, id));
    return show || undefined;
  }

  async createShow(show: InsertShow): Promise<Show> {
    const showData = {
      ...show,
      image: show.image as { medium?: string; original?: string } | null,
      network: show.network as { name?: string; country?: { name?: string } } | null,
      rating: show.rating as { average?: number } | null
    };
    const [newShow] = await db
      .insert(shows)
      .values([showData])
      .onConflictDoUpdate({
        target: shows.id,
        set: showData
      })
      .returning();
    return newShow;
  }

  async updateShow(id: number, updates: Partial<InsertShow>): Promise<Show | undefined> {
    const updateData: any = { ...updates };
    if (updates.image !== undefined) {
      updateData.image = updates.image as { medium?: string; original?: string } | null;
    }
    if (updates.network !== undefined) {
      updateData.network = updates.network as { name?: string; country?: { name?: string } } | null;
    }
    if (updates.rating !== undefined) {
      updateData.rating = updates.rating as { average?: number } | null;
    }
    const [updatedShow] = await db
      .update(shows)
      .set(updateData)
      .where(eq(shows.id, id))
      .returning();
    return updatedShow || undefined;
  }

  async searchShows(query: string): Promise<Show[]> {
    return await db
      .select()
      .from(shows)
      .where(ilike(shows.name, `%${query}%`));
  }

  // User show methods
  async getUserShows(userId: string, status?: string): Promise<(UserShow & { show: Show })[]> {
    const whereClause = status 
      ? and(eq(userShows.userId, userId), eq(userShows.status, status))
      : eq(userShows.userId, userId);

    const results = await db
      .select({
        id: userShows.id,
        userId: userShows.userId,
        showId: userShows.showId,
        status: userShows.status,
        priority: userShows.priority,
        currentSeason: userShows.currentSeason,
        currentEpisode: userShows.currentEpisode,
        isShared: userShows.isShared,
        addedAt: userShows.addedAt,
        watchedAt: userShows.watchedAt,
        show: shows
      })
      .from(userShows)
      .innerJoin(shows, eq(userShows.showId, shows.id))
      .where(whereClause)
      .orderBy(asc(shows.name));

    return results.map(row => ({
      id: row.id,
      userId: row.userId,
      showId: row.showId,
      status: row.status,
      priority: row.priority,
      currentSeason: row.currentSeason,
      currentEpisode: row.currentEpisode,
      isShared: row.isShared,
      addedAt: row.addedAt,
      watchedAt: row.watchedAt,
      show: row.show
    }));
  }

  async getUserShow(userId: string, showId: number): Promise<UserShow | undefined> {
    const [userShow] = await db
      .select()
      .from(userShows)
      .where(and(eq(userShows.userId, userId), eq(userShows.showId, showId)));
    return userShow || undefined;
  }

  async addUserShow(userShow: InsertUserShow): Promise<UserShow> {
    const [newUserShow] = await db
      .insert(userShows)
      .values([userShow])
      .returning();
    return newUserShow;
  }

  async updateUserShow(userId: string, showId: number, updates: Partial<UserShow>): Promise<UserShow | undefined> {
    const [updatedUserShow] = await db
      .update(userShows)
      .set(updates)
      .where(and(eq(userShows.userId, userId), eq(userShows.showId, showId)))
      .returning();
    return updatedUserShow || undefined;
  }

  async removeUserShow(userId: string, showId: number): Promise<boolean> {
    const result = await db
      .delete(userShows)
      .where(and(eq(userShows.userId, userId), eq(userShows.showId, showId)))
      .returning({ id: userShows.id });
    return result.length > 0;
  }

  // Episode methods
  async getEpisodes(showId: number): Promise<Episode[]> {
    return await db
      .select()
      .from(episodes)
      .where(eq(episodes.showId, showId));
  }

  async createEpisode(episode: InsertEpisode): Promise<Episode> {
    const episodeData = {
      ...episode,
      image: episode.image as { medium?: string; original?: string } | null
    };
    const [newEpisode] = await db
      .insert(episodes)
      .values([episodeData])
      .onConflictDoUpdate({
        target: episodes.id,
        set: episodeData
      })
      .returning();
    return newEpisode;
  }

  async getLatestEpisodes(showIds: number[]): Promise<Episode[]> {
    if (showIds.length === 0) return [];
    
    // Get all episodes for the specified shows, ordered by airdate descending
    const allEpisodes = await db
      .select()
      .from(episodes)
      .where(inArray(episodes.showId, showIds))
      .orderBy(desc(episodes.airdate));
    
    // Get the latest episode for each show (like MemStorage does)
    const latestByShow = new Map<number, Episode>();
    for (const episode of allEpisodes) {
      if (!latestByShow.has(episode.showId)) {
        latestByShow.set(episode.showId, episode);
      }
    }
    
    return Array.from(latestByShow.values());
  }

  // User episode methods
  async getUserEpisodes(userId: string, status?: string): Promise<(UserEpisode & { episode: Episode & { show: Show } })[]> {
    const whereClause = status 
      ? and(eq(userEpisodes.userId, userId), eq(userEpisodes.status, status))
      : eq(userEpisodes.userId, userId);

    const results = await db
      .select({
        id: userEpisodes.id,
        userId: userEpisodes.userId,
        episodeId: userEpisodes.episodeId,
        status: userEpisodes.status,
        watchedAt: userEpisodes.watchedAt,
        triagedAt: userEpisodes.triagedAt,
        addedAt: userEpisodes.addedAt,
        episode: episodes,
        show: shows
      })
      .from(userEpisodes)
      .innerJoin(episodes, eq(userEpisodes.episodeId, episodes.id))
      .innerJoin(shows, eq(episodes.showId, shows.id))
      .where(whereClause)
      .orderBy(desc(episodes.airdate));

    return results.map(row => ({
      id: row.id,
      userId: row.userId,
      episodeId: row.episodeId,
      status: row.status,
      watchedAt: row.watchedAt,
      triagedAt: row.triagedAt,
      addedAt: row.addedAt,
      episode: {
        ...row.episode,
        show: row.show
      }
    }));
  }

  async getUserEpisode(userId: string, episodeId: number): Promise<UserEpisode | undefined> {
    const [userEpisode] = await db
      .select()
      .from(userEpisodes)
      .where(and(eq(userEpisodes.userId, userId), eq(userEpisodes.episodeId, episodeId)));
    return userEpisode || undefined;
  }

  async addUserEpisode(userEpisode: InsertUserEpisode): Promise<UserEpisode> {
    const [newUserEpisode] = await db
      .insert(userEpisodes)
      .values([userEpisode])
      .onConflictDoNothing({
        target: [userEpisodes.userId, userEpisodes.episodeId],
      })
      .returning();
    
    // If no row was inserted (conflict), fetch the existing one
    if (!newUserEpisode) {
      const [existingUserEpisode] = await db
        .select()
        .from(userEpisodes)
        .where(and(eq(userEpisodes.userId, userEpisode.userId), eq(userEpisodes.episodeId, userEpisode.episodeId)));
      return existingUserEpisode;
    }
    
    return newUserEpisode;
  }

  async updateUserEpisode(userId: string, episodeId: number, updates: Partial<UserEpisode>): Promise<UserEpisode | undefined> {
    const [updatedUserEpisode] = await db
      .update(userEpisodes)
      .set(updates)
      .where(and(eq(userEpisodes.userId, userId), eq(userEpisodes.episodeId, episodeId)))
      .returning();
    return updatedUserEpisode || undefined;
  }
}

export const storage = new DatabaseStorage();
