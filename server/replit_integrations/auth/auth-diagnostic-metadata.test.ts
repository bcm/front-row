import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticRef, loginTokenMetadata, providerDiagnosticRefs } from "./auth-diagnostic-metadata";

afterEach(() => { vi.unstubAllEnvs(); });

describe("safe login and provider metadata", () => {
  it("records presence flags and explicitly returned lifetimes, not tokens or scope text", () => {
    const metadata = loginTokenMetadata({
      access_token: "private-access", refresh_token: "private-refresh", id_token: "private-id",
      expires_in: 3600, refresh_expires_in: 7200, refresh_token_expires_in: 10800,
      scope: "openid offline_access private-scope", email: "private@example.test",
    });
    expect(metadata).toEqual({
      access_token_present: true, id_token_present: true, refresh_token_returned: true,
      access_token_lifetime_seconds: 3600, refresh_expires_in_seconds: 7200,
      refresh_token_expires_in_seconds: 10800, scope_returned: true, offline_access_returned: true,
    });
    expect(JSON.stringify(metadata)).not.toContain("private");
  });

  it("distinguishes absent scope and lifetime fields from explicit zero or absent offline_access", () => {
    expect(loginTokenMetadata({})).toMatchObject({
      scope_returned: false, offline_access_returned: null,
      access_token_lifetime_seconds: null, refresh_expires_in_seconds: null,
      refresh_token_expires_in_seconds: null,
    });
    expect(loginTokenMetadata({ expires_in: 0, scope: "openid email profile" }))
      .toMatchObject({ access_token_lifetime_seconds: 0, scope_returned: true, offline_access_returned: false });
  });

  it.each([NaN, Infinity, -1, "private-lifetime", Number.MAX_VALUE])(
    "does not copy or infer invalid lifetime metadata %s", value => {
      expect(loginTokenMetadata({
        expires_in: value, refresh_expires_in: value, refresh_token_expires_in: value,
      })).toMatchObject({
        access_token_lifetime_seconds: null, refresh_expires_in_seconds: null,
        refresh_token_expires_in_seconds: null,
      });
    },
  );

  it("uses stable keyed labels and distinct domains for provider and session identifiers", () => {
    vi.stubEnv("SESSION_SECRET", "private-signing-secret");
    const config = {
      serverMetadata: () => ({
        issuer: "https://private-issuer.test", token_endpoint: "https://private-issuer.test/token",
      }),
      clientMetadata: () => ({ client_id: "private-client-id", client_secret: "private-client-secret" }),
    };
    const refs = providerDiagnosticRefs(config);
    expect(refs).toEqual(providerDiagnosticRefs(config));
    expect(refs.client_ref).toMatch(/^[a-f0-9]{32}$/);
    expect(refs.client_ref).not.toBe(diagnosticRef("session", "private-client-id"));
    expect(JSON.stringify(refs)).not.toContain("private");
    expect(providerDiagnosticRefs({
      ...config, clientMetadata: () => ({ client_id: "different-client" }),
    }).client_ref).not.toBe(refs.client_ref);
  });

  it("handles absent diagnostic keys or unavailable SDK metadata without exposing errors", () => {
    vi.stubEnv("SESSION_SECRET", "");
    expect(diagnosticRef("session", "private-session")).toBe("unavailable");
    expect(providerDiagnosticRefs({
      serverMetadata: () => { throw new Error("private-provider-error"); },
    })).toEqual({
      issuer_ref: "unavailable", client_ref: "unavailable", token_endpoint_ref: "unavailable",
    });
  });
});
