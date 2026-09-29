import { beforeEach, describe, expect, it, vi } from "vitest";
import { chainable, db, resetDbMocks } from "./test-utils/mock-db";
import { mockReq, mockRes } from "./test-utils/http";
import { clientRow, deviceCodeRow } from "./test-utils/fixtures";
import { handleApprove, handleDeny, handleDevicePage } from "./verify";

vi.mock("../db", () => ({ db }));

beforeEach(() => resetDbMocks());

const loggedIn = {
  isAuthenticated: () => true,
  user: { claims: { sub: "user-1" } },
  session: {},
};

function pageRequest(query: Record<string, any> = {}, extra: Record<string, any> = {}): any {
  return mockReq({ query, ...loggedIn, ...extra });
}

describe("handleDevicePage", () => {
  it("redirects to login without a session", async () => {
    const res = mockRes();
    await handleDevicePage(mockReq(), res);
    expect(res.redirect).toHaveBeenCalledWith("/api/login");
  });

  it("shows the code entry form when no code is given", async () => {
    const res = mockRes();
    await handleDevicePage(pageRequest(), res);
    expect(res.send).toHaveBeenCalledTimes(1);
    expect(res.send.mock.calls[0][0]).toContain("Connect a device");
  });

  it("shows an error for an unknown code", async () => {
    db.select.mockReturnValue(chainable([]));
    const res = mockRes();
    await handleDevicePage(pageRequest({ code: "ZZZZ-ZZZZ" }), res);
    expect(res.send.mock.calls[0][0]).toContain("Invalid or expired code");
  });

  it("shows the consent page with client, scopes, and CSRF token", async () => {
    db.select
      .mockReturnValueOnce(chainable([deviceCodeRow()]))
      .mockReturnValueOnce(chainable([clientRow()]));
    const res = mockRes();
    await handleDevicePage(pageRequest({ code: "abcd-1234" }), res);
    const html: string = res.send.mock.calls[0][0];
    expect(html).toContain("Approve access?");
    expect(html).toContain("Ghost");
    expect(html).toContain("library:read");
    expect(html).toMatch(/name="csrf" value="[0-9a-f]+"/);
    expect(html).toContain('action="/oauth/device/approve"');
    expect(html).toContain('action="/oauth/device/deny"');
  });
});

describe("handleApprove", () => {
  function approveRequest(body: Record<string, any>, session: Record<string, any> = {}): any {
    return mockReq({ body, ...loggedIn, session: { oauthCsrf: "csrf-ok", ...session } });
  }

  it("403s on a bad CSRF token", async () => {
    const res = mockRes();
    await handleApprove(approveRequest({ csrf: "wrong", user_code: "ABCD-1234" }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("429s when the session exceeds the attempt throttle", async () => {
    const res = mockRes();
    await handleApprove(
      approveRequest(
        { csrf: "csrf-ok", user_code: "ABCD-1234" },
        { oauthAttempts: { count: 30, resetAt: Date.now() + 60_000 } }
      ),
      res
    );
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it("approves the code bound to the session user", async () => {
    db.select
      .mockReturnValueOnce(chainable([deviceCodeRow()]))
      .mockReturnValueOnce(chainable([clientRow()]));
    const updateChain = chainable();
    db.update.mockReturnValue(updateChain);
    const res = mockRes();

    await handleApprove(approveRequest({ csrf: "csrf-ok", user_code: "ABCD-1234" }), res);

    expect(updateChain.set.mock.calls[0][0]).toEqual({
      status: "approved",
      approvedByUserId: "user-1",
    });
    expect(res.send.mock.calls[0][0]).toContain("Access approved");
  });

  it("shows an error when the code is gone", async () => {
    db.select.mockReturnValue(chainable([]));
    const res = mockRes();
    await handleApprove(approveRequest({ csrf: "csrf-ok", user_code: "ZZZZ-ZZZZ" }), res);
    expect(res.send.mock.calls[0][0]).toContain("Invalid or expired code");
  });
});

describe("handleDeny", () => {
  it("marks a pending code denied", async () => {
    db.select.mockReturnValue(chainable([deviceCodeRow()]));
    const updateChain = chainable();
    db.update.mockReturnValue(updateChain);
    const res = mockRes();
    const req = mockReq({
      body: { csrf: "csrf-ok", user_code: "ABCD-1234" },
      ...loggedIn,
      session: { oauthCsrf: "csrf-ok" },
    });

    await handleDeny(req, res);

    expect(updateChain.set.mock.calls[0][0]).toEqual({ status: "denied" });
    expect(res.send.mock.calls[0][0]).toContain("Access denied");
  });

  it("still renders the denied page when the code is unknown", async () => {
    db.select.mockReturnValue(chainable([]));
    const res = mockRes();
    const req = mockReq({
      body: { csrf: "csrf-ok", user_code: "ZZZZ-ZZZZ" },
      ...loggedIn,
      session: { oauthCsrf: "csrf-ok" },
    });
    await handleDeny(req, res);
    expect(db.update).not.toHaveBeenCalled();
    expect(res.send.mock.calls[0][0]).toContain("Access denied");
  });
});
