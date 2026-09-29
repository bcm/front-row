import { describe, expect, it } from "vitest";
import {
  formatUserCode,
  newOpaqueToken,
  newUserCode,
  normalizeUserCode,
  sha256Hex,
} from "./crypto";

describe("sha256Hex", () => {
  it("matches the known SHA-256 vector", () => {
    expect(sha256Hex("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  it("is deterministic", () => {
    expect(sha256Hex("abc")).toBe(sha256Hex("abc"));
  });
});

describe("newOpaqueToken", () => {
  it("returns 43 base64url chars (32 random bytes)", () => {
    const token = newOpaqueToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is unique across calls", () => {
    expect(newOpaqueToken()).not.toBe(newOpaqueToken());
  });
});

describe("user codes", () => {
  it("generates 8 chars from the unambiguous alphabet", () => {
    const code = newUserCode();
    expect(code).toHaveLength(8);
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ23456789]{8}$/);
  });

  it("formats as XXXX-XXXX", () => {
    expect(formatUserCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  it("normalizes case, dashes, and whitespace away", () => {
    expect(normalizeUserCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeUserCode(" ab cd ")).toBe("ABCD");
  });

  it("round-trips through format", () => {
    const code = newUserCode();
    expect(normalizeUserCode(formatUserCode(code))).toBe(code);
  });
});
