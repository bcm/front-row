import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, jsonb, boolean, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const shows = pgTable("shows", {
  id: integer("id").primaryKey(), // TVMaze show ID
  name: text("name").notNull(),
  summary: text("summary"),
  image: jsonb("image").$type<{ medium?: string; original?: string }>(),
  network: jsonb("network").$type<{ name?: string; country?: { name?: string } }>(),
  webChannel: jsonb("web_channel").$type<{ name?: string; country?: { name?: string }; officialSite?: string }>(),
  genres: text("genres").array(),
  status: text("status"),
  premiered: text("premiered"),
  ended: text("ended"),
  rating: jsonb("rating").$type<{ average?: number }>(),
  runtime: integer("runtime"),
  averageRuntime: integer("average_runtime"),
  schedule: jsonb("schedule").$type<{ time?: string; days?: string[] }>(),
  officialSite: text("official_site"),
  language: text("language"),
  type: text("type"),
  updated: integer("updated"),
  tmdbId: integer("tmdb_id"), // TMDB show ID for recommendations
  createdAt: timestamp("created_at").defaultNow(),
});

export const userShows = pgTable("user_shows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  showId: integer("show_id").notNull(),
  addedAt: timestamp("added_at").defaultNow(),
  isRemoved: boolean("is_removed").notNull().default(false),
  isShared: boolean("is_shared").notNull().default(false),
});

export const episodes = pgTable("episodes", {
  id: integer("id").primaryKey(), // TVMaze episode ID
  showId: integer("show_id").notNull(),
  name: text("name"),
  season: integer("season"),
  number: integer("number"),
  airdate: text("airdate"),
  runtime: integer("runtime"),
  summary: text("summary"),
  image: jsonb("image").$type<{ medium?: string; original?: string }>(),
});

export const userEpisodes = pgTable("user_episodes", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  episodeId: integer("episode_id").notNull(),
  status: text("status").notNull(), // 'untriaged', 'later', 'next', 'watched', 'skipped'
  watchedAt: timestamp("watched_at"),
  triagedAt: timestamp("triaged_at"),
  addedAt: timestamp("added_at").defaultNow(),
}, (table) => ({
  uniqueUserEpisode: unique().on(table.userId, table.episodeId),
}));

export const userSettings = pgTable("user_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  hideFinishedShows: boolean("hide_finished_shows").notNull().default(true),
  showMode: text("show_mode").notNull().default("personal"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertShowSchema = createInsertSchema(shows).omit({
  createdAt: true,
});

export const insertUserShowSchema = createInsertSchema(userShows).omit({
  id: true,
  addedAt: true,
});

export const insertEpisodeSchema = createInsertSchema(episodes);

export const insertUserEpisodeSchema = createInsertSchema(userEpisodes).omit({
  id: true,
  addedAt: true,
  watchedAt: true,
  triagedAt: true,
});

export const insertUserSettingsSchema = createInsertSchema(userSettings).omit({
  id: true,
  updatedAt: true,
});

export const recommendations = pgTable("recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  tmdbId: integer("tmdb_id").notNull(),
  name: text("name").notNull(),
  overview: text("overview"),
  posterPath: text("poster_path"),
  backdropPath: text("backdrop_path"),
  voteAverage: integer("vote_average"),
  voteCount: integer("vote_count"),
  genres: text("genres").array(),
  firstAirDate: text("first_air_date"),
  score: integer("score").notNull(), // aggregated score for ranking
  sourceShowIds: text("source_show_ids").array(), // TMDB IDs of shows that recommended this
  createdAt: timestamp("created_at").defaultNow(),
  refreshedAt: timestamp("refreshed_at").defaultNow(),
}, (table) => ({
  uniqueUserRecommendation: unique().on(table.userId, table.tmdbId),
}));

export const dismissedRecommendations = pgTable("dismissed_recommendations", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  tmdbId: integer("tmdb_id").notNull(),
  dismissedAt: timestamp("dismissed_at").defaultNow(),
}, (table) => ({
  uniqueUserDismissed: unique().on(table.userId, table.tmdbId),
}));

export const insertRecommendationSchema = createInsertSchema(recommendations).omit({
  id: true,
  createdAt: true,
  refreshedAt: true,
});

export const insertDismissedRecommendationSchema = createInsertSchema(dismissedRecommendations).omit({
  id: true,
  dismissedAt: true,
});

// New Releases feature tables
export const newReleasesState = pgTable("new_releases_state", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lastCheckedUnix: integer("last_checked_unix").notNull().default(0),
  cachedResults: jsonb("cached_results").$type<NewReleaseShow[]>(),
  cachedAt: timestamp("cached_at"),
});

export const dismissedNewReleases = pgTable("dismissed_new_releases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  tvmazeId: integer("tvmaze_id").notNull(),
  dismissedAt: timestamp("dismissed_at").defaultNow(),
}, (table) => ({
  uniqueUserDismissedNewRelease: unique().on(table.userId, table.tvmazeId),
}));

export const insertDismissedNewReleaseSchema = createInsertSchema(dismissedNewReleases).omit({
  id: true,
  dismissedAt: true,
});

// Type for cached new release shows
export type NewReleaseShow = {
  id: number;
  name: string;
  summary: string | null;
  image: { medium?: string; original?: string } | null;
  premiered: string | null;
  genres: string[];
  network: string | null;
  webChannel: string | null;
  status: string | null;
};

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type Show = typeof shows.$inferSelect;
export type InsertShow = z.infer<typeof insertShowSchema>;
export type UserShow = typeof userShows.$inferSelect;
export type InsertUserShow = z.infer<typeof insertUserShowSchema>;
export type Episode = typeof episodes.$inferSelect;
export type InsertEpisode = z.infer<typeof insertEpisodeSchema>;
export type UserEpisode = typeof userEpisodes.$inferSelect;
export type InsertUserEpisode = z.infer<typeof insertUserEpisodeSchema>;
export type UserSettings = typeof userSettings.$inferSelect;
export type InsertUserSettings = z.infer<typeof insertUserSettingsSchema>;
export type Recommendation = typeof recommendations.$inferSelect;
export type InsertRecommendation = z.infer<typeof insertRecommendationSchema>;
export type DismissedRecommendation = typeof dismissedRecommendations.$inferSelect;
export type InsertDismissedRecommendation = z.infer<typeof insertDismissedRecommendationSchema>;
export type NewReleasesState = typeof newReleasesState.$inferSelect;
export type DismissedNewRelease = typeof dismissedNewReleases.$inferSelect;
export type InsertDismissedNewRelease = z.infer<typeof insertDismissedNewReleaseSchema>;
