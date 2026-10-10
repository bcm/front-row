import { describe, expect, it } from "vitest";
import { refreshFailureDiagnostics } from "./refresh-diagnostics";

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
    [undefined, "not_provided"],
  ])("categorizes %s without logging the description", (description, category) => {
    expect(refreshFailureDiagnostics(providerError(description)).provider_description_category)
      .toBe(category);
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
