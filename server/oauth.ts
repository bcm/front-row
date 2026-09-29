// OAuth 2.0 for the agent interface (docs/agent-interface-design.md §4).
//
// Authorization conforms to the MCP authorization spec: protected-resource
// metadata (RFC 9728), RFC 8707 resource indicators, and audience-restricted
// bearer tokens, so any spec-compliant MCP client can connect later. The
// human-approval step uses the Device Authorization Grant (RFC 8628),
// because the client (Ghost's VM) is headless and Brian approves in his
// browser, authenticated by the existing Replit OIDC session
// (server/replit_integrations/auth).
//
// Security invariants:
// - Token values are shown once and stored as SHA-256 hashes. Token material
//   is never logged.
// - There is no demo-user fallback on this surface: invalid token → 401,
//   insufficient scope → 403.
// - The verification page requires Brian's live session (isAuthenticated);
//   approval binds the grant to the approver's claims.sub. Approval forms
//   carry a synchronizer CSRF token (the app has no global CSRF middleware).

import type { Express, Request, Response, NextFunction } from "express";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "./db";
import { oauthClients, oauthDeviceCodes, oauthTokens } from "@shared/schema";
import { isAuthenticated } from "./replit_integrations/auth";

export const OAUTH_SCOPES = ["library:read", "library:write"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

const DEVICE_CODE_TTL_SEC = 600; // 10 minutes (RFC 8628 §3.2)
const DEVICE_POLL_INTERVAL_SEC = 5; // RFC 8628 §3.5
const ACCESS_TOKEN_TTL_SEC = 3600; // 1 hour
const REFRESH_TOKEN_TTL_SEC = 90 * 24 * 3600; // 90 days, rotating
const ROTATION_GRACE_SEC = 60; // old refresh token stays usable this long after rotation
const VERIFY_ATTEMPTS_PER_MINUTE = 20; // per-session throttle on the approval form

// Crockford-style alphabet: no vowels (no accidental words), no 0/O/1/I.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

function newUserCode(): string {
  let code = "";
  const bytes = randomBytes(8);
  for (const b of bytes) code += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
  return code;
}

function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

function isLoggedIn(req: Request): boolean {
  const fn = (req as any).isAuthenticated;
  return typeof fn === "function" ? fn.call(req) : false;
}

function sessionUserId(req: Request): string | undefined {
  return (req as any).user?.claims?.sub;
}

// ---------------------------------------------------------------------------
// MCP auth middleware (used by the /mcp server in a later PR)
// ---------------------------------------------------------------------------

export interface McpAuthContext {
  userId: string;
  clientId: string;
  scopes: string[];
}

function unauthorized(res: Response, req: Request, description: string): void {
  // MCP authorization spec: 401s carry the protected-resource metadata URL.
  res.set(
    "WWW-Authenticate",
    `Bearer resource_metadata="${baseUrl(req)}/.well-known/oauth-protected-resource/mcp", ` +
      `error="invalid_token", error_description="${description}"`
  );
  res.status(401).json({ error: "invalid_token", error_description: description });
}

export async function requireMcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const header = req.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9\-_]+)$/.exec(header.trim());
    if (!match) {
      unauthorized(res, req, "missing or malformed bearer token");
      return;
    }
    const [row] = await db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.accessTokenHash, sha256Hex(match[1])));
    const now = new Date();
    if (!row || row.revokedAt || row.accessExpiresAt < now) {
      unauthorized(res, req, "invalid or expired token");
      return;
    }
    (req as any).mcpAuth = {
      userId: row.userId,
      clientId: row.clientId,
      scopes: row.scopes,
    } satisfies McpAuthContext;
    next();
  } catch (err) {
    next(err);
  }
}

export function requireScope(scope: OAuthScope) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = (req as any).mcpAuth as McpAuthContext | undefined;
    if (!auth || !auth.scopes.includes(scope)) {
      res.status(403).json({
        error: "insufficient_scope",
        error_description: `this operation requires the ${scope} scope`,
      });
      return;
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Token minting / rotation
// ---------------------------------------------------------------------------

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

async function mintTokenGrant(clientId: string, userId: string, scopes: string[]): Promise<IssuedTokens> {
  const accessToken = newOpaqueToken();
  const refreshToken = newOpaqueToken();
  const now = new Date();
  await db.insert(oauthTokens).values({
    clientId,
    userId,
    scopes,
    accessTokenHash: sha256Hex(accessToken),
    refreshTokenHash: sha256Hex(refreshToken),
    accessExpiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SEC * 1000),
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SEC * 1000),
  });
  return { accessToken, refreshToken };
}

