# Front Row Agent Interface — Design Doc

**Status:** Draft for review. No code in this PR.
**Date:** 2026-09-29
**Author:** Ghost (for Brian)

## 1. Goal

Give AI agents (starting with Ghost) direct, delegated access to Front Row's
information and capabilities, as a conversational surface alongside the
existing web UI. Target interactions: "what should we watch?", "what's next
in the queue?", "mark the latest episode of X watched", "any premieres this
week worth flagging?"

This is explicitly **not** a UI replacement. The web UI at
frontrow.maz.org remains a first-class surface, and the app remains the
system of record. The agent interface is a second surface on the same data
and the same business logic.

## 2. Non-goals

- Changing any existing UI route, page, or behavior.
- Hardening the existing `/api/*` UI routes (see §8 — adjacent, not bundled).
- Replacing the TVMaze/TMDB ingestion pipeline or the scheduled jobs.

## 3. Architecture

A **Model Context Protocol (MCP) server** mounted inside the existing
Express app at `/mcp`, using the MCP SDK's Streamable HTTP transport.

- **Same deployment.** No new service, no new host. The autoscale deployment
  serves it; the `[postMerge]` hook's `npm ci` covers the new SDK dependency.
- **Same process, same database.** The MCP layer shares the existing
  `storage` module and service functions (`new-releases-service`,
  `recommendation-service`, the sync job manager). Business logic —
  scrobble-synced add-show, shared-vs-personal episode ownership, soft
  delete, dismissals — is reused, not reimplemented. The MCP layer is thin:
  authentication, tool schemas, and delegation.
- **Why MCP instead of a bespoke agent REST API:** standard tool discovery
  (`tools/list`) and typed tool schemas mean any MCP client can consume it
  later — other agents, other harnesses — without a new integration per
  consumer. This is the interop bet that matches the agentic-OS direction.

## 4. Authentication: OAuth 2.0 Device Authorization Grant

Ghost runs on a headless VM; Brian's browser is the approval device. That
topology is exactly what the **Device Authorization Grant (RFC 8628)** is
for. A shared static Bearer token was considered and rejected: no expiry,
no scopes, no per-client revocation, and anyone holding the string *is*
Brian. Delegation should be delegable.

### Flow

1. The agent CLI calls `POST /oauth/device/code` → receives
   `device_code`, `user_code`, and `verification_uri`.
2. Brian opens the verification URI in his browser (already authenticated
   via his existing session) and sees: *"Ghost is requesting access:
   `library:read`, `library:write`"* → Approve / Deny.
3. The CLI polls `POST /oauth/token` with the `device_code` until approval,
   then receives a short-lived **access token** (1h) and a rotating
   **refresh token** (90d).
4. MCP calls carry `Authorization: Bearer <access_token>`. The `/mcp`
   middleware validates the token and enforces the scope required by each
   tool. There is **no** demo-user fallback on this surface, unlike the UI
   API.

### Scopes (v1)

- `library:read` — library, search, show details, queue, releases,
  recommendations, upcoming episodes, event drain.
- `library:write` — add/remove shows, episode status changes, dismissals.

Two scopes are enough for v1; they can be split finer later without breaking
the flow.

### Data model (new tables, via Drizzle in `shared/schema.ts`)

- `oauth_clients` — pre-registered clients (`ghost` in v1; no dynamic
  client registration yet): `client_id` (PK), `name`, `created_at`.
- `oauth_device_codes` — `device_code` (PK, hashed), `user_code` (unique,
  human-typable), `client_id`, `scopes`, `status`
  (`pending`/`approved`/`denied`/`expired`), `approved_by_user_id`,
  `expires_at`, `created_at`.
- `oauth_tokens` — `id` (PK), `client_id`, `user_id`, `scopes`,
  `access_token_hash`, `refresh_token_hash`, `access_expires_at`,
  `refresh_expires_at`, `revoked_at` (nullable), `created_at`.
  Token values are shown once and stored hashed (SHA-256); lookup is by
  hash.

### Verification page

A minimal server-rendered page at `/oauth/device` (or a small React route):
enter `user_code` → shows client name + requested scopes → Approve / Deny.
Session-authenticated; CSRF-protected like the rest of the app.

### Revocation

`DELETE /oauth/tokens/:id` (session-authenticated) and/or a small section
in the UI listing authorized clients with per-client revoke. Revoking the
refresh token invalidates the whole grant.

## 5. Tool surface (v1)

Each tool answers one user intent in one call. All tools resolve the user
from the access token — never from a request parameter.

