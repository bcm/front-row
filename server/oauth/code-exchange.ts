// Authorization Code Grant (RFC 6749 §4.1.3): token-endpoint exchange.
//
// Public client (no secret), consistent with the device flow: the body
// client_id must match the code's client. PKCE (RFC 7636) is required and
// verified against the authorization request's challenge. Codes are
// atomically consumed before tokens are minted, so concurrent exchanges
// cannot both use the same code.

import type { Request, Response } from "express";
import { and, eq, gt } from "drizzle-orm";
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
  if (!row.codeChallenge || !pkceValid(row.codeChallenge, row.codeChallengeMethod, str(req.body?.code_verifier))) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  const [consumed] = await db
    .delete(oauthAuthorizationCodes)
    .where(
      and(
        eq(oauthAuthorizationCodes.codeHash, row.codeHash),
        gt(oauthAuthorizationCodes.expiresAt, new Date())
      )
    )
    .returning({ codeHash: oauthAuthorizationCodes.codeHash });
  if (!consumed) {
    res.status(400).json({ error: "invalid_grant" });
    return;
  }
  const tokens = await mintTokenGrant(row.clientId, row.userId, row.scopes);
  res.json(tokenResponse(tokens, row.scopes));
}