function tokenResponse(tokens: IssuedTokens, scopes: string[]): Record<string, unknown> {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SEC,
    refresh_token: tokens.refreshToken,
    refresh_expires_in: REFRESH_TOKEN_TTL_SEC,
    scope: scopes.join(" "),
  };
}

// Rotate a token row: issue fresh tokens, mark the old row rotated+revoked.
async function rotateRow(
  row: typeof oauthTokens.$inferSelect,
  res: Response
): Promise<void> {
  const tokens = await mintTokenGrant(row.clientId, row.userId, row.scopes);
  const now = new Date();
  await db
    .update(oauthTokens)
    .set({ rotatedAt: now, revokedAt: now })
    .where(eq(oauthTokens.id, row.id));
  res.json(tokenResponse(tokens, row.scopes));
}

async function revokeGrantFamily(clientId: string, userId: string): Promise<void> {
  await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthTokens.clientId, clientId),
        eq(oauthTokens.userId, userId),
        isNull(oauthTokens.revokedAt)
      )
    );
}

// ---------------------------------------------------------------------------
// POST /oauth/device/code — RFC 8628 §3.1
// ---------------------------------------------------------------------------

async function handleDeviceCode(req: Request, res: Response): Promise<void> {
  try {
    const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
    const scopeParam = typeof req.body?.scope === "string" ? req.body.scope : "";
    const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
    if (!client) {
      res.status(400).json({ error: "invalid_client", error_description: "unknown client_id" });
      return;
    }
    const allowed = new Set(client.allowedScopes ?? []);
    const scopes = scopeParam ? scopeParam.split(/\s+/).filter(Boolean) : [...allowed];
    if (scopes.length === 0 || scopes.some((s: string) => !allowed.has(s))) {
      res.status(400).json({ error: "invalid_scope", error_description: "requested scope not allowed for this client" });
      return;
    }
    const deviceCode = newOpaqueToken();
    const userCode = newUserCode();
    const now = new Date();
    await db.insert(oauthDeviceCodes).values({
      deviceCodeHash: sha256Hex(deviceCode),
      userCode,
      clientId,
      scopes,
      expiresAt: new Date(now.getTime() + DEVICE_CODE_TTL_SEC * 1000),
    });
    const verificationUri = `${baseUrl(req)}/oauth/device`;
    res.json({
      device_code: deviceCode,
      user_code: formatUserCode(userCode),
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${formatUserCode(userCode)}`,
      expires_in: DEVICE_CODE_TTL_SEC,
      interval: DEVICE_POLL_INTERVAL_SEC,
    });
  } catch (err) {
    res.status(500).json({ error: "server_error" });
  }
}

// ---------------------------------------------------------------------------
// POST /oauth/token — device_code grant (RFC 8628 §3.5) and refresh_token
// ---------------------------------------------------------------------------

async function handleDeviceCodeGrant(req: Request, res: Response): Promise<void> {
  const deviceCode = typeof req.body?.device_code === "string" ? req.body.device_code : "";
  const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
  const [row] = await db
    .select()
    .from(oauthDeviceCodes)
    .where(eq(oauthDeviceCodes.deviceCodeHash, sha256Hex(deviceCode)));
  const now = new Date();
  // Deliberately generic: don't reveal whether the code exists.
  if (!row || row.clientId !== clientId) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  if (row.status === "denied") {
    res.status(400).json({ error: "access_denied", error_description: "the user denied the request" });
    return;
  }
  if (row.expiresAt < now) {
    await db.update(oauthDeviceCodes).set({ status: "expired" }).where(eq(oauthDeviceCodes.deviceCodeHash, row.deviceCodeHash));
    res.status(400).json({ error: "expired_token", error_description: "the device code expired" });
    return;
  }
  if (row.status !== "approved" || !row.approvedByUserId) {
    res.status(400).json({ error: "authorization_pending", error_description: "waiting for user approval" });
    return;
  }
  // Single-use: the code row is consumed by the exchange.
  const tokens = await mintTokenGrant(row.clientId, row.approvedByUserId, row.scopes);
  await db.delete(oauthDeviceCodes).where(eq(oauthDeviceCodes.deviceCodeHash, row.deviceCodeHash));
  res.json(tokenResponse(tokens, row.scopes));
}

async function handleRefreshGrant(req: Request, res: Response): Promise<void> {
  const refreshToken = typeof req.body?.refresh_token === "string" ? req.body.refresh_token : "";
  const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
  if (!refreshToken || !clientId) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.refreshTokenHash, sha256Hex(refreshToken)));
  const now = new Date();
  if (!row || row.clientId !== clientId) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  // Manually revoked (not via rotation): dead, no grace period.
  if (row.revokedAt && !row.rotatedAt) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  if (row.refreshExpiresAt < now) {
    res.status(400).json({ error: "invalid_grant", error_description: "refresh token expired" });
    return;
  }
  if (row.revokedAt && row.rotatedAt) {
    // This refresh token was already rotated. Within the grace window this is
    // a benign concurrent request: rotate the *current* grant row again so
    // the caller gets fresh tokens instead of a spurious 401. Past the grace
    // window it looks like token theft: nuke the whole grant family.
    if (now.getTime() - row.rotatedAt.getTime() > ROTATION_GRACE_SEC * 1000) {
      await revokeGrantFamily(row.clientId, row.userId);
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    const [current] = await db
      .select()
      .from(oauthTokens)
      .where(
        and(
          eq(oauthTokens.clientId, row.clientId),
          eq(oauthTokens.userId, row.userId),
          isNull(oauthTokens.revokedAt)
        )
      )
      .orderBy(desc(oauthTokens.createdAt))
      .limit(1);
    if (!current) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    await rotateRow(current, res);
    return;
  }
  await rotateRow(row, res);
}

async function handleToken(req: Request, res: Response): Promise<void> {
  try {
    const grantType = req.body?.grant_type;
    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      await handleDeviceCodeGrant(req, res);
    } else if (grantType === "refresh_token") {
      await handleRefreshGrant(req, res);
    } else {
      res.status(400).json({ error: "unsupported_grant_type" });
    }
  } catch (err) {
    res.status(500).json({ error: "server_error" });
  }
}

// ---------------------------------------------------------------------------
// Verification page — GET /oauth/device, POST /oauth/device/approve|deny
// ---------------------------------------------------------------------------

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1115; color: #e8eaf0;
         display: flex; justify-content: center; padding: 48px 16px; margin: 0; }
  main { max-width: 440px; width: 100%; background: #171a21; border: 1px solid #2a2e3a;
         border-radius: 12px; padding: 32px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #aab0c0; line-height: 1.5; }
  ul { padding-left: 20px; color: #aab0c0; }
  code { background: #0f1115; padding: 2px 8px; border-radius: 6px; font-size: 18px;
         letter-spacing: 2px; }
  input[type=text] { width: 100%; box-sizing: border-box; font-size: 18px; padding: 10px 12px;
         letter-spacing: 2px; text-transform: uppercase; background: #0f1115; color: #e8eaf0;
         border: 1px solid #2a2e3a; border-radius: 8px; margin: 12px 0; }
  .row { display: flex; gap: 12px; margin-top: 16px; }
  button { flex: 1; font-size: 16px; padding: 12px; border: none; border-radius: 8px; cursor: pointer; }
  .approve { background: #4f8ff7; color: #fff; }
  .deny { background: #2a2e3a; color: #e8eaf0; }
  .single { width: 100%; background: #4f8ff7; color: #fff; }
  .error { color: #f77; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

function csrfToken(req: Request): string {
  const session = req.session as any;
  if (!session.oauthCsrf) session.oauthCsrf = randomBytes(16).toString("hex");
  return session.oauthCsrf;
}

// Per-session throttle on verification attempts (session store is Postgres,
// so this works across autoscale replicas).
function verificationAttemptsAllowed(req: Request): boolean {
  const session = req.session as any;
  const now = Date.now();
  const state = session.oauthAttempts ?? { count: 0, resetAt: now + 60_000 };
  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + 60_000;
  }
  state.count += 1;
  session.oauthAttempts = state;
  return state.count <= VERIFY_ATTEMPTS_PER_MINUTE;
}

async function lookupPendingCode(userCode: string) {
  const [row] = await db
    .select()
    .from(oauthDeviceCodes)
    .where(eq(oauthDeviceCodes.userCode, userCode));
  if (!row || row.status !== "pending" || row.expiresAt < new Date()) return null;
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, row.clientId));
  return { row, client };
}

async function handleDevicePage(req: Request, res: Response): Promise<void> {
  if (!isLoggedIn(req)) {
    res.redirect("/api/login");
    return;
  }
  try {
    const codeParam = typeof req.query.code === "string" ? normalizeUserCode(req.query.code) : "";
    if (!codeParam) {
      res.send(
        page(
          "Front Row — connect a device",
          `<h1>Connect a device</h1>
           <p>Enter the code shown by the app requesting access to your Front Row library.</p>
           <form method="get" action="/oauth/device">
             <input type="text" name="code" placeholder="XXXX-XXXX" autocomplete="off" autofocus>
             <button class="single" type="submit">Continue</button>
           </form>`
        )
      );
      return;
    }
    const found = await lookupPendingCode(codeParam);
    if (!found) {
      res.send(
        page(
          "Front Row — invalid code",
          `<h1 class="error">Invalid or expired code</h1>
           <p>That code doesn't match a pending request, or it already expired (codes last 10 minutes). Ask the app for a fresh code.</p>`
        )
      );
      return;
    }
    const { row, client } = found;
    const scopes = row.scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join("");
    const minutesLeft = Math.max(1, Math.round((row.expiresAt.getTime() - Date.now()) / 60000));
    res.send(
      page(
        "Front Row — approve access",
        `<h1>Approve access?</h1>
         <p><strong>${esc(client?.name ?? row.clientId)}</strong> is requesting access to your Front Row library with these permissions:</p>
         <ul>${scopes}</ul>
         <p>This code expires in about ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.</p>
         <div class="row">
           <form method="post" action="/oauth/device/approve" style="flex:1;display:flex">
             <input type="hidden" name="user_code" value="${esc(row.userCode)}">
             <input type="hidden" name="csrf" value="${esc(csrfToken(req))}">
             <button class="approve" type="submit">Approve</button>
           </form>
           <form method="post" action="/oauth/device/deny" style="flex:1;display:flex">
             <input type="hidden" name="user_code" value="${esc(row.userCode)}">
             <input type="hidden" name="csrf" value="${esc(csrfToken(req))}">
             <button class="deny" type="submit">Deny</button>
           </form>
         </div>`
      )
    );
  } catch (err) {
    res.status(500).send(page("Front Row — error", `<h1 class="error">Something went wrong</h1><p>Please try again.</p>`));
  }
}

