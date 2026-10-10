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

vi.mock("openid-client", () => ({
  discovery: vi.fn(async () => ({})),
  refreshTokenGrant: vi.fn(),
}));

// Import after the mocks above; the module under test is already imported at
// the top of this file, so pull the new helper from it here.
import { isAuthenticated, refreshSessionTokens } from "./replitAuth";
import { refreshTokenGrant } from "openid-client";

const mockGrant = () => vi.mocked(refreshTokenGrant);

function grantTokens(overrides: Record<string, unknown> = {}) {
  return {
    claims: () => ({ sub: "user-123", exp: 9999999999 }),
    access_token: "new-access-token",
    refresh_token: "new-refresh-token",
    ...overrides,
  } as any;
}

// A minimal stand-in for express's req: session id, req.user, and a session
// with save/reload. Like the real flow, req.user and session.passport.user
// start as the same object. If freshUser is given, reload() swaps the session
// user to it, simulating another request's rotation landing in the store.
function mockReq(
  sessionID: string,
  opts: {
    staleUser?: any;
    freshUser?: any;
    saveImpl?: (cb: (err?: any) => void) => void;
  } = {},
) {
  const staleUser =
    opts.staleUser ?? { refresh_token: "rt", claims: {}, expires_at: 0 };
  const session: any = {
    passport: { user: staleUser },
    save: vi.fn(opts.saveImpl ?? ((cb: (err?: any) => void) => cb())),
    reload: vi.fn((cb: (err?: any) => void) => cb()),
  };
  if (opts.freshUser) {
    session.reload.mockImplementation((cb: (err?: any) => void) => {
      session.passport.user = opts.freshUser;
      cb();
    });
  }
  return { sessionID, user: staleUser, session } as any;
}

