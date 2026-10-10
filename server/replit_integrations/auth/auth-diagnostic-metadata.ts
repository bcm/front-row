import { createHmac } from "node:crypto";

export function diagnosticRef(
  kind: "session" | "client" | "issuer" | "token_endpoint",
  value: unknown,
): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || typeof value !== "string" || !value) return "unavailable";
  return createHmac("sha256", secret)
    .update(`front-row:refresh-trace:${kind}:`)
    .update(value)
    .digest("hex").slice(0, 32);
}

export function providerDiagnosticRefs(config: any) {
  // Read known public configuration fields; never serialize the config,
  // which could also contain client credentials.
  try {
    const server = config?.serverMetadata?.();
    const client = config?.clientMetadata?.();
    return {
      issuer_ref: diagnosticRef("issuer", server?.issuer),
      client_ref: diagnosticRef("client", client?.client_id),
      token_endpoint_ref: diagnosticRef("token_endpoint", server?.token_endpoint),
    };
  } catch {
    return { issuer_ref: "unavailable", client_ref: "unavailable", token_endpoint_ref: "unavailable" };
  }
}

function lifetime(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
}

export function loginTokenMetadata(tokens: any) {
  const scopeReturned = typeof tokens?.scope === "string";
  return {
    access_token_present: typeof tokens?.access_token === "string" && tokens.access_token.length > 0,
    id_token_present: typeof tokens?.id_token === "string" && tokens.id_token.length > 0,
    refresh_token_returned: typeof tokens?.refresh_token === "string" && tokens.refresh_token.length > 0,
    access_token_lifetime_seconds: lifetime(tokens?.expires_in),
    // These are non-standard fields. Absence is unknown, never an inferred
    // lifetime. Do not decode or fingerprint a refresh token to infer expiry.
    refresh_expires_in_seconds: lifetime(tokens?.refresh_expires_in),
    refresh_token_expires_in_seconds: lifetime(tokens?.refresh_token_expires_in),
    scope_returned: scopeReturned,
    offline_access_returned: scopeReturned
      ? tokens.scope.split(/\s+/).includes("offline_access") : null,
  };
}

export type LoginTokenMetadata = ReturnType<typeof loginTokenMetadata>;
