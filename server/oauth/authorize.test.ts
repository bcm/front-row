import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainable, db, resetDbMocks } from "./test-utils/mock-db";
import { mockReq, mockRes } from "./test-utils/http";
import { authCodeRow, clientRow } from "./test-utils/fixtures";
import { pkceS256Challenge, sha256Hex } from "./crypto";
import { handleAuthorize, handleDecision } from "./authorize";
import { handleToken } from "./device";
import { oauthAuthorizationCodes } from "@shared/schema";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

const CALLBACK = "https://vault.example/callback";
const PKCE_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

function loggedIn(overrides: Record<string, any> = {}): any {
  return mockReq({
    isAuthenticated: () => true,
    user: { claims: { sub: "user-1" } },
    session: { oauthCsrf: "csrf-123" },
    get: (name: string) => (name === "host" ? "frontrow.maz.org" : undefined),
    ...overrides,
  });
}

function authorizeQuery(overrides: Record<string, any> = {}): any {
  return loggedIn({
    query: {
      response_type: "code",
      client_id: "ghost",
      redirect_uri: CALLBACK,
      scope: "library:read",
      state: "xyz",
      code_challenge: "challenge-abc",
      code_challenge_method: "plain",
      ...overrides,
    },
  });
}

function redirectUrl(res: any): URL {
  return new URL(res.redirect.mock.calls[0][0]);
}

