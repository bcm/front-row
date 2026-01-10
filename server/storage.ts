import { type User, type UpsertUser, type Show, type InsertShow, type UserShow, type InsertUserShow, type Episode, type InsertEpisode, type UserEpisode, type InsertUserEpisode, type UserSettings, type InsertUserSettings, type Recommendation, type InsertRecommendation, type DismissedRecommendation, type InsertDismissedRecommendation, type NewReleasesState, type NewReleaseShow, type DismissedNewRelease, type InsertDismissedNewRelease, type Group, type InsertGroup, type GroupMember, type InsertGroupMember, type GroupInvite, type InsertGroupInvite } from "@shared/schema";
import { users, shows, userShows, episodes, userEpisodes, userSettings, recommendations, dismissedRecommendations, newReleasesState, dismissedNewReleases, groups, groupMembers, groupInvites } from "@shared/schema";
import { db } from "./db";
import { eq, and, ilike, inArray, desc, asc, lte, gt, sql, or, isNull } from "drizzle-orm";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: UpsertUser): Promise<User>;
  
  // Show methods
  getShow(id: number): Promise<Show | undefined>;
  createShow(show: InsertShow): Promise<Show>;
  updateShow(id: number, show: Partial<InsertShow>): Promise<Show | undefined>;
  syncShowFromTVMaze(showId: number): Promise<Show | undefined>;
  searchShows(query: string): Promise<Show[]>;
  searchUserShows(userId: string, query: string, includeRemoved?: boolean): Promise<Show[]>;
  
  // User show methods
  getUserShows(userId: string, includeRemoved?: boolean): Promise<(UserShow & { show: Show })[]>;
  getUserShow(userId: string, showId: number): Promise<UserShow | undefined>;
  addUserShow(userShow: InsertUserShow): Promise<UserShow>;
  updateUserShow(userId: string, showId: number, updates: Partial<UserShow>): Promise<UserShow | undefined>;
  removeUserShow(userId: string, showId: number): Promise<boolean>;
  softRemoveUserShow(userId: string, showId: number): Promise<UserShow | undefined>;
  getGroupShows(groupId: string): Promise<(UserShow & { show: Show })[]>;
  
  // Episode methods
  getEpisodes(showId: number): Promise<Episode[]>;
  getEpisode(episodeId: number): Promise<Episode | undefined>;
  getEpisodeWithShowAndUserData(userId: string, episodeId: number): Promise<(Episode & { show: Show; userEpisode?: UserEpisode }) | undefined>;
  createEpisode(episode: InsertEpisode): Promise<Episode>;
  getLatestEpisodes(showIds: number[]): Promise<Episode[]>;
  searchUserEpisodes(userId: string, query: string): Promise<(Episode & { show: Show })[]>;
  
  // User episode methods
  getUserEpisodes(userId: string, status?: string, showMode?: string, groupIds?: string[]): Promise<(UserEpisode & { episode: Episode & { show: Show }; groupId?: string | null })[]>;
  getUpcomingEpisodes(userId: string, showMode?: string, groupIds?: string[]): Promise<(Episode & { show: Show; groupId?: string | null })[]>;
  getUserGroupIds(userId: string): Promise<string[]>;
  addUserEpisode(userEpisode: InsertUserEpisode): Promise<{ episode: UserEpisode; isNew: boolean }>;
  updateUserEpisode(userId: string, episodeId: number, updates: Partial<UserEpisode>): Promise<UserEpisode | undefined>;
  getUserEpisode(userId: string, episodeId: number): Promise<UserEpisode | undefined>;
  
  // User settings methods
  getUserSettings(userId: string): Promise<UserSettings | undefined>;
  createUserSettings(userSettings: InsertUserSettings): Promise<UserSettings>;
  updateUserSettings(userId: string, settings: Partial<UserSettings>): Promise<UserSettings | undefined>;
  
  // Recommendation methods
  getRecommendations(userId: string, limit?: number): Promise<Recommendation[]>;
  createRecommendations(recs: InsertRecommendation[]): Promise<void>;
  clearRecommendations(userId: string): Promise<void>;
  dismissRecommendation(userId: string, tmdbId: number): Promise<void>;
  getDismissedRecommendations(userId: string): Promise<DismissedRecommendation[]>;
  updateShowTmdbId(showId: number, tmdbId: number): Promise<void>;
  
  // New releases methods
  getNewReleasesState(): Promise<NewReleasesState | undefined>;
  updateNewReleasesState(lastCheckedUnix: number, cachedResults: NewReleaseShow[]): Promise<void>;
  getDismissedNewReleases(userId: string): Promise<DismissedNewRelease[]>;
  dismissNewRelease(userId: string, tvmazeId: number): Promise<void>;
  getUserShowIds(userId: string): Promise<number[]>;
  
  // Group methods
  createGroup(group: InsertGroup): Promise<Group>;
  getGroup(groupId: string): Promise<Group | undefined>;
  getUserGroups(userId: string): Promise<(Group & { memberCount: number })[]>;
  updateGroup(groupId: string, updates: Partial<Group>): Promise<Group | undefined>;
  deleteGroup(groupId: string): Promise<boolean>;
  
  // Group member methods
  addGroupMember(member: InsertGroupMember): Promise<GroupMember>;
  getGroupMembers(groupId: string): Promise<(GroupMember & { user: User })[]>;
  isGroupMember(groupId: string, userId: string): Promise<boolean>;
  removeGroupMember(groupId: string, userId: string): Promise<boolean>;
  
  // Group invite methods
  createGroupInvite(invite: InsertGroupInvite): Promise<GroupInvite>;
  getGroupInvite(inviteCode: string): Promise<GroupInvite | undefined>;
  getGroupInvitesByEmail(email: string): Promise<(GroupInvite & { group: Group })[]>;
  getPendingInvitesForGroup(groupId: string): Promise<GroupInvite[]>;
  useGroupInvite(inviteCode: string, userId: string): Promise<GroupInvite | undefined>;
  deleteGroupInvite(inviteId: string): Promise<boolean>;
}


