import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, jsonb, boolean, unique, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export * from "./models/auth";

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
  lastSyncedAt: timestamp("last_synced_at"), // local sync time, per the agent-interface design doc
  tmdbId: integer("tmdb_id"), // TMDB show ID for recommendations
  createdAt: timestamp("created_at").defaultNow(),
});

export const userShows = pgTable("user_shows", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  showId: integer("show_id").notNull(),
  groupId: varchar("group_id"), // null = personal, set = group show
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
  userId: varchar("user_id"), // null for shared episodes (group-based)
  episodeId: integer("episode_id").notNull(),
  groupId: varchar("group_id"), // null = personal, set = shared group status
  status: text("status").notNull(), // 'untriaged', 'later', 'next', 'watched', 'skipped'
  watchedAt: timestamp("watched_at"),
  triagedAt: timestamp("triaged_at"),
  addedAt: timestamp("added_at").defaultNow(),
});

export const userSettings = pgTable("user_settings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  hideFinishedShows: boolean("hide_finished_shows").notNull().default(true),
  showMode: text("show_mode").notNull().default("personal"),
  updatedAt: timestamp("updated_at").defaultNow(),
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
  network: text("network"), // primary network/platform
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

// Groups feature tables
export const groups = pgTable("groups", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  createdBy: varchar("created_by").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const groupMembers = pgTable("group_members", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  groupId: varchar("group_id").notNull(),
  userId: varchar("user_id").notNull(),
  joinedAt: timestamp("joined_at").defaultNow(),
}, (table) => ({
  uniqueGroupMember: unique().on(table.groupId, table.userId),
}));

export const groupInvites = pgTable("group_invites", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  groupId: varchar("group_id").notNull(),
  inviteCode: varchar("invite_code").notNull().unique(),
  invitedEmail: varchar("invited_email"), // null for link-based invites
  invitedBy: varchar("invited_by").notNull(),
  expiresAt: timestamp("expires_at"),
  usedAt: timestamp("used_at"),
  usedBy: varchar("used_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertGroupSchema = createInsertSchema(groups).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const insertGroupMemberSchema = createInsertSchema(groupMembers).omit({
  id: true,
  joinedAt: true,
});

export const insertGroupInviteSchema = createInsertSchema(groupInvites).omit({
  id: true,
  usedAt: true,
  usedBy: true,
  createdAt: true,
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

// Agent interface (MCP + OAuth) tables.
// See docs/agent-interface-design.md §§4–6.
export const oauthClients = pgTable("oauth_clients", {
  clientId: text("client_id").primaryKey(), // e.g. "ghost"; pre-registered, no dynamic registration in v1
  name: text("name").notNull(),
  allowedScopes: text("allowed_scopes").array().notNull(), // scopes this client may request
  allowedRedirectUris: text("allowed_redirect_uris").array().notNull(), // exact-match allow-list for the authorization-code grant; no DDL default — drizzle-kit 0.31.11's push introspection mangles empty array defaults ('{}' -> '{""]}') so no declared default converges (issue #30). The sole insert path (ensureDefaultClients) sets [] explicitly.
  createdAt: timestamp("created_at").defaultNow(),
});

export const oauthDeviceCodes = pgTable("oauth_device_codes", {
  // SHA-256 hash of the device code (the code itself is shown to the agent once)
  deviceCodeHash: text("device_code_hash").primaryKey(),
  userCode: text("user_code").notNull().unique(), // human-typable, from an unambiguous alphabet
  clientId: text("client_id").notNull(),
  scopes: text("scopes").array().notNull(),
  status: text("status").notNull().default("pending"), // pending | approved | denied | expired
  approvedByUserId: varchar("approved_by_user_id"), // set on approval: the approver's Replit sub
  expiresAt: timestamp("expires_at").notNull(), // ~10 minutes after creation
  createdAt: timestamp("created_at").defaultNow(),
});

export const oauthAuthorizationCodes = pgTable("oauth_authorization_codes", {
  // SHA-256 hash of the authorization code (the code itself travels once, in the redirect to the client)
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  userId: varchar("user_id").notNull(), // approver's Replit sub, bound at approval
  redirectUri: text("redirect_uri").notNull(), // exact redirect_uri from the authorize request; must match at exchange
  scopes: text("scopes").array().notNull(),
  codeChallenge: text("code_challenge"), // PKCE (RFC 7636); required by the implementation, so never null for issued codes
  codeChallengeMethod: text("code_challenge_method"), // "S256" | "plain"
  expiresAt: timestamp("expires_at").notNull(), // ~10 minutes after issuance
  createdAt: timestamp("created_at").defaultNow(),
});

export const oauthTokens = pgTable("oauth_tokens", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  clientId: text("client_id").notNull(),
  userId: varchar("user_id").notNull(), // bound to the approver's claims.sub at grant time
  scopes: text("scopes").array().notNull(),
  accessTokenHash: text("access_token_hash").notNull().unique(),
  refreshTokenHash: text("refresh_token_hash").notNull().unique(),
  accessExpiresAt: timestamp("access_expires_at").notNull(), // 1 hour
  refreshExpiresAt: timestamp("refresh_expires_at").notNull(), // 90 days, rotating
  rotatedAt: timestamp("rotated_at"), // set when this row is superseded by rotation (vs revokedAt = manual revoke)
  revokedAt: timestamp("revoked_at"), // set on revocation; null = active
  createdAt: timestamp("created_at").defaultNow(),
});

// Outbox for agent-visible events (episode imports, premieres, sync results).
// Drained by events_drain with SELECT ... FOR UPDATE SKIP LOCKED.
export const outboxEvents = pgTable("events", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  type: text("type").notNull(), // episode.imported | sync.completed | sync.failed | premiere.flagged | recommendations.refreshed
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  dedupeKey: text("dedupe_key").unique(), // idempotent producers: insert-on-conflict-do-nothing
  createdAt: timestamp("created_at").defaultNow(),
  processedAt: timestamp("processed_at"), // null = not yet drained
  processedBy: varchar("processed_by"), // client id that drained it
}, (table) => ({
  drainOrder: index("events_drain_idx").on(table.processedAt, table.createdAt),
}));

// MCP rate limiting: per-client+user token buckets for TVMaze-proxied tools
// (design §11.6). Backed by Postgres so it is stateless-safe across replicas.
export const mcpRateLimits = pgTable("mcp_rate_limits", {
  id: text("id").primaryKey(), // e.g. "catalog:<clientId>:<userId>"
  windowStart: timestamp("window_start").notNull(),
  count: integer("count").notNull().default(0),
});

export const insertMcpRateLimitSchema = createInsertSchema(mcpRateLimits);

// Shared TVMaze pace gate (issue #5): one row (id = 'tvmaze') holding the
// earliest time the next call may go out. Concurrency slots are fixed rows
// in tvmaze_slots (below), claimed per-row with FOR UPDATE SKIP LOCKED —
// never a counter or a count-then-insert, so the cap holds under replica
// contention. Acquisition runs as one explicit transaction
// (server/tvmaze/pace.ts): INSERT ... ON CONFLICT DO NOTHING bootstraps
// the row, SELECT ... FOR UPDATE takes the lock serializing acquirers,
// the slot claim runs, then the pace advance — the pace row is modified
// exactly once per acquisition (PostgreSQL forbids modifying one row
// twice in a single statement). A replica that dies holding a slot never
// releases it, so slots expire and the acquire path reclaims them. Every
// timestamp in the gate comes from PostgreSQL: clock_timestamp() read
// after the pace-row lock (now() is transaction-start, stale under
// contention) — no replica wall clock, so skew can't break spacing,
// expire live slots early, or reopen a cooldown early. The app's single
// outbound IP is shared by all users and the sync jobs, and TVMaze allows
// at least 20 calls per 10 seconds per IP. Each admission advances
// nextAdmitAt by 10s/18, so calls are evenly spaced and no 10-second
// interval ever sees more than 18 — regardless of alignment with TVMaze's
// own limiter. A 429 from TVMaze sets cooldownUntil as a backstop (longest
// wins under concurrency).
export const tvmazePace = pgTable("tvmaze_pace", {
  id: text("id").primaryKey(), // always 'tvmaze'
  nextAdmitAt: timestamp("next_admit_at").notNull(),
  cooldownUntil: timestamp("cooldown_until"), // set when TVMaze answers 429
});

// Crash-safe concurrency slots for the TVMaze pace gate. Fixed rows, one
// per in-flight upstream call (slot 0 .. TVMAZE_MAX_CONCURRENT - 1). The
// acquire path (server/tvmaze/pace.ts) claims a free-or-expired row with
// FOR UPDATE SKIP LOCKED inside the same explicit transaction that holds
// the pace-row lock, so the cap is enforced atomically: a concurrent
// claimer either skips the locked row or sees the committed claim — no
// snapshot race can admit a fifth caller. A slot held by a crashed
// replica ages out (acquired_at older than the lease TTL) and becomes
// claimable again — a slot can never leak permanently. Release clears the
// caller's own lease id; clearing another caller's row is never correct
// (use expiry for that).
export const tvmazeSlots = pgTable("tvmaze_slots", {
  slot: integer("slot").primaryKey(),
  leaseId: varchar("lease_id"), // set while a call holds the slot
  acquiredAt: timestamp("acquired_at"), // set while a call holds the slot
});

export const insertOauthClientSchema = createInsertSchema(oauthClients).omit({
  createdAt: true,
});

export const insertOauthDeviceCodeSchema = createInsertSchema(oauthDeviceCodes).omit({
  createdAt: true,
});

export const insertOauthAuthorizationCodeSchema = createInsertSchema(oauthAuthorizationCodes).omit({
  createdAt: true,
});

export const insertOauthTokenSchema = createInsertSchema(oauthTokens).omit({
  id: true,
  createdAt: true,
});

export const insertOutboxEventSchema = createInsertSchema(outboxEvents).omit({
  id: true,
  createdAt: true,
  processedAt: true,
  processedBy: true,
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
export type Group = typeof groups.$inferSelect;
export type InsertGroup = z.infer<typeof insertGroupSchema>;
export type GroupMember = typeof groupMembers.$inferSelect;
export type InsertGroupMember = z.infer<typeof insertGroupMemberSchema>;
export type GroupInvite = typeof groupInvites.$inferSelect;
export type InsertGroupInvite = z.infer<typeof insertGroupInviteSchema>;
export type McpRateLimit = typeof mcpRateLimits.$inferSelect;
export type TvmazePaceRow = typeof tvmazePace.$inferSelect;
export type TvmazeSlotRow = typeof tvmazeSlots.$inferSelect;
export type InsertMcpRateLimit = z.infer<typeof insertMcpRateLimitSchema>;
export type OauthClient = typeof oauthClients.$inferSelect;
export type InsertOauthClient = z.infer<typeof insertOauthClientSchema>;
export type OauthDeviceCode = typeof oauthDeviceCodes.$inferSelect;
export type InsertOauthDeviceCode = z.infer<typeof insertOauthDeviceCodeSchema>;
export type OauthToken = typeof oauthTokens.$inferSelect;
export type InsertOauthToken = z.infer<typeof insertOauthTokenSchema>;
export type OutboxEvent = typeof outboxEvents.$inferSelect;
export type InsertOutboxEvent = z.infer<typeof insertOutboxEventSchema>;

// Durable sync job state (issue #6). Async sync jobs (show sync, library
// import, episode import) persist here instead of the old per-replica
// in-memory manager, so every reader (UI, API, MCP sync_status) sees the
// same state regardless of which replica runs the job. heartbeat_at advances
// on throttled progress writes while the worker is alive; readers treat a
// 'running' job whose heartbeat is older than the timeout as dead — computed
// on read, the row itself is never mutated by readers.
export const syncJobs = pgTable("sync_jobs", {
  id: text("id").primaryKey(), // sync_<showId>_<ts>_<rand>
  userId: varchar("user_id").notNull(),
  kind: text("kind").notNull(), // 'show-sync' | 'library-import' | 'episode-import'
  showId: integer("show_id"), // null for library/episode imports
  status: text("status").notNull(), // 'queued' | 'running' | 'success' | 'error' | 'canceled'
  phase: text("phase").notNull(),
  totalShows: integer("total_shows").notNull().default(0),
  completedShows: integer("completed_shows").notNull().default(0),
  percent: integer("percent").notNull().default(0),
  etaSeconds: integer("eta_seconds"),
  errors: jsonb("errors").$type<string[]>().notNull().default([]),
  episodesImported: integer("episodes_imported").notNull().default(0),
  episodesUpdated: integer("episodes_updated").notNull().default(0),
  lastMessage: text("last_message"),
  canceled: boolean("canceled").notNull().default(false),
  startedAt: timestamp("started_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  heartbeatAt: timestamp("heartbeat_at").defaultNow(),
  finishedAt: timestamp("finished_at"),
}, (table) => ({
  userRecent: index("sync_jobs_user_started_idx").on(table.userId, table.startedAt),
}));

export type SyncJobRow = typeof syncJobs.$inferSelect;