| Tool | Scope | Backing logic |
|---|---|---|
| `queue_next_up` | read | Next unwatched episode per followed show, ordered by airdate. Composes `user_shows` → `episodes` → `user_episodes`, honoring group vs personal ownership. This is "what's next in the queue" computed server-side. |
| `library_list` | read | `storage.getUserShows`, with status filters. |
| `library_search` | read | `storage.searchUserShows` + `searchUserEpisodes` (same composition as `GET /api/search`). |
| `catalog_search` | read | TVMaze show search (existing proxy logic). |
| `show_get` | read | Show details + episode list with the user's statuses. |
| `show_add` | write | The existing add-show flow: sync from TVMaze, async episode import, scrobble import, TVMaze follow. Returns the sync job id; the client polls job status (existing `/api/sync/:id/status` shape, or an MCP-native status tool). |
| `show_remove` | write | Soft remove (+ TVMaze unfollow, as today). |
| `episode_set_status` | write | Set `watched`/`skipped`/`next`/`later`/`untriaged` for one episode or an episode range. Must go through the existing ownership-aware storage methods — never raw writes. |
| `releases_new` | read | `getNewReleases()` with dismissals applied. |
| `releases_dismiss` | write | `storage.dismissNewRelease`. |
| `recommendations_list` | read | `storage.getRecommendations`. |
| `recommendations_accept` | write | Add to library (delegates to `show_add`). |
| `recommendations_dismiss` | write | `storage.dismissRecommendation`. |
| `upcoming_episodes` | read | Episodes airing in the next N days across the library (`storage.getUpcomingEpisodes`). |
| `events_drain` | read | Consume the outbox (§6). |

## 6. Event awareness: outbox, not push

MCP supports server→client notifications, but only over an already-open
session — and Ghost's runtime has no wake-on-notification path (its
"event-based" automations are polling under the hood). Push also buys
nothing here: episodes air on fixed schedules, so same-day awareness is all
that matters. The design is therefore **poll mechanics with event
semantics**:

- New `events` table: `id` (PK), `type`, `payload` (jsonb), `created_at`,
  `processed_at` (nullable), `processed_by` (nullable).
- **Producers** (wired into existing jobs, no behavior change otherwise):
  - episode scheduler → `episode.imported` (new episodes added to a
    followed show), `sync.completed` / `sync.failed`;
  - new-releases refresh → `premiere.flagged`;
  - recommendation refresh → `recommendations.refreshed`.
- **Consumer:** Ghost drains via `events_drain` on its own schedule
  (cron), which marks rows processed — exactly-once, nothing missed,
  nothing double-reported. Reporting to Brian follows the no-noise
  contract: only genuinely new items surface.

## 7. Delivery / SDLC

This repo inverts its current habit with this change:

- **GitHub (`bcm/front-row`) becomes the source of truth.** Ghost authors
  branches and PRs here (this design doc is the first).
- **The Replit workspace pulls.** Verified 2026-09-29: the workspace can
  `git fetch origin` with a clean tree. Merge the branch in the workspace
  (the `[postMerge]` hook runs `npm ci`, covering new dependencies), then
  the Replit Agent verifies and redeploys.
- The old pattern — Replit pushing snapshots outward — is retired for
  code changes going forward.

## 8. Security notes (adjacent, not bundled)

- The existing `/api/*` UI routes are effectively unauthenticated:
  `isAuthenticated` is imported in `server/routes.ts` but never applied,
  and `getUserId` falls back to `"demo-user"`. Anyone on the internet can
  read/write the demo-user namespace today (it happens to be empty).
- This PR deliberately does **not** change that behavior — hardening the UI
  API is a separate decision with its own blast radius (it touches Brian's
  live browser session flow). It should be tracked separately.

## 9. Sequencing (follow-up PRs after this doc is approved)

1. **DB migration** — `oauth_clients`, `oauth_device_codes`,
   `oauth_tokens`, `events` tables (Drizzle; `shared/schema.ts`).
2. **OAuth device flow** — `POST /oauth/device/code`, verification page at
   `/oauth/device`, `POST /oauth/token`, revocation endpoints.
3. **MCP server + read tools** — `/mcp` mount, Bearer auth middleware,
   scope enforcement, read-only tools.
4. **MCP write tools** — `show_add`, `show_remove`, `episode_set_status`,
   dismissals.
5. **Outbox producers** — wire event emission into the schedulers.
6. **Ghost skill** (in `bcm/muse-skills`, separate repo) — MCP client CLI
   plus the device-flow auth dance; tokens live in the secure vault, never
   in the repo.

## 10. Open questions for Brian

1. Token lifetimes: 1h access / 90d rotating refresh — reasonable?
2. Two scopes for v1, or do you want finer splits now (e.g. separate
   `episodes:write`)?
3. Agent tools and the family/group model: Elana doesn't use her view, but
   shared-episode invariants still have to be respected on writes. Keep
   group-aware tools, or personal-only for v1 with group writes rejected?
4. `events_drain` consumer identity: single Ghost client for now, or
   per-agent from the start?
5. Confirm §8 stays out of scope for this track (filed separately or
   accepted as-is?).
