import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainable, db, resetDbMocks } from "./test-utils/mock-db";
import { mockRes } from "./test-utils/http";
import { sha256Hex } from "./crypto";
import {
  ACCESS_TOKEN_TTL_SEC,
  REFRESH_TOKEN_TTL_SEC,
  mintTokenGrant,
  revokeGrantFamily,
  rotateRow,
  tokenResponse,
} from "./tokens";
import { oauthTokens } from "@shared/schema";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

describe("tokenResponse", () => {
  it("shapes the OAuth token response", () => {
    const res = tokenResponse(
      { accessToken: "a", refreshToken: "r" },
      ["library:read"]
    );
    expect(res).toEqual({
      access_token: "a",
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SEC,
      refresh_token: "r",
      refresh_expires_in: REFRESH_TOKEN_TTL_SEC,
      scope: "library:read",
    });
  });

  it("joins multiple scopes with spaces", () => {
    const res = tokenResponse(
      { accessToken: "a", refreshToken: "r" },
      ["library:read", "library:write"]
    );
    expect(res.scope).toBe("library:read library:write");
  });
});

describe("mintTokenGrant", () => {
  it("inserts a row with hashed tokens and correct TTLs", async () => {
    const chain = chainable();
    db.insert.mockReturnValue(chain);
    const before = Date.now();

    const tokens = await mintTokenGrant("ghost", "user-1", ["library:read"]);

    expect(db.insert).toHaveBeenCalledWith(oauthTokens);
    const values = chain.values.mock.calls[0][0];
    expect(values.clientId).toBe("ghost");
    expect(values.userId).toBe("user-1");
    expect(values.scopes).toEqual(["library:read"]);
    // Only hashes hit the database; raw tokens are returned once.
    expect(values.accessTokenHash).toBe(sha256Hex(tokens.accessToken));
    expect(values.refreshTokenHash).toBe(sha256Hex(tokens.refreshToken));
    expect(values.accessTokenHash).not.toContain(tokens.accessToken);
    const accessTtl = values.accessExpiresAt.getTime() - before;
    expect(accessTtl).toBeGreaterThan(3599_000);
    expect(accessTtl).toBeLessThanOrEqual(3601_000);
    const refreshTtl = values.refreshExpiresAt.getTime() - before;
    expect(refreshTtl).toBeGreaterThan(90 * 24 * 3600_000 - 2000);
  });
});

describe("rotateRow", () => {
  it("mints fresh tokens and marks the old row rotated+revoked", async () => {
    const insertChain = chainable();
    const updateChain = chainable();
    db.insert.mockReturnValue(insertChain);
    db.update.mockReturnValue(updateChain);
    const res = mockRes();
    const row: any = {
      id: "t1",
      clientId: "ghost",
      userId: "user-1",
      scopes: ["library:read"],
    };

    await rotateRow(row, res);

    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.rotatedAt).toBeInstanceOf(Date);
    expect(setArg.revokedAt).toBeInstanceOf(Date);
    expect(res.json).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(body.token_type).toBe("Bearer");
    expect(typeof body.access_token).toBe("string");
  });
});

describe("revokeGrantFamily", () => {
  it("revokes every live row for the client+user", async () => {
    const chain = chainable();
    db.update.mockReturnValue(chain);

    await revokeGrantFamily("ghost", "user-1");

    expect(db.update).toHaveBeenCalledWith(oauthTokens);
    const setArg = chain.set.mock.calls[0][0];
    expect(setArg.revokedAt).toBeInstanceOf(Date);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });
});
