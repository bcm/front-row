// Bearer-token auth for the /mcp server (docs/agent-interface-design.md §4).
//
// Invariants: no demo-user fallback on this surface — invalid token → 401,
// insufficient scope → 403.

import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { oauthTokens } from "@shared/schema";
import { sha256Hex } from "./crypto";
import { baseUrl } from "./request";
import type { OAuthScope } from "./tokens";

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