async function handleApprove(req: Request, res: Response): Promise<void> {
  if (!isLoggedIn(req)) {
    res.redirect("/api/login");
    return;
  }
  try {
    if (typeof req.body?.csrf !== "string" || req.body.csrf !== (req.session as any)?.oauthCsrf) {
      res.status(403).send(page("Front Row — forbidden", `<h1 class="error">Invalid form token</h1><p>Please reload the page and try again.</p>`));
      return;
    }
    if (!verificationAttemptsAllowed(req)) {
      res.status(429).send(page("Front Row — slow down", `<h1 class="error">Too many attempts</h1><p>Wait a minute and try again.</p>`));
      return;
    }
    const userCode = normalizeUserCode(typeof req.body?.user_code === "string" ? req.body.user_code : "");
    const found = await lookupPendingCode(userCode);
    if (!found) {
      res.send(page("Front Row — invalid code", `<h1 class="error">Invalid or expired code</h1><p>That code doesn't match a pending request.</p>`));
      return;
    }
    const userId = sessionUserId(req);
    if (!userId) {
      res.redirect("/api/login");
      return;
    }
    await db
      .update(oauthDeviceCodes)
      .set({ status: "approved", approvedByUserId: userId })
      .where(eq(oauthDeviceCodes.deviceCodeHash, found.row.deviceCodeHash));
    res.send(
      page(
        "Front Row — approved",
        `<h1>Access approved</h1>
         <p><strong>${esc(found.client?.name ?? found.row.clientId)}</strong> can now access your Front Row library. You can close this window and return to your agent.</p>
         <p>Revoke access anytime from the authorized-apps section.</p>`
      )
    );
  } catch (err) {
    res.status(500).send(page("Front Row — error", `<h1 class="error">Something went wrong</h1><p>Please try again.</p>`));
  }
}

