import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefreshTrace } from "./refresh-tracing";
import { loginTokenMetadata } from "./auth-diagnostic-metadata";

const prefix = "[auth] refresh_trace ";
const user = {
  claims: { iat: 100, sub: "private-user-id", email: "private@example.test" },
  expires_at: 200,
  refresh_token: "private-refresh-token",
  access_token: "private-access-token",
};

describe("token-safe refresh tracing", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "private-test-signing-secret");
    log = vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    log.mockRestore();
    vi.unstubAllEnvs();
  });
  function records() {
    return log.mock.calls.map(([line]) => JSON.parse(String(line).slice(prefix.length)));
  }

  it("correlates a session across attempts without exposing its identifier", () => {
    const first = createRefreshTrace("private-session-id");
    first("started", user);
    first("completed", user);
    createRefreshTrace("private-session-id")("started", user);
    createRefreshTrace("different-session")("started", user);
    const [a, b, c, d] = records();
    expect(a.session_ref).toMatch(/^[a-f0-9]{32}$/);
    expect(a.session_ref).toBe(b.session_ref);
    expect(a.session_ref).toBe(c.session_ref);
    expect(a.session_ref).not.toBe(d.session_ref);
    expect(a.attempt_ref).toBe(b.attempt_ref);
    expect(a.attempt_ref).not.toBe(c.attempt_ref);
    expect(a.process_ref).toBe(c.process_ref);
    expect(a.token_issued_at).toBe(100);
    expect(a.token_expires_at).toBe(200);
    expect(a.access_token_expired).toBe(true);
    expect(a.refresh_token_present).toBe(true);
  });

  it("uses a signing-key-dependent label, not an unkeyed identifier hash", () => {
    createRefreshTrace("private-session-id")("started", user);
    vi.stubEnv("SESSION_SECRET", "different-test-signing-secret");
    createRefreshTrace("private-session-id")("started", user);
    expect(records()[0].session_ref).not.toBe(records()[1].session_ref);
  });

  it("correlates sign-in and grant configuration without copying credentials or user fields", () => {
    const config = {
      serverMetadata: () => ({
        issuer: "https://private-issuer.test", token_endpoint: "https://private-issuer.test/token",
      }),
      clientMetadata: () => ({ client_id: "private-client", client_secret: "private-client-secret" }),
    };
    createRefreshTrace("private-session-id")("login_succeeded", user, {
      config, login: loginTokenMetadata({
        access_token: "private-access", refresh_token: "private-refresh",
        expires_in: 3600, scope: "openid offline_access private-scope",
      }),
    });
    createRefreshTrace("private-session-id")("grant_started", user, { config, phase: "grant" });
    const [login, grant] = records();
    for (const key of ["session_ref", "client_ref", "issuer_ref", "token_endpoint_ref"]) {
      expect(login[key]).toBe(grant[key]);
      expect(login[key]).toMatch(/^[a-f0-9]{32}$/);
    }
    expect(login).toMatchObject({
      refresh_token_returned: true, offline_access_returned: true,
      refresh_expires_in_seconds: null, refresh_token_expires_in_seconds: null,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  });

  it("keeps session labels stable across independently initialized server modules", async () => {
    vi.resetModules();
    const first = await import("./refresh-tracing");
    vi.resetModules();
    const second = await import("./refresh-tracing");
    first.createRefreshTrace("private-session-id")("started", user);
    second.createRefreshTrace("private-session-id")("started", user);
    const [a, b] = records();
    expect(a.session_ref).toBe(b.session_ref);
    expect(a.process_ref).not.toBe(b.process_ref);
    expect(a.attempt_ref).not.toBe(b.attempt_ref);
  });

  it("emits one-line sanitized failures and never copies credentials or PII", () => {
    createRefreshTrace("private-session-id")("failed", user, {
      phase: "grant",
      error: {
        code: "OAUTH_RESPONSE_BODY_ERROR", error: "invalid_grant", status: 400,
        error_description: "private-provider-description\nprivate-refresh-token",
        message: "private-exception-message",
        cause: { cookie: "private-cookie" },
      },
    });
    const output = JSON.stringify(log.mock.calls);
    for (const privateValue of [
      "private-session-id", "private-test-signing-secret", "private-user-id",
      "private@example.test", "private-refresh-token", "private-access-token",
      "private-provider-description", "private-exception-message", "private-cookie",
    ]) expect(output).not.toContain(privateValue);
    expect(String(log.mock.calls[0][0])).not.toContain("\n");
    expect(records()[0]).toMatchObject({
      event: "failed", phase: "grant", provider_error: "invalid_grant", http_status: 400,
      provider_description_signals: {
        expiry: false, revocation: false, reuse: false, client_mismatch: false, scope: false,
      },
    });
  });

  it("handles missing session identifiers and invalid timestamp metadata safely", () => {
    vi.stubEnv("SESSION_SECRET", "");
    createRefreshTrace(undefined)("started", {
      claims: { iat: "private-metadata" }, expires_at: Infinity,
    });
    expect(records()[0]).toMatchObject({
      session_ref: "unavailable", token_issued_at: null, token_expires_at: null,
      token_age_seconds: null, access_token_expired: null, refresh_token_present: false,
    });
    expect(JSON.stringify(records())).not.toContain("private-metadata");
  });
});
