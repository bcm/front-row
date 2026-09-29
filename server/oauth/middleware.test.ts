import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainable, db, resetDbMocks } from "./test-utils/mock-db";
import { mockReq, mockRes } from "./test-utils/http";
import { requireMcpAuth, requireScope } from "./middleware";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

function authedReq(token?: string): any {
  return mockReq({
    get: (name: string) => {
      if (name === "authorization") return token;
      if (name === "host") return "frontrow.maz.org";
      return undefined;
    },
  });
}

const liveRow = {
  userId: "user-1",
  clientId: "ghost",
  scopes: ["library:read"],
  accessExpiresAt: new Date(Date.now() + 3600_000),
  revokedAt: null,
};

describe("requireMcpAuth", () => {
  it("401s when the bearer token is missing", async () => {
    const req = authedReq(undefined);
    const res = mockRes();
    const next = vi.fn();
    await requireMcpAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_token");
    expect(next).not.toHaveBeenCalled();
  });

  it("401s on a malformed authorization header", async () => {
    const req = authedReq("Token abc123");
    const res = mockRes();
    await requireMcpAuth(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("advertises the protected-resource metadata URL on 401", async () => {
    const req = authedReq(undefined);
    const res = mockRes();
    await requireMcpAuth(req, res, vi.fn());
    const header: string = res.set.mock.calls[0][1];
    expect(header).toContain("/.well-known/oauth-protected-resource/mcp");
  });

  it("401s for an unknown token", async () => {
    db.select.mockReturnValue(chainable([]));
    const req = authedReq("Bearer nope");
    const res = mockRes();
    await requireMcpAuth(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("401s for an expired token", async () => {
    db.select.mockReturnValue(
      chainable([{ ...liveRow, accessExpiresAt: new Date(Date.now() - 1000) }])
    );
    const req = authedReq("Bearer abc");
    const res = mockRes();
    await requireMcpAuth(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("401s for a revoked token", async () => {
    db.select.mockReturnValue(chainable([{ ...liveRow, revokedAt: new Date() }]));
    const req = authedReq("Bearer abc");
    const res = mockRes();
    await requireMcpAuth(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("attaches the auth context and calls next for a live token", async () => {
    db.select.mockReturnValue(chainable([liveRow]));
    const req = authedReq("Bearer abc123");
    const res = mockRes();
    const next = vi.fn();
    await requireMcpAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.mcpAuth).toEqual({
      userId: "user-1",
      clientId: "ghost",
      scopes: ["library:read"],
    });
  });

  it("passes db errors to next", async () => {
    db.select.mockImplementation(() => {
      throw new Error("boom");
    });
    const req = authedReq("Bearer abc");
    const res = mockRes();
    const next = vi.fn();
    await requireMcpAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe("requireScope", () => {
  it("403s without an auth context", () => {
    const req = mockReq();
    const res = mockRes();
    const next = vi.fn();
    requireScope("library:read")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].error).toBe("insufficient_scope");
    expect(next).not.toHaveBeenCalled();
  });

  it("403s when the scope is missing", () => {
    const req = mockReq({ mcpAuth: { scopes: ["library:write"] } });
    const res = mockRes();
    const next = vi.fn();
    requireScope("library:read")(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("calls next when the scope is granted", () => {
    const req = mockReq({ mcpAuth: { scopes: ["library:read"] } });
    const res = mockRes();
    const next = vi.fn();
    requireScope("library:read")(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
