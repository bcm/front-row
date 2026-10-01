import { describe, expect, it } from "vitest";
import {
  formatUserCode,
  newOpaqueToken,
  newUserCode,
  normalizeUserCode,
  pkceChallengeOk,
  pkceS256Challenge,
  pkceS256ChallengeOk,
  pkceSyntaxOk,
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

describe("pkceS256Challenge", () => {
  it("matches the RFC 7636 Appendix B test vector", () => {
    expect(pkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
  });
});

describe("pkceS256ChallengeOk", () => {
  // RFC 7636 Appendix B: base64url(sha256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))
  const CANONICAL = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

  it("accepts a canonical base64url encoding of 32 bytes", () => {
    expect(pkceS256ChallengeOk(CANONICAL)).toBe(true);
    expect(pkceS256ChallengeOk(pkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"))).toBe(true);
  });

  it("rejects unreserved chars outside the base64url alphabet", () => {
    expect(pkceS256ChallengeOk("v".repeat(42) + ".")).toBe(false);
    expect(pkceS256ChallengeOk("v".repeat(42) + "~")).toBe(false);
  });

  it("rejects non-canonical encodings (nonzero trailing bits)", () => {
    // "v" = 47 = 0b101111: the final char's 2 trailing bits must be zero.
    expect(pkceS256ChallengeOk("v".repeat(43))).toBe(false);
  });

  it("rejects wrong lengths", () => {
    expect(pkceS256ChallengeOk("v".repeat(42))).toBe(false);
    expect(pkceS256ChallengeOk(CANONICAL + "A")).toBe(false);
    expect(pkceS256ChallengeOk("")).toBe(false);
  });
});

describe("pkceChallengeOk", () => {
  it("accepts 43–128 char challenges for plain", () => {
    expect(pkceChallengeOk("v".repeat(43), "plain")).toBe(true);
    expect(pkceChallengeOk("v".repeat(128), "plain")).toBe(true);
    expect(pkceChallengeOk("v".repeat(42), "plain")).toBe(false);
  });

  it("requires a canonical 43-char base64url challenge for S256", () => {
    expect(pkceChallengeOk("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", "S256")).toBe(true);
    expect(pkceChallengeOk("v".repeat(43), "S256")).toBe(false);
    expect(pkceChallengeOk("v".repeat(44), "S256")).toBe(false);
    expect(pkceChallengeOk("v".repeat(128), "S256")).toBe(false);
  });

  it("rejects bad syntax regardless of method", () => {
    expect(pkceChallengeOk("v".repeat(43) + "!", "S256")).toBe(false);
    expect(pkceChallengeOk("", "plain")).toBe(false);
  });
});

describe("pkceSyntaxOk", () => {
  it("enforces the RFC 7636 §4.1 43–128 char unreserved syntax", () => {
    expect(pkceSyntaxOk("v".repeat(42))).toBe(false);
    expect(pkceSyntaxOk("v".repeat(43))).toBe(true);
    expect(pkceSyntaxOk("v".repeat(128))).toBe(true);
    expect(pkceSyntaxOk("v".repeat(129))).toBe(false);
    expect(pkceSyntaxOk("")).toBe(false);
    expect(pkceSyntaxOk("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjX!")).toBe(false);
    expect(pkceSyntaxOk("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
  });
});
