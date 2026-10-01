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

// An S256 challenge must be exactly what a real client can produce:
// base64url(sha256(verifier)) — the unpadded base64url encoding of 32
// bytes, always exactly 43 characters. The RFC 7636 unreserved alphabet is
// wider than base64url (it also allows "." and "~"), and not every 43-char
// base64url string is canonical: the final character carries 4 data bits,
// so its 2 trailing bits must be zero. Anything else passes authorization
// but can never equal base64url(sha256(verifier)) at exchange time, leaving
// the issued code unredeemable — reject it here instead.
const PKCE_S256_ALPHABET = /^[A-Za-z0-9_-]{43}$/;

export function pkceS256ChallengeOk(challenge: string): boolean {
  if (!PKCE_S256_ALPHABET.test(challenge)) return false;
  const bytes = Buffer.from(challenge, "base64url");
  // Round-trip through the decoder: canonical encodings re-encode to
  // themselves, non-canonical ones (nonzero trailing bits) do not.
  return bytes.length === 32 && bytes.toString("base64url") === challenge;
}

// A code_challenge must be redeemable: plain shares the verifier syntax
// (43–128 unreserved chars), while S256 must be a canonical unpadded
// base64url encoding of 32 bytes (see above). Reject anything else at
// authorize time instead of issuing a dead code.
export function pkceChallengeOk(challenge: string, method: string): boolean {
  if (method === "S256") return pkceS256ChallengeOk(challenge);
  return pkceSyntaxOk(challenge);
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
