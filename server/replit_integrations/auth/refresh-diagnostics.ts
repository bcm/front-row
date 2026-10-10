// Log only allowlisted codes and fixed reason labels. Provider descriptions,
// exception messages and response bodies can contain credentials or PII.
const libraryCodes = new Set([
  "OAUTH_RESPONSE_BODY_ERROR",
  "OAUTH_INVALID_RESPONSE",
  "OAUTH_OPERATION_PROCESSING_ERROR",
  "OAUTH_JWT_CLAIM_COMPARISON_FAILED",
  "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED",
]);

const providerErrors = new Set([
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "access_denied",
  "server_error",
  "temporarily_unavailable",
]);

function descriptionCategory(description: unknown): string {
  if (typeof description !== "string" || !description.trim()) return "not_provided";
  // Never return any part of the original description, even for unknown errors.
  const text = description.slice(0, 4096).toLowerCase();
  const signals = descriptionSignals(text);
  if (Object.values(signals).filter(Boolean).length > 1) return "multiple_reasons_mentioned";
  if (signals.client_mismatch) return "client_mismatch_mentioned";
  if (signals.scope) return "scope_mentioned";
  if (/\b(refresh[\s_-]*token|token)\b/.test(text)) {
    if (/\b(reuse|reused|replay|already used|already consumed)\b/.test(text)) {
      return "token_reuse_mentioned";
    }
    if (/\b(revoked|revocation)\b/.test(text)) return "token_revocation_mentioned";
    if (/\b(expired|expiration|expiry)\b/.test(text)) return "token_expiry_mentioned";
    if (/\b(invalid|unknown|not found)\b/.test(text)) return "invalid_token_mentioned";
  }
  // Providers may describe "the grant" or "authorization" rather than
  // "the token". These labels report mentions, not a proven root cause.
  if (signals.reuse) return "reuse_mentioned";
  if (signals.revocation) return "revocation_mentioned";
  if (signals.expiry) return "expiry_mentioned";
  if (/\bgrant\b/.test(text) && /\binvalid\b/.test(text)) return "invalid_grant_mentioned";
  return "other_redacted";
}

function descriptionSignals(text: string) {
  return {
    expiry: /\b(expired|expiration|expiry)\b/.test(text),
    revocation: /\b(revoked|revocation)\b/.test(text),
    reuse: /\b(reuse|reused|replay|already used|already consumed)\b/.test(text),
    client_mismatch: /\bclient\b/.test(text)
      && /\b(mismatch|does not match|doesn't match|another|different|wrong)\b/.test(text),
    scope: /\bscope\b/.test(text),
  };
}

export function providerRejectionSignals(error: unknown) {
  const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const text = details.code === "OAUTH_RESPONSE_BODY_ERROR"
    && typeof details.error_description === "string"
    ? details.error_description.slice(0, 4096).toLowerCase() : "";
  return descriptionSignals(text);
}

export function refreshFailureDiagnostics(error: unknown) {
  const details = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const code = typeof details.code === "string" && libraryCodes.has(details.code)
    ? details.code
    : "other_redacted";
  const isProviderResponse = code === "OAUTH_RESPONSE_BODY_ERROR";
  return {
    error: "Token refresh failed",
    code,
    provider_error: isProviderResponse && typeof details.error === "string"
      ? providerErrors.has(details.error) ? details.error : "other_redacted"
      : "not_provided",
    http_status: isProviderResponse && typeof details.status === "number"
      && Number.isInteger(details.status) && details.status >= 100 && details.status <= 599
      ? details.status
      : null,
    provider_description_category: isProviderResponse
      ? descriptionCategory(details.error_description)
      : "not_provided",
  };
}