describe("refresh failure logging in middleware", () => {
  it("keeps the same 401 behavior and session while emitting sanitized diagnostics", async () => {
    mockGrant().mockReset();
    mockGrant().mockRejectedValueOnce({
      code: "OAUTH_RESPONSE_BODY_ERROR",
      error: "invalid_grant",
      status: 400,
      error_description: "Refresh token expired: secret-provider-token",
      message: "secret-provider-token",
    });
    const req = mockReq("diagnostics-session", {
      staleUser: { refresh_token: "test-refresh-token", claims: {}, expires_at: 1 },
    });
    req.isAuthenticated = () => true;
    const originalUser = { ...req.user };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    const next = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await isAuthenticated(req, res as any, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith({ message: "Unauthorized" });
      expect(next).not.toHaveBeenCalled();
      expect(req.user).toEqual(originalUser);
      expect(req.session.save).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith("[auth] OIDC refresh grant failed", {
        error: "Token refresh failed",
        code: "OAUTH_RESPONSE_BODY_ERROR",
        provider_error: "invalid_grant",
        http_status: 400,
        provider_description_category: "token_expiry_mentioned",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain("secret-provider-token");
      expect(JSON.stringify(log.mock.calls)).not.toContain("diagnostics-session");
    } finally {
      log.mockRestore();
    }
  });
});

describe("refreshSessionTokens (single-flight)", () => {
  it("fires only one refresh grant for concurrent requests on the same session", async () => {
    const grant = mockGrant();
    grant.mockReset();
    let resolveGrant!: (v: unknown) => void;
    grant.mockImplementationOnce(
      () => new Promise((resolve) => { resolveGrant = resolve; }),
    );
    // Two distinct requests sharing one session, like a real morning burst.
    const req1 = mockReq("sess-same", {
      staleUser: { refresh_token: "rt-1", claims: { sub: "u" }, expires_at: 0 },
    });
    const req2 = mockReq("sess-same", {
      staleUser: { refresh_token: "rt-1", claims: { sub: "u" }, expires_at: 0 },
    });

    const p1 = refreshSessionTokens(req1, req1.user);
    const p2 = refreshSessionTokens(req2, req2.user);
    // Let the leader start the grant before resolving it.
    await new Promise((r) => setTimeout(r, 0));
    resolveGrant!(grantTokens());
    await Promise.all([p1, p2]);

    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith({}, "rt-1");
    // The follower adopts the leader's rotated tokens.
    expect(req2.user.refresh_token).toBe("new-refresh-token");
    expect(req2.session.passport.user.refresh_token).toBe("new-refresh-token");
    expect(req1.session.save).toHaveBeenCalledTimes(1);
  });

  it("refreshes different sessions independently", async () => {
    const grant = mockGrant();
    grant.mockReset();
    grant.mockImplementation(async () => grantTokens());
    await Promise.all([
      refreshSessionTokens(
        mockReq("sess-a", {
          staleUser: { refresh_token: "rt-a", claims: {}, expires_at: 0 },
        }),
        {},
      ),
      refreshSessionTokens(
        mockReq("sess-b", {
          staleUser: { refresh_token: "rt-b", claims: {}, expires_at: 0 },
        }),
        {},
      ),
    ]);
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it("propagates refresh failure to all awaiters and clears the in-flight entry", async () => {
    const grant = mockGrant();
    grant.mockReset();
    grant.mockRejectedValueOnce(new Error("bad_grant"));
    const req = mockReq("sess-fail", {
      staleUser: { refresh_token: "rt-x", claims: {}, expires_at: 0 },
    });

    await expect(
      Promise.all([
        refreshSessionTokens(req, req.user),
        refreshSessionTokens(req, req.user),
      ]),
    ).rejects.toThrow("bad_grant");
    expect(grant).toHaveBeenCalledTimes(1);

    // The failed entry is gone: a later call retries with a new grant.
    grant.mockImplementationOnce(async () => grantTokens());
    await refreshSessionTokens(req, req.user);
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it("holds the lock until the session save completes", async () => {
    const grant = mockGrant();
    grant.mockReset();
    grant.mockImplementation(async () => grantTokens());
    let release!: () => void;
    const savePromise = new Promise<void>((r) => { release = r; });
    const req = mockReq("sess-save-gate", {
      staleUser: { refresh_token: "rt-g", claims: {}, expires_at: 0 },
      // Honor express-session's contract: completion is signaled via the callback.
      saveImpl: (cb: (err?: any) => void) => {
        void savePromise.then(() => cb());
      },
    });

    const p1 = refreshSessionTokens(req, req.user);
    // Wait until the grant has resolved and the code is blocked on the save.
    for (
      let i = 0;
      i < 100 && req.session.save.mock.calls.length === 0;
      i++
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(req.session.save).toHaveBeenCalled();
    // A second request arriving in that window must still see the in-flight
    // entry and must not fire its own grant with the consumed token.
    const p2 = refreshSessionTokens(req, req.user);
    await new Promise((r) => setTimeout(r, 10));
    expect(grant).toHaveBeenCalledTimes(1);

    release!();
    await Promise.all([p1, p2]);
    expect(grant).toHaveBeenCalledTimes(1);
  });

  it("adopts already-rotated tokens on reload instead of granting again", async () => {
    const grant = mockGrant();
    grant.mockReset();
    // The leader rotates RT1 -> RT2.
    grant.mockImplementationOnce(
      async () => grantTokens({ refresh_token: "RT2", access_token: "a2" }),
    );
    const leaderReq = mockReq("sess-rot", {
      staleUser: { refresh_token: "RT1", claims: {}, expires_at: 0 },
    });
    await refreshSessionTokens(leaderReq, leaderReq.user);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(leaderReq.user.refresh_token).toBe("RT2");

    // A second request whose session copy predates the rotation: its reload
    // observes the rotated tokens, so it must not grant with the consumed RT1.
    const followerReq = mockReq("sess-rot", {
      staleUser: { refresh_token: "RT1", claims: {}, expires_at: 0 },
      freshUser: {
        refresh_token: "RT2",
        access_token: "a2",
        claims: {},
        expires_at: 9999999999,
      },
    });
    await refreshSessionTokens(followerReq, followerReq.user);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(followerReq.user.refresh_token).toBe("RT2");
    expect(followerReq.user.access_token).toBe("a2");
  });

  it("surfaces a failed session reload as an error", async () => {
    const grant = mockGrant();
    grant.mockReset();
    const req = mockReq("sess-gone", {
      staleUser: { refresh_token: "rt-gone", claims: {}, expires_at: 0 },
    });
    req.session.reload.mockImplementation((cb: (err?: any) => void) =>
      cb(new Error("failed to load session")),
    );
    await expect(refreshSessionTokens(req, req.user)).rejects.toThrow(
      "failed to load session",
    );
    expect(grant).not.toHaveBeenCalled();
  });
});