async function handleDeny(req: Request, res: Response): Promise<void> {
  if (!isLoggedIn(req)) {
    res.redirect("/api/login");
    return;
  }
  try {
    if (typeof req.body?.csrf !== "string" || req.body.csrf !== (req.session as any)?.oauthCsrf) {
      res.status(403).send(page("Front Row — forbidden", `<h1 class="error">Invalid form token</h1><p>Please reload the page and try again.</p>`));
      return;
    }
    const userCode = normalizeUserCode(typeof req.body?.user_code === "string" ? req.body.user_code : "");
    const [row] = await db.select().from(oauthDeviceCodes).where(eq(oauthDeviceCodes.userCode, userCode));
    if (row && row.status === "pending") {
      await db
        .update(oauthDeviceCodes)
        .set({ status: "denied" })
        .where(eq(oauthDeviceCodes.deviceCodeHash, row.deviceCodeHash));
    }
    res.send(
      page(
        "Front Row — denied",
        `<h1>Access denied</h1><p>The request was denied. The app was not granted access. You can close this window.</p>`
      )
    );
  } catch (err) {
    res.status(500).send(page("Front Row — error", `<h1 class="error">Something went wrong</h1><p>Please try again.</p>`));
  }
}

// ---------------------------------------------------------------------------
// DELETE /oauth/tokens/:id — revoke a grant family (session-authenticated)
// ---------------------------------------------------------------------------

