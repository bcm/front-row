import { describe, expect, it } from "vitest";
import { refreshFailureDiagnostics, providerRejectionSignals } from "./refresh-diagnostics";

function providerError(description?: unknown) {
  return {
    code: "OAUTH_RESPONSE_BODY_ERROR",
    error: "invalid_grant",
    status: 400,
    error_description: description,
  };
}

describe("refreshFailureDiagnostics", () => {
  it("records the provider's allowlisted error and HTTP status", () => {
    expect(refreshFailureDiagnostics(providerError("Refresh token expired"))).toEqual({
      error: "Token refresh failed",
      code: "OAUTH_RESPONSE_BODY_ERROR",
      provider_error: "invalid_grant",
      http_status: 400,
      provider_description_category: "token_expiry_mentioned",
    });
  });

  it.each([
    ["refresh_token has been revoked", "token_revocation_mentioned"],
    ["refresh token was already used", "token_reuse_mentioned"],
    ["Token replay detected", "token_reuse_mentioned"],
    ["Invalid refresh token", "invalid_token_mentioned"],
    ["Unexpected provider response", "other_redacted"],
    ["The authorization grant expired", "expiry_mentioned"],
    ["Authorization has been revoked", "revocation_mentioned"],
    ["This grant was already consumed", "reuse_mentioned"],
    ["The grant was issued to another client", "client_mismatch_mentioned"],
    ["The requested scope is not allowed", "scope_mentioned"],
    ["Invalid grant", "invalid_grant_mentioned"],
    ["The grant is invalid, expired, revoked, or issued to another client", "multiple_reasons_mentioned"],
    [undefined, "not_provided"],
  ])("categorizes %s without logging the description", (description, category) => {
    expect(refreshFailureDiagnostics(providerError(description)).provider_description_category)
      .toBe(category);
  });

  it("reports all mentions in a generic rejection without claiming a single cause", () => {
    expect(providerRejectionSignals(providerError(
      "Grant expired, revoked, reused, or issued to a different client; invalid scope; private-token",
    ))).toEqual({
      expiry: true, revocation: true, reuse: true, client_mismatch: true, scope: true,
    });
    expect(JSON.stringify(providerRejectionSignals(providerError("private@example.test"))))
      .not.toContain("private");
    expect(providerRejectionSignals({ error_description: "expired revoked scope" }))
      .toEqual({ expiry: false, revocation: false, reuse: false, client_mismatch: false, scope: false });
  });

  it("never includes credentials, PII, request headers, or raw error bodies", () => {
    const secret = "opaque-sensitive-value";
    const details = {
      ...providerError(`Refresh token expired: ${secret}; email=private@example.test`),
      message: secret,
      cause: { access_token: secret, refresh_token: secret },
      response: { headers: { authorization: `Bearer ${secret}`, cookie: secret } },
      sessionID: secret,
    };
    const output = JSON.stringify(refreshFailureDiagnostics(details));
    expect(output).not.toContain(secret);
    expect(output).not.toContain("private@example.test");
    expect(output).not.toContain("authorization");
    expect(output).not.toContain("sessionID");
  });

  it("redacts unrecognized codes and descriptions rather than copying them", () => {
    const secret = "opaque-sensitive-value";
    const output = refreshFailureDiagnostics({
      ...providerError(secret),
      error: secret,
      message: secret,
    });
    expect(output.provider_error).toBe("other_redacted");
    expect(output.provider_description_category).toBe("other_redacted");
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(refreshFailureDiagnostics({ code: secret }).code).toBe("other_redacted");
  });

  it.each([null, undefined, "secret-raw-exception", new Error("secret-raw-exception")])(
    "handles non-provider exceptions without logging raw messages",
    (error) => {
      expect(refreshFailureDiagnostics(error)).toEqual({
        error: "Token refresh failed",
        code: "other_redacted",
        provider_error: "not_provided",
        http_status: null,
        provider_description_category: "not_provided",
      });
    },
  );

  it.each([NaN, 0, 600, 400.5, "400"])("rejects invalid status %s", (status) => {
    expect(refreshFailureDiagnostics({ ...providerError(), status }).http_status).toBeNull();
  });
});
