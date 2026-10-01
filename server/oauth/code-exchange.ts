// Authorization Code Grant (RFC 6749 §4.1.3): token-endpoint exchange.
//
// Public client (no secret), consistent with the device flow: the body
// client_id must match the code's client. PKCE (RFC 7636) is verified when
// the authorization request carried a challenge. Codes are single-use: the
// row is deleted before tokens are minted, so a failure here can't leave a
// reusable code behind.

import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { oauthAuthorizationCodes } from "@shared/schema";
import { pkceS256Challenge, sha256Hex } from "./crypto";
import { mintTokenGrant, tokenResponse } from "./tokens";

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pkceValid(challenge: string, method: string | null, verifier: string): boolean {
  if (!verifier) return false;
  if (method === "S256") return pkceS256Challenge(verifier) === challenge;
  // "plain" (or no recorded method): the verifier is the challenge.
  return verifier === challenge;
}

export async function handleAuthorizationCodeGrant(req: Request, res: Response): Promise<void> {
  const code = str(req.body?.code);
  const clientId = str(req.body?.client_id);
  const redirectUri = str(req.body?.redirect_uri);
  const [row] = await db
    .select()
    .from(oauthAuthorizationCodes)
    .where(eq(oauthAuthorizationCodes.codeHash, sha256Hex(code)));
  // Deliberately generic: don't reveal whether the code exists.
  if (!row || row.clientId !== clientId || row.redirectUri !== redirectUri) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  if (row.expiresAt < new Date()) {
    await db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.codeHash, row.codeHash));
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  if (row.codeChallenge && !pkceValid(row.codeChallenge, row.codeChallengeMethod, str(req.body?.code_verifier))) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  await db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.codeHash, row.codeHash));
  const tokens = await mintTokenGrant(row.clientId, row.userId, row.scopes);
  res.json(tokenResponse(tokens, row.scopes));
}