async function handleRevoke(req: Request, res: Response): Promise<void> {
  try {
    const userId = sessionUserId(req);
    if (!userId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    const tokenId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const [token] = await db.select().from(oauthTokens).where(eq(oauthTokens.id, tokenId ?? ""));
    if (!token || token.userId !== userId) {
      res.status(404).json({ message: "Not found" });
      return;
    }
    // Per-client revocation: kill the whole grant family, immediately.
    await revokeGrantFamily(token.clientId, token.userId);
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ message: "Internal Server Error" });
  }
}

// ---------------------------------------------------------------------------
// MCP authorization-spec metadata (RFC 9728 / RFC 8414)
// ---------------------------------------------------------------------------

function protectedResourceMetadata(req: Request, res: Response): void {
  const url = baseUrl(req);
  res.json({
    resource: `${url}/mcp`,
    authorization_servers: [url],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
  });
}

function authorizationServerMetadata(req: Request, res: Response): void {
  const url = baseUrl(req);
  res.json({
    issuer: url,
    device_authorization_endpoint: `${url}/oauth/device/code`,
    token_endpoint: `${url}/oauth/token`,
    scopes_supported: [...OAUTH_SCOPES],
    grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
    // This server does not use authorization codes/PKCE: the device grant is
    // the interactive step, per the headless-client design.
  });
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

async function ensureDefaultClients(): Promise<void> {
  // Pre-registered first-party clients (design §4: no dynamic registration
  // in v1). Idempotent: insert-on-conflict-do-nothing.
  await db
    .insert(oauthClients)
    .values({
      clientId: "ghost",
      name: "Ghost",
      allowedScopes: [...OAUTH_SCOPES],
    })
    .onConflictDoNothing();
}

export function registerOAuthRoutes(app: Express): void {
  // OAuth endpoints
  app.post("/oauth/device/code", handleDeviceCode);
  app.post("/oauth/token", handleToken);
  app.get("/oauth/device", handleDevicePage);
  app.post("/oauth/device/approve", handleApprove);
  app.post("/oauth/device/deny", handleDeny);
  app.delete("/oauth/tokens/:id", isAuthenticated, handleRevoke);

  // MCP authorization-spec metadata
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);

  // Seed pre-registered clients (async, best-effort at boot).
  ensureDefaultClients().catch((err) => console.error("Failed to seed OAuth clients:", err));
}
