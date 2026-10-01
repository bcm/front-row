# Front Row Agent Interface — Design Doc

**Status:** Draft for review. No code in this PR.
**Date:** 2026-09-29 (revised after design review)
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
- Hardening the existing `/api/*` UI routes (see §8 — tracked separately,
  not bundled).
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
- **Stateless across replicas.** The deployment target is autoscale, so
  multiple instances are possible. All MCP/session/device-code/token state
  lives in Postgres (the SDK's session store must be backed by the database,
  not memory). No in-memory session affinity assumptions anywhere in the new
  code.
- **Why MCP instead of a bespoke agent REST API:** standard tool discovery
  (`tools/list`) and typed schemas mean any MCP client can consume it later
  without a new integration per consumer. Stated honestly: with exactly one
  consumer (Ghost's skill CLI) in v1, MCP is heavier than REST + OAuth
  Bearer. We are paying that complexity deliberately, for future interop —
  it is the bet that matches the agentic-OS direction, not a free choice.

## 4. Authentication: MCP-spec OAuth with a device-flow approval step

Delegation uses OAuth 2.0, conforming to the **MCP authorization
specification** (protected-resource metadata at the well-known URI,
resource indicators per RFC 8707, audience-restricted tokens), so that any
spec-compliant MCP client can connect later — not just our CLI. The
human-approval step uses the **Device Authorization Grant (RFC 8628)**,
because the client (Ghost's VM) is headless and Brian's browser is the
approval device. A shared static Bearer token was considered and rejected:
no expiry, no scopes, no per-client revocation.

A second grant exists for clients that *can* drive a browser redirect: the
**Authorization Code Grant (RFC 6749 §4.1)** at `GET /oauth/authorize`, with
required PKCE (RFC 7636) and a per-client `allowed_redirect_uris`
allow-list (exact match; never redirect to an unlisted URI). It was added
so the Secure Vault's OAuth connector — which only speaks the
authorization-code flow — can hold a Front Row connection. The token
endpoint, scopes, and refresh-token rotation are shared with the device
grant.

### The session foundation (verified in code, 2026-09-29)

The device flow does not invent a new identity system; it builds on the
existing one:

- `server/index.ts` runs `setupAuth(app)` before routes: express-session
  with a Postgres store (`sessions` table, 1-week TTL, secure + httpOnly
  cookie) and passport with Replit OIDC (`https://replit.com/oidc`).
- The OIDC strategy is registered per-hostname
  (`replitauth:${req.hostname}`), so login works on the custom domain
  frontrow.maz.org, not just the Replit-assigned URL.
- Auth routes exist and the client exercises them: `GET /api/login`,
  `GET /api/callback`, `GET /api/logout`; the React client fetches
  `GET /api/auth/user` (the one route protected by `isAuthenticated`) and
  redirects to `/api/logout`.
- `getUserId(req)` is `req.user?.claims?.sub || "demo-user"` — a live
  session resolves to Brian's Replit `sub`; no session resolves to the
  (empty) demo-user namespace.

### Flow

1. The agent CLI begins the device flow and receives a `device_code`,
   a human-typable `user_code`, and a `verification_uri`.
2. Brian opens the verification URI in his browser. The page is protected
   by the **existing `isAuthenticated` middleware** — only his live
   session can load it. It shows: *"Ghost is requesting access:
   `library:read`, `library:write`"* → Approve / Deny.
3. Approval binds the grant to the approver: `user_id =
   req.user.claims.sub`. No user id needs to be known or configured in
   advance.
4. The CLI polls the token endpoint (RFC 8628 §3.5: ~5s interval,
   `authorization_pending` / `slow_down` handling) until approval, then
   receives a short-lived **access token** and a rotating **refresh
   token**.
5. MCP calls carry `Authorization: Bearer <access_token>`. The `/mcp`
   middleware validates the token (audience, expiry, revocation) and
   enforces the scope required by each tool. **Token invalid → 401. There
   is no demo-user fallback on this surface, ever** — unlike the UI API.

### Token lifetimes (decision recorded)

- Access token: **1 hour**. Bounds the blast radius of a leaked bearer
  credential; the skill CLI refreshes transparently (401 → refresh →
  retry), so neither Brian nor Ghost ever notices.
- Refresh token: **90 days, rotating**. Sets the human-visible cadence:
  ~4×/year Brian gets a ~30-second re-approval in his browser. Rotation
  issues a new refresh token per use (brief grace period for the old one
  so concurrent requests don't 401); presenting an already-rotated refresh
  token is treated as compromise signal and **revokes the whole grant**.
- Revocation is immediate and per-client: revoking the refresh token (or
  the grant) invalidates everything now, regardless of lifetimes.

### Scopes (v1)

- `library:read` — library, search, show details, queue, releases,
  recommendations, upcoming episodes, sync status, event drain.
- `library:write` — add/remove shows, episode status changes, dismissals.

Two scopes are enough for v1; they can be split finer later without
breaking the flow.

### Data model (new tables, via Drizzle in `shared/schema.ts`)

- `oauth_clients` — pre-registered clients (`ghost` in v1; no dynamic
  client registration yet): `client_id` (PK), `name`, `created_at`.
- `oauth_device_codes` — `device_code` (PK, **hashed**), `user_code`
  (unique, from an unambiguous alphabet), `client_id`, `scopes`,
  `status` (`pending`/`approved`/`denied`/`expired`),
  `approved_by_user_id` (the approver's `claims.sub`), `expires_at`
  (10 min), `created_at`. Verification attempts are rate-limited
  (brute-force protection on the user code).
- `oauth_tokens` — `id` (PK), `client_id`, `user_id`, `scopes`,
  `access_token_hash`, `refresh_token_hash`, `access_expires_at`,
  `refresh_expires_at`, `revoked_at` (nullable), `created_at`.
  Token values are shown once and stored **hashed (SHA-256)**; lookups
  are by hash with constant-time comparison. Token material is never
  written to logs.

### Verification page

A minimal server-rendered page at `/oauth/device` (or a small React
route): enter `user_code` → shows client name + requested scopes →
Approve / Deny. Protected by `isAuthenticated`; CSRF-protected like the
rest of the app.

### Revocation

`DELETE /oauth/tokens/:id` (session-authenticated) and/or a small section
in the UI listing authorized clients with per-client revoke. Revoking the
refresh token invalidates the whole grant immediately.

## 5. Tool surface (v1)

Each tool answers one user intent in one call. All tools resolve the user
from the access token — never from a request parameter. **Group-aware from
v1** (decision recorded): tools respect the shared-vs-personal episode
ownership split, and write results state when an action affected the
family view too, so the agent can report blast radius accurately.

| Tool | Scope | Backing logic |
|---|---|---|
| `queue_next_up` | read | Next unwatched episode per followed show, ordered by airdate. Unions group and personal episode records without double-counting; excludes removed shows and honors `hide_finished_shows`. This is "what's next in the queue" computed server-side. |
| `library_list` | read | `storage.getUserShows`, with status filters. |
| `library_search` | read | `storage.searchUserShows` + `searchUserEpisodes` (same composition as `GET /api/search`). |
| `catalog_search` | read | TVMaze show search (existing proxy logic). Per-token rate-limited (see §11). |
| `show_get` | read | Show details + episode list with the user's statuses. Includes `last_synced_at` so the agent can qualify staleness ("synced 6h ago") or trigger a refresh. |
| `show_add` | write | The existing add-show flow: sync from TVMaze, async episode import, scrobble import, TVMaze follow. Returns the sync job id immediately; the client polls `sync_status`. |
| `sync_status` | read | Status/progress of an async job started by `show_add` (existing `/api/sync/:id/status` shape, MCP-native). |
| `show_remove` | write | Soft remove (+ TVMaze unfollow, as today). |
| `episode_set_status` | write | Set `watched`/`skipped`/`next`/`later`/`untriaged` for one episode or an episode range. Goes through the existing ownership-aware storage methods — never raw writes. On a shared show, the result states the family view was affected. |
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
nothing here: episodes air on fixed schedules, so same-day awareness is
all that matters. The design is therefore **poll mechanics with event
semantics**:

- New `events` table: `id` (PK), `type`, `payload` (jsonb), `dedupe_key`
  (unique, nullable), `created_at`, `processed_at` (nullable),
  `processed_by` (nullable). Index on `(processed_at, created_at)`.
- **Producers** (wired into existing jobs, no behavior change otherwise)
  must be **idempotent**: a scheduler that runs twice must not double-emit.
  Enforced via `dedupe_key` (e.g. `episode.imported:<show_id>:<episode_id>`)
  with insert-on-conflict-do-nothing.
  - episode scheduler → `episode.imported` (new episodes added to a
    followed show), `sync.completed` / `sync.failed`;
  - new-releases refresh → `premiere.flagged`;
  - recommendation refresh → `recommendations.refreshed`.
- **Consumer:** Ghost drains via `events_drain` on its own schedule
  (cron), which claims rows with `SELECT … FOR UPDATE SKIP LOCKED` and
  marks them processed — exactly-once even under concurrent drains,
  nothing missed, nothing double-reported. Reporting to Brian follows the
  no-noise contract: only genuinely new items surface.
- **Retention:** processed events older than 30 days are pruned (by the
  drain or a scheduled cleanup) so the table doesn't grow forever.

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
  `isAuthenticated` is imported in `server/routes.ts` but applied only to
  `GET /api/auth/user`; the rest use `getUserId` with its `"demo-user"`
  fallback. Anyone on the internet can read/write the demo-user namespace
  today (it happens to be empty).
- This track deliberately does **not** change that behavior — hardening
  the UI API is a separate decision with its own blast radius (it touches
  Brian's live browser session flow). Tracked separately.
- On the new surface the invariant is absolute: no demo-user fallback,
  invalid token → 401, scope mismatch → 403.

## 9. Sequencing (follow-up PRs after this doc is approved)

1. **DB migration** — `oauth_clients`, `oauth_device_codes`,
   `oauth_tokens`, `events` tables (Drizzle; `shared/schema.ts`).
2. **OAuth device flow** — device-code endpoint, verification page at
   `/oauth/device` (protected by existing `isAuthenticated`), token
   endpoint, revocation. Include a smoke test that the production login
   flow still round-trips on the custom domain.
3. **MCP server + read tools** — `/mcp` mount, Bearer auth middleware,
   scope enforcement, read-only tools. Demonstrate the 403 on
   scope-mismatch before merge (see §11).
4. **MCP write tools** — `show_add`/`sync_status`, `show_remove`,
   `episode_set_status`, dismissals. Group-aware per §5.
5. **Outbox producers** — wire idempotent event emission into the
   schedulers.
6. **Ghost skill** (in `bcm/muse-skills`, separate repo) — MCP client CLI
   plus the device-flow auth dance; tokens live in the secure vault, never
   in the repo.

## 10. Decisions recorded (2026-09-29)

1. **Auth conformance:** implement per the MCP authorization spec (any
   spec-compliant client can connect later), with the device grant as the
   headless-client approval step. Not a bespoke one-off protocol.
2. **Group model:** group-aware tools from v1, not personal-only. Write
   results state family-view blast radius.
3. **Token lifetimes:** 1h access / 90d rotating refresh, reuse-detection
   revokes the grant (rationale in §4).
4. **Session foundation:** verified in code — the existing Replit OIDC
   session is the approval identity; no new identity system.
5. **Scope of this track:** §8 stays out; UI-route hardening is a separate
   track.

## 11. Implementation guardrails (for the Replit Agent)

These are non-negotiable instructions for whoever implements §§4–6:

1. **Surgical diffs.** Do not change UI routes, scheduler timing, or
   existing API response shapes. Mounting `/mcp` and the OAuth endpoints
   must not alter current behavior.
2. **No demo-user fallback on the new surface.** Invalid/expired token →
   401; valid token with insufficient scope → 403. Never silently resolve
   to another user.
3. **Token hygiene.** Store only SHA-256 hashes; constant-time compare;
   never log token material, user codes, or device codes. This codebase
   logs freely (scrobble samples and all) — the prohibition is explicit
   here.
4. **Idempotent producers.** Event emission uses `dedupe_key` with
   insert-on-conflict-do-nothing. A scheduler running twice must not
   double-emit.
5. **Prove scope enforcement.** Before merging the read-tools PR, demonstrate
   a `library:read` token calling a write tool → 403. Demonstrated, not
   asserted.
6. **Rate-limit the proxied calls.** `catalog_search` and any other
   TVMaze-proxied tool get per-token rate limiting — the new surface must
   not become an abuse vector past the existing polite batching.
7. **Stateless across replicas.** No in-memory session/device-code/MCP
   session state. Everything in Postgres.
8. **Build stays green.** `npm run build` (vite + esbuild) must pass on
   every PR; confirm the MCP SDK bundles correctly under the esbuild
   config (check `--packages=external` handling).
9. **No drive-by fixes.** Do not "fix" the demo-user fallback on `/api/*`
   while in here. Out of scope on purpose.
10. **Regression smoke after every PR.** Dashboard loads, library returns
    Brian's shows, schedulers still scheduled, login flow still
    round-trips.
11. **Migrations via Drizzle.** New tables go in `shared/schema.ts`;
    no hand-written SQL bypassing the schema.
12. **Workspace hygiene.** Local `main` was 1 commit ahead of
    `origin/main` on 2026-09-29 — reconcile before merging anything to
    `main`.

## 12. Edge cases considered

- **Concurrent drains:** `events_drain` claims rows with
  `SELECT … FOR UPDATE SKIP LOCKED`; two Ghost crons (or a retry) can't
  double-deliver.
- **Outbox growth:** processed events older than 30 days are pruned.
- **Device-flow abuse:** 10-minute code expiry, rate-limited verification
  attempts, unambiguous user-code alphabet, RFC 8628 polling
  interval/backoff (`authorization_pending`, `slow_down`).
- **Refresh races:** rotation keeps a brief grace period for the previous
  refresh token; small clock-skew leeway on expiry checks.
- **Long jobs:** `show_add` returns a job id immediately; `sync_status`
  polls it. If the grant is revoked mid-job, the job completes
  server-side but status polling 401s — acceptable and documented.
- **Queue correctness:** `queue_next_up` excludes removed shows, honors
  `hide_finished_shows`, and unions group + personal records without
  double-counting.
- **Staleness:** `show_get` (and queue results) expose `last_synced_at`
  so the agent qualifies answers or triggers a refresh instead of
  presenting stale data as fresh.
- **Shared-show writes:** `episode_set_status` on a shared show affects
  everyone; the tool result says so.
- **MCP SDK churn:** pin the SDK version; record which spec version the
  implementation targets in the PR.