export class DatabaseStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: UpsertUser): Promise<User> {
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
      webChannel: show.webChannel as { name?: string; country?: { name?: string }; officialSite?: string } | null,
      rating: show.rating as { average?: number } | null,
      schedule: show.schedule as { time?: string; days?: string[] } | null
    };
    const [newShow] = await db
      .insert(shows)
      .values([showData])
      .onConflictDoUpdate({
        target: shows.id,
        set: {
          name: showData.name,
          summary: showData.summary,
          image: showData.image,
          network: showData.network,
          webChannel: showData.webChannel,
          genres: showData.genres,
          status: showData.status,
          premiered: showData.premiered,
          ended: showData.ended,
          rating: showData.rating,
          runtime: showData.runtime,
          averageRuntime: showData.averageRuntime,
          schedule: showData.schedule,
          officialSite: showData.officialSite,
          language: showData.language,
          type: showData.type,
          updated: showData.updated
        }
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

  async syncShowFromTVMaze(showId: number): Promise<Show | undefined> {
    try {
      // Fetch detailed show data from TVMaze API
      const response = await fetch(`https://api.tvmaze.com/shows/${showId}`);
      if (!response.ok) {
        if (response.status === 404) {
          return undefined;
        }
        throw new Error(`TVMaze API error: ${response.status}`);
      }

      const tvmazeShow = await response.json();
      
      // Prepare show data from TVMaze (use upsert to insert or update)
      const showData = {
        id: showId,
        name: tvmazeShow.name,
        summary: tvmazeShow.summary,
        image: tvmazeShow.image as { medium?: string; original?: string } | null,
        network: tvmazeShow.network as { name?: string; country?: { name?: string } } | null,
        webChannel: tvmazeShow.webChannel ? {
          name: tvmazeShow.webChannel.name as string | undefined,
          country: tvmazeShow.webChannel.country as { name?: string } | undefined,
          officialSite: tvmazeShow.webChannel.officialSite as string | undefined
        } : null,
        genres: tvmazeShow.genres || [],
        status: tvmazeShow.status,
        premiered: tvmazeShow.premiered,
        ended: tvmazeShow.ended,
        rating: tvmazeShow.rating as { average?: number } | null,
        runtime: tvmazeShow.runtime,
        averageRuntime: tvmazeShow.averageRuntime,
        schedule: tvmazeShow.schedule as { time?: string; days?: string[] } | null,
        officialSite: tvmazeShow.officialSite,
        language: tvmazeShow.language,
        type: tvmazeShow.type,
        updated: tvmazeShow.updated,
      };

      // Use INSERT ... ON CONFLICT to upsert the show
      const [upsertedShow] = await db
        .insert(shows)
        .values(showData)
        .onConflictDoUpdate({
          target: shows.id,
          set: showData
        })
        .returning();

      return upsertedShow || undefined;
    } catch (error) {
      console.error(`Error syncing show ${showId} from TVMaze:`, error);
      return undefined;
    }
  }

  async searchShows(query: string): Promise<Show[]> {
    return await db
      .select()
      .from(shows)
      .where(ilike(shows.name, `%${query}%`));
  }

  async searchUserShows(userId: string, query: string, includeRemoved: boolean = false): Promise<Show[]> {
    const whereConditions = [
      eq(userShows.userId, userId),
      ilike(shows.name, `%${query}%`)
    ];
    
    if (!includeRemoved) {
      whereConditions.push(eq(userShows.isRemoved, false));
    }

    const results = await db
      .select({
        id: shows.id,
        name: shows.name,
        summary: shows.summary,
        image: shows.image,
        network: shows.network,
        webChannel: shows.webChannel,
        genres: shows.genres,
        status: shows.status,
        premiered: shows.premiered,
        ended: shows.ended,
        rating: shows.rating,
        runtime: shows.runtime,
        averageRuntime: shows.averageRuntime,
        schedule: shows.schedule,
        officialSite: shows.officialSite,
        language: shows.language,
        type: shows.type,
        updated: shows.updated,
        tmdbId: shows.tmdbId,
        createdAt: shows.createdAt
      })
      .from(userShows)
      .innerJoin(shows, eq(userShows.showId, shows.id))
      .where(and(...whereConditions))
      .limit(20);

    return results;
  }

  // User show methods
  async getUserShows(userId: string, includeRemoved: boolean = false): Promise<(UserShow & { show: Show })[]> {
    const whereConditions = [eq(userShows.userId, userId)];
    
    if (!includeRemoved) {
      whereConditions.push(eq(userShows.isRemoved, false));
    }

    const results = await db
      .select({
        id: userShows.id,
        userId: userShows.userId,
        showId: userShows.showId,
        groupId: userShows.groupId,
        addedAt: userShows.addedAt,
        isRemoved: userShows.isRemoved,
        isShared: userShows.isShared,
        show: shows
      })
      .from(userShows)
      .innerJoin(shows, eq(userShows.showId, shows.id))
      .where(and(...whereConditions))
      .orderBy(asc(shows.name));

    return results.map(row => ({
      id: row.id,
      userId: row.userId,
      showId: row.showId,
      groupId: row.groupId,
      addedAt: row.addedAt,
      isRemoved: row.isRemoved,
      isShared: row.isShared,
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

  async softRemoveUserShow(userId: string, showId: number): Promise<UserShow | undefined> {
    const [removedUserShow] = await db
      .update(userShows)
      .set({ isRemoved: true })
      .where(and(eq(userShows.userId, userId), eq(userShows.showId, showId)))
      .returning();
    return removedUserShow || undefined;
  }

  async getGroupShows(groupId: string): Promise<(UserShow & { show: Show })[]> {
    const results = await db
      .select({
        id: userShows.id,
        userId: userShows.userId,
        showId: userShows.showId,
        groupId: userShows.groupId,
        addedAt: userShows.addedAt,
        isRemoved: userShows.isRemoved,
        isShared: userShows.isShared,
        show: shows
      })
      .from(userShows)
      .innerJoin(shows, eq(userShows.showId, shows.id))
      .where(and(
        eq(userShows.groupId, groupId),
        eq(userShows.isRemoved, false)
      ))
      .orderBy(asc(shows.name));

    return results.map(row => ({
      id: row.id,
      userId: row.userId,
      showId: row.showId,
      groupId: row.groupId,
      addedAt: row.addedAt,
      isRemoved: row.isRemoved,
      isShared: row.isShared,
      show: row.show
    }));
  }

  // Episode methods
  async getEpisodes(showId: number): Promise<Episode[]> {
    return await db
      .select()
      .from(episodes)
      .where(eq(episodes.showId, showId));
  }

  async getEpisode(episodeId: number): Promise<Episode | undefined> {
    const [episode] = await db.select().from(episodes).where(eq(episodes.id, episodeId));
    return episode || undefined;
  }

  async getEpisodeWithShowAndUserData(userId: string, episodeId: number): Promise<(Episode & { show: Show; userEpisode?: UserEpisode }) | undefined> {
    const result = await db
      .select({
        id: episodes.id,
        showId: episodes.showId,
        name: episodes.name,
        season: episodes.season,
        number: episodes.number,
        airdate: episodes.airdate,
        runtime: episodes.runtime,
        summary: episodes.summary,
        image: episodes.image,
        show: shows,
        userEpisode: userEpisodes
      })
      .from(episodes)
      .innerJoin(shows, eq(episodes.showId, shows.id))
      .leftJoin(userEpisodes, and(
        eq(userEpisodes.episodeId, episodes.id),
        eq(userEpisodes.userId, userId)
      ))
      .where(eq(episodes.id, episodeId))
      .limit(1);

    if (result.length === 0) return undefined;

    const row = result[0];
    return {
      id: row.id,
      showId: row.showId,
      name: row.name,
      season: row.season,
      number: row.number,
      airdate: row.airdate,
      runtime: row.runtime,
      summary: row.summary,
      image: row.image,
      show: row.show,
      userEpisode: row.userEpisode || undefined
    };
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

  async searchUserEpisodes(userId: string, query: string): Promise<(Episode & { show: Show })[]> {
    const results = await db
      .select({
        id: episodes.id,
        showId: episodes.showId,
        name: episodes.name,
        season: episodes.season,
        number: episodes.number,
        airdate: episodes.airdate,
        runtime: episodes.runtime,
        summary: episodes.summary,
        image: episodes.image,
        show: shows
      })
      .from(userEpisodes)
      .innerJoin(episodes, eq(userEpisodes.episodeId, episodes.id))
      .innerJoin(shows, eq(episodes.showId, shows.id))
      .innerJoin(userShows, and(
        eq(userShows.showId, shows.id),
        eq(userShows.userId, userId)
      ))
      .where(and(
        eq(userEpisodes.userId, userId),
        eq(userShows.isRemoved, false),
        ilike(episodes.name, `%${query}%`)
      ))
      .orderBy(asc(episodes.airdate))
      .limit(20);

    return results.map(row => ({
      id: row.id,
      showId: row.showId,
      name: row.name,
      season: row.season,
      number: row.number,
      airdate: row.airdate,
      runtime: row.runtime,
      summary: row.summary,
      image: row.image,
      show: row.show
    }));
  }

  // User episode methods
  async getUserEpisodes(userId: string, status?: string, showMode?: string, groupIds?: string[]): Promise<(UserEpisode & { episode: Episode & { show: Show } })[]> {
    // Get today's date in YYYY-MM-DD format for comparison
    const today = new Date().toISOString().split('T')[0];
    
    // Base conditions: user ID, only aired episodes, and only non-removed shows
    const baseConditions = and(
      eq(userEpisodes.userId, userId),
      eq(userShows.isRemoved, false),
      lte(episodes.airdate, today)
    );
    
    // Combine all conditions
    const allConditions = [baseConditions];
    if (status) {
      allConditions.push(eq(userEpisodes.status, status));
    }
    
    // Filter by group membership: "shared" = shows with groupId in user's groups, "personal" = shows with null groupId
    if (showMode === 'shared') {
      if (groupIds && groupIds.length > 0) {
        // Use parameterized OR conditions for group filtering
        allConditions.push(or(...groupIds.map(gid => eq(userShows.groupId, gid)))!);
      } else {
        // User has no groups - return empty result by adding impossible condition
        allConditions.push(sql`1=0`);
      }
    } else if (showMode === 'personal') {
      allConditions.push(isNull(userShows.groupId));
    }
    
    const whereClause = and(...allConditions);

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
        show: shows,
        groupId: userShows.groupId
      })
      .from(userEpisodes)
      .innerJoin(episodes, eq(userEpisodes.episodeId, episodes.id))
      .innerJoin(shows, eq(episodes.showId, shows.id))
      .innerJoin(userShows, and(
        eq(userShows.showId, shows.id),
        eq(userShows.userId, userId)
      ))
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
      groupId: row.groupId,
      episode: {
        ...row.episode,
        show: row.show
      }
    }));
  }

  async getUpcomingEpisodes(userId: string, showMode?: string, groupIds?: string[]): Promise<(Episode & { show: Show; groupId?: string | null })[]> {
    const today = new Date().toISOString().split('T')[0];
    
    // Build conditions based on showMode
    const allConditions = [
      eq(userShows.isRemoved, false),
      gt(episodes.airdate, today)
    ];
    
    // Filter by group membership: "shared" = shows with groupId in user's groups, "personal" = shows with null groupId
    if (showMode === 'shared') {
      if (groupIds && groupIds.length > 0) {
        // Use parameterized OR conditions for group filtering
        allConditions.push(or(...groupIds.map(gid => eq(userShows.groupId, gid)))!);
      } else {
        // User has no groups - return empty result by adding impossible condition
        allConditions.push(sql`1=0`);
      }
    } else if (showMode === 'personal') {
      allConditions.push(isNull(userShows.groupId));
    }
    
    const whereClause = and(...allConditions);
    
    const results = await db
      .select({
        id: episodes.id,
        showId: episodes.showId,
        name: episodes.name,
        season: episodes.season,
        number: episodes.number,
        airdate: episodes.airdate,
        runtime: episodes.runtime,
        summary: episodes.summary,
        image: episodes.image,
        show: shows,
        groupId: userShows.groupId
      })
      .from(episodes)
      .innerJoin(shows, eq(episodes.showId, shows.id))
      .innerJoin(userShows, and(
        eq(userShows.showId, shows.id),
        eq(userShows.userId, userId)
      ))
      .where(whereClause)
      .orderBy(asc(episodes.airdate))
      .limit(20);

    return results.map(row => ({
      id: row.id,
      showId: row.showId,
      name: row.name,
      season: row.season,
      number: row.number,
      airdate: row.airdate,
      runtime: row.runtime,
      summary: row.summary,
      image: row.image,
      show: row.show,
      groupId: row.groupId
    }));
  }

  async getUserEpisodesForShow(userId: string, showId: number): Promise<(UserEpisode & { episode: Episode })[]> {
    const results = await db
      .select({
        id: userEpisodes.id,
        userId: userEpisodes.userId,
        episodeId: userEpisodes.episodeId,
        status: userEpisodes.status,
        watchedAt: userEpisodes.watchedAt,
        triagedAt: userEpisodes.triagedAt,
        addedAt: userEpisodes.addedAt,
        episode: episodes
      })
      .from(userEpisodes)
      .innerJoin(episodes, eq(userEpisodes.episodeId, episodes.id))
      .where(and(
        eq(userEpisodes.userId, userId),
        eq(episodes.showId, showId)
      ));

    return results.map(row => ({
      id: row.id,
      userId: row.userId,
      episodeId: row.episodeId,
      status: row.status,
      watchedAt: row.watchedAt,
      triagedAt: row.triagedAt,
      addedAt: row.addedAt,
      episode: row.episode
    }));
  }

  async getUserEpisode(userId: string, episodeId: number): Promise<UserEpisode | undefined> {
    const [userEpisode] = await db
      .select()
      .from(userEpisodes)
      .where(and(eq(userEpisodes.userId, userId), eq(userEpisodes.episodeId, episodeId)));
    return userEpisode || undefined;
  }

  async addUserEpisode(userEpisode: InsertUserEpisode): Promise<{ episode: UserEpisode; isNew: boolean }> {
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
      return { episode: existingUserEpisode, isNew: false };
    }
    
    return { episode: newUserEpisode, isNew: true };
  }

  async updateUserEpisode(userId: string, episodeId: number, updates: Partial<UserEpisode>): Promise<UserEpisode | undefined> {
    const [updatedUserEpisode] = await db
      .update(userEpisodes)
      .set(updates)
      .where(and(eq(userEpisodes.userId, userId), eq(userEpisodes.episodeId, episodeId)))
      .returning();
    return updatedUserEpisode || undefined;
  }

  // User settings methods
  async getUserSettings(userId: string): Promise<UserSettings | undefined> {
    const [settings] = await db
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, userId));
    return settings || undefined;
  }

  async createUserSettings(insertUserSettings: InsertUserSettings): Promise<UserSettings> {
    const [settings] = await db
      .insert(userSettings)
      .values([insertUserSettings])
      .returning();
    return settings;
  }

  async updateUserSettings(userId: string, updates: Partial<UserSettings>): Promise<UserSettings | undefined> {
    const [updatedSettings] = await db
      .update(userSettings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(userSettings.userId, userId))
      .returning();
    return updatedSettings || undefined;
  }

  // Recommendation methods
  async getRecommendations(userId: string, limit?: number): Promise<Recommendation[]> {
    // Get all TMDB IDs from user's library to exclude them
    const userLibraryShows = await db
      .select({ tmdbId: shows.tmdbId })
      .from(userShows)
      .innerJoin(shows, eq(userShows.showId, shows.id))
      .where(and(
        eq(userShows.userId, userId),
        eq(userShows.isRemoved, false)
      ));
    
    const libraryTmdbIds = userLibraryShows
      .map(s => s.tmdbId)
      .filter((id): id is number => id !== null);
    
    let query = db
      .select()
      .from(recommendations)
      .where(
        libraryTmdbIds.length > 0
          ? and(
              eq(recommendations.userId, userId),
              sql`${recommendations.tmdbId} NOT IN ${libraryTmdbIds}`
            )
          : eq(recommendations.userId, userId)
      )
      .orderBy(desc(recommendations.score), asc(recommendations.tmdbId));
    
    if (limit) {
      query = query.limit(limit) as any;
    }
    
    return await query;
  }

  async createRecommendations(recs: InsertRecommendation[]): Promise<void> {
    if (recs.length === 0) return;
    
    await db
      .insert(recommendations)
      .values(recs)
      .onConflictDoUpdate({
        target: [recommendations.userId, recommendations.tmdbId],
        set: {
          score: sql`EXCLUDED.score`,
          sourceShowIds: sql`EXCLUDED.source_show_ids`,
          refreshedAt: new Date()
        }
      });
  }

  async clearRecommendations(userId: string): Promise<void> {
    await db
      .delete(recommendations)
      .where(eq(recommendations.userId, userId));
  }

  async dismissRecommendation(userId: string, tmdbId: number): Promise<void> {
    await db.transaction(async (tx) => {
      await tx
        .insert(dismissedRecommendations)
        .values({ userId, tmdbId })
        .onConflictDoNothing();
      
      await tx
        .delete(recommendations)
        .where(and(
          eq(recommendations.userId, userId),
          eq(recommendations.tmdbId, tmdbId)
        ));
    });
  }

  async getDismissedRecommendations(userId: string): Promise<DismissedRecommendation[]> {
    return await db
      .select()
      .from(dismissedRecommendations)
      .where(eq(dismissedRecommendations.userId, userId));
  }

  async updateShowTmdbId(showId: number, tmdbId: number): Promise<void> {
    await db
      .update(shows)
      .set({ tmdbId })
      .where(eq(shows.id, showId));
  }

  // New releases methods
  async getNewReleasesState(): Promise<NewReleasesState | undefined> {
    const [state] = await db.select().from(newReleasesState).limit(1);
    return state || undefined;
  }

  async updateNewReleasesState(lastCheckedUnix: number, cachedResults: NewReleaseShow[]): Promise<void> {
    const existingState = await this.getNewReleasesState();
    
    if (existingState) {
      await db
        .update(newReleasesState)
        .set({ 
          lastCheckedUnix, 
          cachedResults: cachedResults as any,
          cachedAt: new Date()
        })
        .where(eq(newReleasesState.id, existingState.id));
    } else {
      await db
        .insert(newReleasesState)
        .values({ 
          lastCheckedUnix, 
          cachedResults: cachedResults as any,
          cachedAt: new Date()
        });
    }
  }

  async getDismissedNewReleases(userId: string): Promise<DismissedNewRelease[]> {
    return await db
      .select()
      .from(dismissedNewReleases)
      .where(eq(dismissedNewReleases.userId, userId));
  }

  async dismissNewRelease(userId: string, tvmazeId: number): Promise<void> {
    await db
      .insert(dismissedNewReleases)
      .values({ userId, tvmazeId })
      .onConflictDoNothing();
  }

  async getUserShowIds(userId: string): Promise<number[]> {
    const results = await db
      .select({ showId: userShows.showId })
      .from(userShows)
      .where(and(
        eq(userShows.userId, userId),
        eq(userShows.isRemoved, false)
      ));
    return results.map(r => r.showId);
  }

  async getUserGroupIds(userId: string): Promise<string[]> {
    const results = await db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, userId));
    return results.map(r => r.groupId);
  }

  // Group methods
  async createGroup(group: InsertGroup): Promise<Group> {
    const [newGroup] = await db.insert(groups).values(group).returning();
    return newGroup;
  }

  async getGroup(groupId: string): Promise<Group | undefined> {
    const [group] = await db.select().from(groups).where(eq(groups.id, groupId));
    return group || undefined;
  }

  async getUserGroups(userId: string): Promise<(Group & { memberCount: number })[]> {
    const membershipGroups = await db
      .select({ groupId: groupMembers.groupId })
      .from(groupMembers)
      .where(eq(groupMembers.userId, userId));
    
    if (membershipGroups.length === 0) return [];
    
    const groupIds = membershipGroups.map(m => m.groupId);
    const userGroups = await db.select().from(groups).where(inArray(groups.id, groupIds));
    
    const result = await Promise.all(userGroups.map(async (group) => {
      const [countResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(groupMembers)
        .where(eq(groupMembers.groupId, group.id));
      return { ...group, memberCount: Number(countResult?.count || 0) };
    }));
    
    return result;
  }

  async updateGroup(groupId: string, updates: Partial<Group>): Promise<Group | undefined> {
    const [updated] = await db
      .update(groups)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(groups.id, groupId))
      .returning();
    return updated || undefined;
  }

  async deleteGroup(groupId: string): Promise<boolean> {
    await db.delete(groupInvites).where(eq(groupInvites.groupId, groupId));
    await db.delete(groupMembers).where(eq(groupMembers.groupId, groupId));
    const result = await db.delete(groups).where(eq(groups.id, groupId));
    return true;
  }

  // Group member methods
  async addGroupMember(member: InsertGroupMember): Promise<GroupMember> {
    const [newMember] = await db
      .insert(groupMembers)
      .values(member)
      .onConflictDoNothing()
      .returning();
    
    if (!newMember) {
      const [existing] = await db
        .select()
        .from(groupMembers)
        .where(and(
          eq(groupMembers.groupId, member.groupId),
          eq(groupMembers.userId, member.userId)
        ));
      return existing;
    }
    return newMember;
  }

  async getGroupMembers(groupId: string): Promise<(GroupMember & { user: User })[]> {
    const members = await db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.groupId, groupId));
    
    const result = await Promise.all(members.map(async (member) => {
      const [user] = await db.select().from(users).where(eq(users.id, member.userId));
      return { ...member, user };
    }));
    
    return result.filter(m => m.user);
  }

  async isGroupMember(groupId: string, userId: string): Promise<boolean> {
    const [member] = await db
      .select()
      .from(groupMembers)
      .where(and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, userId)
      ));
    return !!member;
  }

  async removeGroupMember(groupId: string, userId: string): Promise<boolean> {
    await db
      .delete(groupMembers)
      .where(and(
        eq(groupMembers.groupId, groupId),
        eq(groupMembers.userId, userId)
      ));
    return true;
  }

  // Group invite methods
  async createGroupInvite(invite: InsertGroupInvite): Promise<GroupInvite> {
    const [newInvite] = await db.insert(groupInvites).values(invite).returning();
    return newInvite;
  }

  async getGroupInvite(inviteCode: string): Promise<GroupInvite | undefined> {
    const [invite] = await db
      .select()
      .from(groupInvites)
      .where(eq(groupInvites.inviteCode, inviteCode));
    return invite || undefined;
  }

  async getGroupInvitesByEmail(email: string): Promise<(GroupInvite & { group: Group })[]> {
    const invites = await db
      .select()
      .from(groupInvites)
      .where(and(
        eq(groupInvites.invitedEmail, email),
        sql`${groupInvites.usedAt} IS NULL`
      ));
    
    const result = await Promise.all(invites.map(async (invite) => {
      const [group] = await db.select().from(groups).where(eq(groups.id, invite.groupId));
      return { ...invite, group };
    }));
    
    return result.filter(i => i.group);
  }

  async getPendingInvitesForGroup(groupId: string): Promise<GroupInvite[]> {
    return await db
      .select()
      .from(groupInvites)
      .where(and(
        eq(groupInvites.groupId, groupId),
        sql`${groupInvites.usedAt} IS NULL`
      ));
  }

  async useGroupInvite(inviteCode: string, userId: string): Promise<GroupInvite | undefined> {
    const [updated] = await db
      .update(groupInvites)
      .set({ usedAt: new Date(), usedBy: userId })
      .where(and(
        eq(groupInvites.inviteCode, inviteCode),
        sql`${groupInvites.usedAt} IS NULL`
      ))
      .returning();
    return updated || undefined;
  }

  async deleteGroupInvite(inviteId: string): Promise<boolean> {
    await db.delete(groupInvites).where(eq(groupInvites.id, inviteId));
    return true;
  }
}

export const storage = new DatabaseStorage();
