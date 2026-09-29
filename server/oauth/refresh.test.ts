import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainable, db, resetDbMocks } from "./test-utils/mock-db";
import { mockReq, mockRes } from "./test-utils/http";
import { tokenRow } from "./test-utils/fixtures";
import { handleToken } from "./device";
import { oauthTokens } from "@shared/schema";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

function refreshRequest(body: Record<string, any>): any {
  return mockReq({ body });
}

const grantBody = {
  grant_type: "refresh_token",
  refresh_token: "refresh-me",
  client_id: "ghost",
};

describe("handleToken refresh_token grant", () => {
  it("rotates the grant and returns fresh tokens", async () => {
    db.select.mockReturnValue(chainable([tokenRow()]));
    const insertChain = chainable();
    db.insert.mockReturnValue(insertChain);
    const updateChain = chainable();
    db.update.mockReturnValue(updateChain);
    const res = mockRes();

    await handleToken(refreshRequest(grantBody), res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("library:read");
    // Old row is marked rotated+revoked.
    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.rotatedAt).toBeInstanceOf(Date);
    expect(setArg.revokedAt).toBeInstanceOf(Date);
  });

  it("rejects an expired refresh token", async () => {
    db.select.mockReturnValue(
      chainable([tokenRow({ refreshExpiresAt: new Date(Date.now() - 1000) })])
    );
    const res = mockRes();
    await handleToken(refreshRequest(grantBody), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });

  it("rejects a manually revoked token with no grace period", async () => {
    db.select.mockReturnValue(
      chainable([tokenRow({ revokedAt: new Date(), rotatedAt: null })])
    );
    const res = mockRes();
    await handleToken(refreshRequest(grantBody), res);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("rejects an unknown refresh token", async () => {
    db.select.mockReturnValue(chainable([]));
    const res = mockRes();
    await handleToken(refreshRequest(grantBody), res);
    expect(res.json.mock.calls[0][0]).toEqual({ error: "invalid_grant" });
  });

  it("treats reuse within the grace window as a benign retry", async () => {
    const rotated = tokenRow({
      revokedAt: new Date(),
      rotatedAt: new Date(Date.now() - 30_000),
    });
    const current = tokenRow({ id: "token-2" });
    db.select
      .mockReturnValueOnce(chainable([rotated]))
      .mockReturnValueOnce(chainable([current]));
    const insertChain = chainable();
    db.insert.mockReturnValue(insertChain);
    const updateChain = chainable();
    db.update.mockReturnValue(updateChain);
    const res = mockRes();

    await handleToken(refreshRequest(grantBody), res);

    // The *current* row is rotated again so the caller gets fresh tokens.
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(db.update).toHaveBeenCalledWith(oauthTokens);
  });

  it("nukes the grant family when a rotated token is reused past grace", async () => {
    const rotated = tokenRow({
      revokedAt: new Date(),
      rotatedAt: new Date(Date.now() - 120_000),
    });
    db.select.mockReturnValue(chainable([rotated]));
    const updateChain = chainable();
    db.update.mockReturnValue(updateChain);
    const res = mockRes();

    await handleToken(refreshRequest(grantBody), res);

    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
    // revokeGrantFamily: every live row for the client+user is revoked.
    expect(updateChain.set.mock.calls[0][0].revokedAt).toBeInstanceOf(Date);
    expect(updateChain.set.mock.calls[0][0].rotatedAt).toBeUndefined();
  });

  it("400s when required params are missing", async () => {
    const res = mockRes();
    await handleToken(refreshRequest({ grant_type: "refresh_token" }), res);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_grant");
  });
});
