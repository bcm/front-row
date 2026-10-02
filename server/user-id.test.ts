import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { getUserId } from "./user-id";

function requestWith(user: unknown): Request {
  return { user } as Request;
}

describe("getUserId", () => {
  it("returns the subject claim when present", () => {
    const req = requestWith({ claims: { sub: "user-123" } });
    expect(getUserId(req)).toBe("user-123");
  });

  it("throws when req.user is absent", () => {
    const req = requestWith(undefined);
    expect(() => getUserId(req)).toThrow(/no authenticated user/);
  });

  it("throws when the claims carry no subject", () => {
    const req = requestWith({ claims: {} });
    expect(() => getUserId(req)).toThrow(/no authenticated user/);
  });
});
