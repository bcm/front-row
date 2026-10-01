// Random tokens, user codes, and hashing for the OAuth device flow.
// Token values are shown once and stored as SHA-256 hashes; token material
// is never logged.

import { createHash, randomBytes } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// PKCE (RFC 7636 §4.2): the S256 code_challenge is base64url(sha256(verifier)).
export function pkceS256Challenge(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

// RFC 7636 §4.1: code_challenge and code_verifier share the same syntax —
// 43–128 characters from the unreserved alphabet. Validated at authorize
// time (a short plain challenge could never be redeemed) and at exchange
// time (the exchange request is independently attacker-controlled).
const PKCE_SYNTAX = /^[A-Za-z0-9\-._~]{43,128}$/;

export function pkceSyntaxOk(value: string): boolean {
  return PKCE_SYNTAX.test(value);
}

// A code_challenge must be redeemable: plain shares the verifier syntax
// (43–128 unreserved chars), while S256 is base64url(sha256(verifier)),
// which is always exactly 43 characters. A longer S256 challenge can never
// match pkceS256Challenge(verifier), so reject it at authorize time instead
// of issuing a dead code.
export function pkceChallengeOk(challenge: string, method: string): boolean {
  if (!pkceSyntaxOk(challenge)) return false;
  if (method === "S256") return challenge.length === 43;
  return true;
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

// Crockford-style alphabet: no vowels (no accidental words), no 0/O/1/I.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

export function newUserCode(): string {
  let code = "";
  const bytes = randomBytes(8);
  for (const b of bytes) code += USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length];
  return code;
}

export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}
