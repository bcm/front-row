import { describe, expect, it, vi } from "vitest";

// replitAuth pulls in ./storage -> server/db, which throws without a
// DATABASE_URL. updateUserSession is pure logic; mock the storage away.
vi.mock("./storage", () => ({
  authStorage: { getUser: vi.fn(), upsertUser: vi.fn() },
}));

import { updateUserSession } from "./replitAuth";

function tokens(overrides: Record<string, unknown> = {}) {
  return {
    claims: () => ({ sub: "user-123", exp: 9999999999 }),
    access_token: "new-access-token",
    refresh_token: "new-refresh-token",
    ...overrides,
  } as any;
}

describe("updateUserSession", () => {
  it("stores the tokens and expiry from the response", () => {
    const user: any = {};
    updateUserSession(user, tokens());
    expect(user.access_token).toBe("new-access-token");
    expect(user.refresh_token).toBe("new-refresh-token");
    expect(user.expires_at).toBe(9999999999);
    expect(user.claims.sub).toBe("user-123");
  });

  it("keeps the old refresh token when the response omits it", () => {
    const user: any = { refresh_token: "old-refresh-token" };
    updateUserSession(user, tokens({ refresh_token: undefined }));
    expect(user.refresh_token).toBe("old-refresh-token");
    expect(user.access_token).toBe("new-access-token");
  });

  it("replaces the refresh token when the response rotates it", () => {
    const user: any = { refresh_token: "old-refresh-token" };
    updateUserSession(user, tokens({ refresh_token: "rotated-token" }));
    expect(user.refresh_token).toBe("rotated-token");
  });
});
