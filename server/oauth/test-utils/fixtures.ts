// Shared row fixtures for OAuth handler tests.

export function clientRow(overrides: Record<string, any> = {}): any {
  return {
    clientId: "ghost",
    name: "Ghost",
    allowedScopes: ["library:read", "library:write"],
    allowedRedirectUris: ["https://vault.example/callback"],
    createdAt: new Date(),
    ...overrides,
  };
}

export function deviceCodeRow(overrides: Record<string, any> = {}): any {
  return {
    deviceCodeHash: "deadbeef",
    userCode: "ABCD1234",
    clientId: "ghost",
    scopes: ["library:read"],
    status: "pending",
    approvedByUserId: null,
    expiresAt: new Date(Date.now() + 600_000),
    createdAt: new Date(),
    ...overrides,
  };
}

export function tokenRow(overrides: Record<string, any> = {}): any {
  return {
    id: "token-1",
    clientId: "ghost",
    userId: "user-1",
    scopes: ["library:read"],
    accessTokenHash: "ahash",
    refreshTokenHash: "rhash",
    accessExpiresAt: new Date(Date.now() + 3600_000),
    refreshExpiresAt: new Date(Date.now() + 90 * 24 * 3600_000),
    rotatedAt: null,
    revokedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

export function authCodeRow(overrides: Record<string, any> = {}): any {
  return {
    codeHash: "cafef00d",
    clientId: "ghost",
    userId: "user-1",
    redirectUri: "https://vault.example/callback",
    scopes: ["library:read"],
    codeChallenge: null,
    codeChallengeMethod: null,
    expiresAt: new Date(Date.now() + 600_000),
    createdAt: new Date(),
    ...overrides,
  };
}
