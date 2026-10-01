// Token endpoint handlers: device-code issuance (RFC 8628 §3.1) and the
// token endpoint's device_code (RFC 8628 §3.5) and refresh_token grants.

import type { Request, Response } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { oauthClients, oauthDeviceCodes, oauthTokens } from "@shared/schema";
import { formatUserCode, newOpaqueToken, newUserCode, sha256Hex } from "./crypto";
import { baseUrl } from "./request";
import { handleAuthorizationCodeGrant } from "./code-exchange";
import {
  ROTATION_GRACE_SEC,
  mintTokenGrant,
  rotateRow,
  revokeGrantFamily,
  sendTokenResponse,
  tokenResponse,
} from "./tokens";

export const DEVICE_CODE_TTL_SEC = 600; // 10 minutes (RFC 8628 §3.2)
export const DEVICE_POLL_INTERVAL_SEC = 5; // RFC 8628 §3.5

export async function handleDeviceCode(req: Request, res: Response): Promise<void> {
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
  sendTokenResponse(res, tokenResponse(tokens, row.scopes));
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
    res.status(400).json({ error: "invalid_grant" });
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

export async function handleToken(req: Request, res: Response): Promise<void> {
  try {
    const grantType = req.body?.grant_type;
    if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
      await handleDeviceCodeGrant(req, res);
    } else if (grantType === "authorization_code") {
      await handleAuthorizationCodeGrant(req, res);
    } else if (grantType === "refresh_token") {
      await handleRefreshGrant(req, res);
    } else {
      res.status(400).json({ error: "unsupported_grant_type" });
    }
  } catch (err) {
    res.status(500).json({ error: "server_error" });
  }
}
