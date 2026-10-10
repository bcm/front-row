import { afterEach, describe, expect, it, vi } from "vitest";
import * as client from "openid-client";
import { updateUserSession } from "./session-tokens";

const now = 1800000000;
const identity = { sub: "synthetic-user", iat: now - 7200, exp: now - 3600 };
function savedUser() {
  return { claims: identity, access_token: "old-access", refresh_token: "old-refresh", expires_at: identity.exp };
}
function response(overrides: Record<string, unknown> = {}) {
  return {
    access_token: "new-access", expires_in: 3600,
    claims: () => undefined,
    ...overrides,
  } as any;
}
afterEach(() => { vi.restoreAllMocks(); });

describe("successful refresh response handling", () => {
  it.each([undefined, "rotated-refresh"])(
    "handles the real SDK response without an ID token (replacement refresh token: %s)",
    async refreshToken => {
      vi.spyOn(Date, "now").mockReturnValue(now * 1000);
      const config = new client.Configuration({
        issuer: "https://synthetic-provider.invalid",
        token_endpoint: "https://synthetic-provider.invalid/token",
      }, "synthetic-client");
      config[client.customFetch] = vi.fn(async () => new Response(JSON.stringify({
        access_token: "new-access", token_type: "Bearer", expires_in: 3600,
        ...(refreshToken ? { refresh_token: refreshToken } : {}),
      }), { status: 200, headers: { "content-type": "application/json" } }));
      const tokens = await client.refreshTokenGrant(config, "old-refresh");
      expect(tokens.claims()).toBeUndefined();
      const user = savedUser();
      updateUserSession(user, tokens);
      expect(user.claims).toBe(identity);
      expect(user.access_token).toBe("new-access");
      expect(user.refresh_token).toBe(refreshToken ?? "old-refresh");
      expect(user.expires_at).toBe(now + 3600);
      expect(user.access_token_received_at).toBe(now);
      // The old ID-token expiry is not the refreshed access-token expiry.
      expect(user.claims.exp).toBe(now - 3600);
    },
  );

  it("uses the access-token lifetime even when a fresh ID token has a different expiry", () => {
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const freshClaims = { sub: identity.sub, iat: now, exp: now + 7200 };
    const user = savedUser();
    updateUserSession(user, response({ claims: () => freshClaims }));
    expect(user.claims).toBe(freshClaims);
    expect(user.expires_at).toBe(now + 3600);
  });

  it("falls back to fresh ID-token expiry when expires_in is omitted", () => {
    const user = savedUser();
    updateUserSession(user, response({
      expires_in: undefined, claims: () => ({ ...identity, exp: now + 1800 }),
    }));
    expect(user.expires_at).toBe(now + 1800);
  });

  it("does not reuse an old identity expiry or invent a lifetime", () => {
    const user = savedUser();
    const before = { ...user };
    expect(() => updateUserSession(user, response({ expires_in: undefined })))
      .toThrow("Token response has no usable expiry");
    expect(user).toEqual(before);
  });

  it.each([NaN, Infinity, -1, "3600"])("rejects an invalid lifetime %s without mutating the session", lifetime => {
    const user = savedUser();
    const before = { ...user };
    expect(() => updateUserSession(user, response({ expires_in: lifetime }))).toThrow();
    expect(user).toEqual(before);
  });

  it("does not manufacture an initial identity when no ID token is supplied", () => {
    const user = {};
    expect(() => updateUserSession(user, response())).toThrow("Token response has no identity claims");
    expect(user).toEqual({});
  });
});
