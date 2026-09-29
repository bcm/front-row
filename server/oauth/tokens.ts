// Token lifecycle: minting, rotation with a concurrency grace window and
// reuse detection, and grant-family revocation.

import type { Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { oauthTokens } from "@shared/schema";
import { newOpaqueToken, sha256Hex } from "./crypto";

export const OAUTH_SCOPES = ["library:read", "library:write"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export const ACCESS_TOKEN_TTL_SEC = 3600; // 1 hour
export const REFRESH_TOKEN_TTL_SEC = 90 * 24 * 3600; // 90 days, rotating
export const ROTATION_GRACE_SEC = 60; // old refresh token stays usable this long after rotation

interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

export async function mintTokenGrant(clientId: string, userId: string, scopes: string[]): Promise<IssuedTokens> {
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

export function tokenResponse(tokens: IssuedTokens, scopes: string[]): Record<string, unknown> {
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
export async function rotateRow(
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

export async function revokeGrantFamily(clientId: string, userId: string): Promise<void> {
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
