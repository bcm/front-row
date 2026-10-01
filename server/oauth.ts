// OAuth 2.0 for the agent interface (docs/agent-interface-design.md §4).
//
// Authorization conforms to the MCP authorization spec: protected-resource
// metadata (RFC 9728), RFC 8707 resource indicators, and audience-restricted
// bearer tokens, so any spec-compliant MCP client can connect later. The
// human-approval step uses the Device Authorization Grant (RFC 8628),
// because the client (Ghost's VM) is headless and Brian approves in his
// browser, authenticated by the existing Replit OIDC session
// (server/replit_integrations/auth). The Authorization Code Grant
// (RFC 6749 §4.1, server/oauth/authorize.ts) exists for clients that can
// drive a browser redirect — e.g. the Secure Vault's OAuth connector — with
// optional PKCE (RFC 7636) and a per-client redirect-URI allow-list.
//
// Security invariants:
// - Token values are shown once and stored as SHA-256 hashes. Token material
//   is never logged.
// - There is no demo-user fallback on this surface: invalid token → 401,
//   insufficient scope → 403.
// - The verification page requires Brian's live session (isAuthenticated);
//   approval binds the grant to the approver's claims.sub. Approval forms
//   carry a synchronizer CSRF token (the app has no global CSRF middleware).
//
// Module layout: server/oauth/ holds the implementation (crypto, request
// helpers, middleware, token lifecycle, device grants, authorization-code
// grant, verification pages);
// this file wires routes and seeds the pre-registered clients.

import type { Express, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { oauthClients, oauthTokens } from "@shared/schema";
import { isAuthenticated } from "./replit_integrations/auth";
import { baseUrl, sessionUserId } from "./oauth/request";
import { OAUTH_SCOPES, revokeGrantFamily } from "./oauth/tokens";
import { handleDeviceCode, handleToken } from "./oauth/device";
import { handleAuthorize, handleDecision } from "./oauth/authorize";
import { handleApprove, handleDeny, handleDevicePage } from "./oauth/verify";

// DELETE /oauth/tokens/:id — revoke a grant family (session-authenticated).
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

// MCP authorization-spec metadata (RFC 9728 / RFC 8414).
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
    authorization_endpoint: `${url}/oauth/authorize`,
    device_authorization_endpoint: `${url}/oauth/device/code`,
    token_endpoint: `${url}/oauth/token`,
    response_types_supported: ["code"],
    scopes_supported: [...OAUTH_SCOPES],
    grant_types_supported: [
      "authorization_code",
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ],
    code_challenge_methods_supported: ["S256", "plain"],
  });
}

async function ensureDefaultClients(): Promise<void> {
  // Pre-registered first-party clients (design §4: no dynamic registration
  // in v1). Idempotent: insert-on-conflict-do-nothing.
  await db
    .insert(oauthClients)
    .values({
      clientId: "ghost",
      name: "Ghost",
      allowedScopes: [...OAUTH_SCOPES],
      // Redirect URIs are allow-listed per client; the vault's callback is
      // added here once known (follow-up).
      allowedRedirectUris: [],
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
  app.get("/oauth/authorize", handleAuthorize);
  app.post("/oauth/authorize/decision", handleDecision);
  app.delete("/oauth/tokens/:id", isAuthenticated, handleRevoke);

  // MCP authorization-spec metadata
  app.get("/.well-known/oauth-protected-resource", protectedResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResourceMetadata);
  app.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);

  // Seed pre-registered clients (async, best-effort at boot).
  ensureDefaultClients().catch((err) => console.error("Failed to seed OAuth clients:", err));
}
