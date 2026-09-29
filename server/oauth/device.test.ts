import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainable, db, resetDbMocks } from "./test-utils/mock-db";
import { mockReq, mockRes } from "./test-utils/http";
import { clientRow, deviceCodeRow } from "./test-utils/fixtures";
import { normalizeUserCode, sha256Hex } from "./crypto";
import { handleDeviceCode, handleToken } from "./device";
import { oauthDeviceCodes } from "@shared/schema";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

function codeRequest(body: Record<string, any>): any {
  return mockReq({
    body,
    get: (name: string) => (name === "host" ? "frontrow.maz.org" : undefined),
  });
}

describe("handleDeviceCode", () => {
  it("400s for an unknown client", async () => {
    db.select.mockReturnValue(chainable([]));
    const res = mockRes();
    await handleDeviceCode(codeRequest({ client_id: "nope" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_client");
  });

  it("defaults to all allowed scopes when scope is omitted", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const insertChain = chainable();
    db.insert.mockReturnValue(insertChain);
    const res = mockRes();
    await handleDeviceCode(codeRequest({ client_id: "ghost" }), res);
    expect(res.json).toHaveBeenCalledTimes(1);
    const values = insertChain.values.mock.calls[0][0];
    expect(values.scopes).toEqual(["library:read", "library:write"]);
  });

  it("400s when the requested scope is not allowed", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const res = mockRes();
    await handleDeviceCode(
      codeRequest({ client_id: "ghost", scope: "admin:all" }),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("invalid_scope");
  });

  it("issues a code pair and stores only hashes", async () => {
    db.select.mockReturnValue(chainable([clientRow()]));
    const insertChain = chainable();
    db.insert.mockReturnValue(insertChain);
    const res = mockRes();
    await handleDeviceCode(
      codeRequest({ client_id: "ghost", scope: "library:read" }),
      res
    );

    const body = res.json.mock.calls[0][0];
    expect(body.device_code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ23456789]{4}-[BCDFGHJKLMNPQRSTVWXZ23456789]{4}$/);
    expect(body.verification_uri).toBe("https://frontrow.maz.org/oauth/device");
    expect(body.verification_uri_complete).toContain("?code=");
    expect(body.expires_in).toBe(600);
    expect(body.interval).toBe(5);

    expect(db.insert).toHaveBeenCalledWith(oauthDeviceCodes);
    const values = insertChain.values.mock.calls[0][0];
    expect(values.deviceCodeHash).toBe(sha256Hex(body.device_code));
    expect(values.deviceCodeHash).not.toContain(body.device_code);
    expect(values.userCode).toBe(normalizeUserCode(body.user_code));
  });
});

describe("handleToken device_code grant", () => {
  const grantBody = {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "dev-code",
    client_id: "ghost",
  };

  it("reports authorization_pending while the user has not decided", async () => {
    db.select.mockReturnValue(chainable([deviceCodeRow()]));
    const res = mockRes();
    await handleToken(codeRequest(grantBody), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("authorization_pending");
  });

  it("reports access_denied when the user denied", async () => {
    db.select.mockReturnValue(chainable([deviceCodeRow({ status: "denied" })]));
    const res = mockRes();
    await handleToken(codeRequest(grantBody), res);
    expect(res.json.mock.calls[0][0].error).toBe("access_denied");
  });

  it("marks expired codes and reports expired_token", async () => {
    db.select.mockReturnValue(
      chainable([deviceCodeRow({ expiresAt: new Date(Date.now() - 1000) })])
    );
    const updateChain = chainable();
    db.update.mockReturnValue(updateChain);
    const res = mockRes();
    await handleToken(codeRequest(grantBody), res);
    expect(updateChain.set.mock.calls[0][0]).toEqual({ status: "expired" });
    expect(res.json.mock.calls[0][0].error).toBe("expired_token");
  });

  it("stays generic when the client does not match the code", async () => {
    db.select.mockReturnValue(chainable([deviceCodeRow({ clientId: "other" })]));
    const res = mockRes();
    await handleToken(codeRequest(grantBody), res);
    expect(res.json.mock.calls[0][0]).toEqual({ error: "invalid_grant" });
  });

  it("issues tokens once and consumes the code", async () => {
    db.select.mockReturnValue(
      chainable([deviceCodeRow({ status: "approved", approvedByUserId: "user-1" })])
    );
    const insertChain = chainable();
    db.insert.mockReturnValue(insertChain);
    const deleteChain = chainable();
    db.delete.mockReturnValue(deleteChain);
    const res = mockRes();

    await handleToken(codeRequest(grantBody), res);

    expect(res.json).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(body.token_type).toBe("Bearer");
    // Grant is bound to the approver, not the device.
    expect(insertChain.values.mock.calls[0][0].userId).toBe("user-1");
    // Single-use: the code row is gone after exchange.
    expect(db.delete).toHaveBeenCalledWith(oauthDeviceCodes);
    expect(deleteChain.where).toHaveBeenCalledTimes(1);
  });
});

describe("handleToken", () => {
  it("400s on an unsupported grant type", async () => {
    const res = mockRes();
    await handleToken(codeRequest({ grant_type: "password" }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].error).toBe("unsupported_grant_type");
  });
});
