import { describe, expect, it, vi } from "vitest";
import { db } from "./oauth/test-utils/mock-db";
import { mockReq, mockRes } from "./oauth/test-utils/http";
import { authorizationServerMetadata } from "./oauth";

vi.mock("./db", () => ({ db }));

describe("authorizationServerMetadata", () => {
  it("advertises the authorization-code grant with required PKCE", () => {
    const req = mockReq({ get: (name: string) => (name === "host" ? "frontrow.maz.org" : undefined) });
    const res = mockRes();
    authorizationServerMetadata(req, res);
    const doc = res.json.mock.calls[0][0];
    expect(doc.issuer).toBe("https://frontrow.maz.org");
    expect(doc.authorization_endpoint).toBe("https://frontrow.maz.org/oauth/authorize");
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.grant_types_supported).toContain("authorization_code");
    expect(doc.code_challenge_methods_supported).toEqual(["S256", "plain"]);
  });

  it("advertises none for token endpoint auth (public clients, no secret)", () => {
    const req = mockReq({ get: (name: string) => (name === "host" ? "frontrow.maz.org" : undefined) });
    const res = mockRes();
    authorizationServerMetadata(req, res);
    const doc = res.json.mock.calls[0][0];
    // RFC 8414 defaults an omitted field to client_secret_basic, which this
    // endpoint does not support — it must be explicit.
    expect(doc.token_endpoint_auth_methods_supported).toEqual(["none"]);
  });
});