describe("handleAuthorize", () => {
  it("redirects to /api/login when not logged in", async () => {
    const res = mockRes();
    await handleAuthorize(mockReq({ query: { client_id: "ghost" } }), res);
    expect(res.redirect).toHaveBeenCalledWith("/api/login");
  });

  it("400s with an error page (no redirect) for an unknown client", async () => {
    db.select.mockReturnValue(chainable([]));
    const res = mockRes();
    await handleAuthorize(authorizeQuery({ client_id: "nope" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("400s with an error page (no redirect) for an unlisted redirect_uri", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleAuthorize(authorizeQuery({ redirect_uri: "https://evil.example/cb" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("redirects with unsupported_response_type for a non-code response_type", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleAuthorize(authorizeQuery({ response_type: "token" }), res);
    const url = redirectUrl(res);
    expect(url.origin + url.pathname).toBe(CALLBACK);
    expect(url.searchParams.get("error")).toBe("unsupported_response_type");
    expect(url.searchParams.get("state")).toBe("xyz");
  });

  it("redirects with invalid_scope for a disallowed scope", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleAuthorize(authorizeQuery({ scope: "admin:all" }), res);
    expect(redirectUrl(res).searchParams.get("error")).toBe("invalid_scope");
  });

  it("redirects with invalid_request for an unknown PKCE method", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleAuthorize(
      authorizeQuery({ code_challenge: "abc", code_challenge_method: "md5" }),
      res
    );
    expect(redirectUrl(res).searchParams.get("error")).toBe("invalid_request");
  });

  it("redirects with invalid_request when PKCE is missing", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleAuthorize(authorizeQuery({ code_challenge: "", code_challenge_method: "" }), res);
    expect(redirectUrl(res).searchParams.get("error")).toBe("invalid_request");
  });

  it("renders the consent page for a valid request", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleAuthorize(authorizeQuery(), res);
    expect(res.send).toHaveBeenCalledTimes(1);
    const html = res.send.mock.calls[0][0];
    expect(html).toContain("Ghost");
    expect(html).toContain("/oauth/authorize/decision");
    expect(html).toContain('name="client_id" value="ghost"');
    expect(html).toContain(`name="redirect_uri" value="${CALLBACK}"`);
    expect(html).toContain("library:read");
  });
});

function decisionBody(overrides: Record<string, any> = {}): any {
  return loggedIn({
    body: {
      csrf: "csrf-123",
      client_id: "ghost",
      redirect_uri: CALLBACK,
      scope: "library:read",
      state: "xyz",
      code_challenge: "challenge-abc",
      code_challenge_method: "plain",
      decision: "approve",
      ...overrides,
    },
  });
}

describe("handleDecision", () => {
  it("redirects to /api/login when not logged in", async () => {
    const res = mockRes();
    await handleDecision(mockReq({ body: { decision: "approve" } }), res);
    expect(res.redirect).toHaveBeenCalledWith("/api/login");
  });

  it("403s on a CSRF mismatch", async () => {
    const res = mockRes();
    await handleDecision(decisionBody({ csrf: "wrong" }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects a decision with PKCE removed", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleDecision(decisionBody({ code_challenge: "", code_challenge_method: "" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("denies with a redirect carrying access_denied and state", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleDecision(decisionBody({ decision: "deny" }), res);
    const url = redirectUrl(res);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("code")).toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("approves: stores a hashed code and redirects with code+state", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const insertChain = chainable();
    db.insert.mockReturnValue(insertChain);
    const res = mockRes();
    await handleDecision(decisionBody(), res);

    const url = redirectUrl(res);
    const code = url.searchParams.get("code")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toBe("xyz");

    expect(db.insert).toHaveBeenCalledWith(oauthAuthorizationCodes);
    const values = insertChain.values.mock.calls[0][0];
    expect(values.codeHash).toBe(sha256Hex(code));
    expect(values.codeHash).not.toContain(code);
    expect(values.clientId).toBe("ghost");
    expect(values.userId).toBe("user-1");
    expect(values.redirectUri).toBe(CALLBACK);
    expect(values.scopes).toEqual(["library:read"]);
    expect(values.expiresAt.getTime() - Date.now()).toBeGreaterThan(590_000);
  });

  it("stores the PKCE challenge on approval", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const insertChain = chainable();
    db.insert.mockReturnValue(insertChain);
    const res = mockRes();
    await handleDecision(
      decisionBody({ code_challenge: "challenge-abc", code_challenge_method: "S256" }),
      res
    );
    const values = insertChain.values.mock.calls[0][0];
    expect(values.codeChallenge).toBe("challenge-abc");
    expect(values.codeChallengeMethod).toBe("S256");
    expect(res.redirect).toHaveBeenCalledTimes(1);
  });

  it("refuses to redirect to a tampered redirect_uri", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleDecision(decisionBody({ redirect_uri: "https://evil.example/cb" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("refuses a tampered scope outside the client's allowance", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleDecision(decisionBody({ scope: "library:read admin:all" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });
});

function grantBody(overrides: Record<string, any> = {}): any {
  return mockReq({
    body: {
      grant_type: "authorization_code",
      code: "auth-code",
      client_id: "ghost",
      redirect_uri: CALLBACK,
      code_verifier: PKCE_VERIFIER,
      ...overrides,
    },
  });
}

describe("handleToken authorization_code grant", () => {
  it("exchanges a valid code for tokens and consumes it (single-use)", async () => {
    const row = authCodeRow({
      codeChallenge: pkceS256Challenge(PKCE_VERIFIER),
      codeChallengeMethod: "S256",
    });
    db.select.mockReturnValue(chainable([row]));
    const deleteChain = chainable([row]);
    db.delete.mockReturnValue(deleteChain);
    const res = mockRes();
    await handleToken(grantBody(), res);
    expect(res.json).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("library:read");
    expect(db.delete).toHaveBeenCalledWith(oauthAuthorizationCodes);
    expect(deleteChain.returning).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown code", async () => {
    db.select.mockReturnValue(chainable([]));
    const res = mockRes();
    await handleToken(grantBody({ code: "nope" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("rejects a client_id mismatch", async () => {
    db.select.mockReturnValue(chainable([authCodeRow()]));
    const res = mockRes();
    await handleToken(grantBody({ client_id: "other" }), res);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("rejects a redirect_uri mismatch", async () => {
    db.select.mockReturnValue(chainable([authCodeRow()]));
    const res = mockRes();
    await handleToken(grantBody({ redirect_uri: "https://vault.example/other" }), res);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("rejects an expired code and deletes it", async () => {
    db.select.mockReturnValue(chainable([authCodeRow({ expiresAt: new Date(Date.now() - 1000) })]));
    const res = mockRes();
    await handleToken(grantBody(), res);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
    expect(db.delete).toHaveBeenCalledWith(oauthAuthorizationCodes);
  });

  it("verifies a PKCE S256 challenge", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const row = authCodeRow({ codeChallenge: pkceS256Challenge(verifier), codeChallengeMethod: "S256" });
    db.select.mockReturnValue(chainable([row]));
    db.delete.mockReturnValue(chainable([row]));
    const res = mockRes();
    await handleToken(grantBody({ code_verifier: verifier }), res);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.json.mock.calls[0][0].access_token).toBeDefined();
  });

  it("verifies a PKCE plain challenge", async () => {
    const row = authCodeRow({ codeChallenge: "plain-verifier-value", codeChallengeMethod: "plain" });
    db.select.mockReturnValue(chainable([row]));
    db.delete.mockReturnValue(chainable([row]));
    const res = mockRes();
    await handleToken(grantBody({ code_verifier: "plain-verifier-value" }), res);
    expect(res.json.mock.calls[0][0].access_token).toBeDefined();
  });

  it("rejects a wrong PKCE verifier", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    db.select.mockReturnValue(
      chainable([authCodeRow({ codeChallenge: pkceS256Challenge(verifier), codeChallengeMethod: "S256" })])
    );
    const res = mockRes();
    await handleToken(grantBody({ code_verifier: "wrong-verifier" }), res);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("rejects a missing verifier when a challenge is stored", async () => {
    db.select.mockReturnValue(
      chainable([authCodeRow({ codeChallenge: "some-challenge", codeChallengeMethod: "plain" })])
    );
    const res = mockRes();
    await handleToken(grantBody(), res);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("rejects an authorization code without PKCE", async () => {
    db.select.mockReturnValue(chainable([authCodeRow()]));
    const res = mockRes();
    await handleToken(grantBody(), res);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
    expect(db.delete).not.toHaveBeenCalled();
  });

  it("rejects an exchange when another request already consumed the code", async () => {
    const row = authCodeRow({
      codeChallenge: pkceS256Challenge(PKCE_VERIFIER),
      codeChallengeMethod: "S256",
    });
    db.select.mockReturnValue(chainable([row]));
    db.delete.mockReturnValue(chainable([]));
    const res = mockRes();
    await handleToken(grantBody(), res);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("rejects a replayed code", async () => {
    const row = authCodeRow({
      codeChallenge: pkceS256Challenge(PKCE_VERIFIER),
      codeChallengeMethod: "S256",
    });
    db.select.mockReturnValue(chainable([row]));
    db.delete.mockReturnValue(chainable([row]));
    const first = mockRes();
    await handleToken(grantBody(), first);
    expect(first.json.mock.calls[0][0].access_token).toBeDefined();
    // The exchange deleted the row: a second attempt finds nothing.
    db.select.mockReturnValue(chainable([]));
    const second = mockRes();
    await handleToken(grantBody(), second);
    expect(second.json.mock.calls[0][0].error).toBe("invalid_grant");
  });
});
