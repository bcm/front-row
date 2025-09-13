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
  createdAt: timestamp("created_at").defaultNow(),
});

export const userShows = pgTable("user_shows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  showId: integer("show_id").notNull(),
  status: text("status").notNull(), // 'new', 'watching', 'later', 'archived'
  addedAt: timestamp("added_at").defaultNow(),
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
