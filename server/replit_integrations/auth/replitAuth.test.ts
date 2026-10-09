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
import { refreshSessionTokens } from "./replitAuth";
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

// A minimal stand-in for express's req: session id plus a session whose save
// completes via callback, like express-session's Session.save.
function mockReq(sessionID: string, saveImpl?: (cb: (err?: any) => void) => void) {
  return {
    sessionID,
    session: { save: vi.fn(saveImpl ?? ((cb: (err?: any) => void) => cb())) },
  } as any;
}

describe("refreshSessionTokens (single-flight)", () => {
  it("fires only one refresh grant for concurrent requests on the same session", async () => {
    const grant = mockGrant();
    grant.mockReset();
    let resolveGrant!: (v: unknown) => void;
    grant.mockImplementationOnce(
      () => new Promise((resolve) => { resolveGrant = resolve; }),
    );
    const user: any = { refresh_token: "rt-1", claims: { sub: "u" } };
    const req = mockReq("sess-same");

    const p1 = refreshSessionTokens(req, user);
    const p2 = refreshSessionTokens(req, user);
    const p3 = refreshSessionTokens(req, user);
    // Let the leader start the grant before resolving it.
    await new Promise((r) => setTimeout(r, 0));
    resolveGrant!(grantTokens());
    await Promise.all([p1, p2, p3]);

    expect(grant).toHaveBeenCalledTimes(1);
    expect(grant).toHaveBeenCalledWith({}, "rt-1");
    expect(user.refresh_token).toBe("new-refresh-token");
    expect(req.session.save).toHaveBeenCalledTimes(1);
  });

  it("refreshes different sessions independently", async () => {
    const grant = mockGrant();
    grant.mockReset();
    grant.mockImplementation(async () => grantTokens());
    await Promise.all([
      refreshSessionTokens(mockReq("sess-a"), {
        refresh_token: "rt-a",
        claims: {},
      }),
      refreshSessionTokens(mockReq("sess-b"), {
        refresh_token: "rt-b",
        claims: {},
      }),
    ]);
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it("propagates refresh failure to all awaiters and clears the in-flight entry", async () => {
    const grant = mockGrant();
    grant.mockReset();
    grant.mockRejectedValueOnce(new Error("bad_grant"));
    const user: any = { refresh_token: "rt-x", claims: {} };
    const req = mockReq("sess-fail");

    await expect(
      Promise.all([refreshSessionTokens(req, user), refreshSessionTokens(req, user)]),
    ).rejects.toThrow("bad_grant");
    expect(grant).toHaveBeenCalledTimes(1);

    // The failed entry is gone: a later call retries with a new grant.
    grant.mockImplementationOnce(async () => grantTokens());
    await refreshSessionTokens(req, user);
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it("holds the lock until the session save completes", async () => {
    const grant = mockGrant();
    grant.mockReset();
    grant.mockImplementation(async () => grantTokens());
    let release!: () => void;
    const savePromise = new Promise<void>((r) => { release = r; });
    const req = mockReq("sess-save-gate");
    // Hold the save open until the test releases it. The mock honors
    // express-session's contract: completion is signaled via the callback.
    req.session.save.mockImplementation((cb: (err?: any) => void) => {
      void savePromise.then(() => cb());
    });

    const user: any = { refresh_token: "rt-g", claims: {} };
    const p1 = refreshSessionTokens(req, user);
    // Manual poll: wait until the grant has resolved and the code is blocked on the save.
    for (let i = 0; i < 100 && req.session.save.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(req.session.save).toHaveBeenCalled();
    // A second request arriving in that window must still see the in-flight
    // entry and must not fire its own grant with the consumed token.
    const p2 = refreshSessionTokens(req, user);
    await new Promise((r) => setTimeout(r, 10));
    expect(grant).toHaveBeenCalledTimes(1);

    release!();
    await Promise.all([p1, p2]);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(user.refresh_token).toBe("new-refresh-token");
  });
});
