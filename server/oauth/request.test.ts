import { describe, expect, it } from "vitest";
import { baseUrl, isLoggedIn, sessionUserId } from "./request";

describe("baseUrl", () => {
  it("builds from protocol and host", () => {
    const req: any = {
      protocol: "https",
      get: (name: string) => (name === "host" ? "frontrow.maz.org" : undefined),
    };
    expect(baseUrl(req)).toBe("https://frontrow.maz.org");
  });
});

describe("isLoggedIn", () => {
  it("reflects passport's isAuthenticated", () => {
    expect(isLoggedIn({ isAuthenticated: () => true } as any)).toBe(true);
    expect(isLoggedIn({ isAuthenticated: () => false } as any)).toBe(false);
  });

  it("is false when the session helper is missing", () => {
    expect(isLoggedIn({} as any)).toBe(false);
  });
});

describe("sessionUserId", () => {
  it("reads the OIDC subject claim", () => {
    const req: any = { user: { claims: { sub: "user-123" } } };
    expect(sessionUserId(req)).toBe("user-123");
  });

  it("is undefined without a session user", () => {
    expect(sessionUserId({} as any)).toBeUndefined();
  });
});
