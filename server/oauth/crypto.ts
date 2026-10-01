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
