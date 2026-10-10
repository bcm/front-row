import { randomUUID } from "node:crypto";
import { refreshFailureDiagnostics, providerRejectionSignals } from "./refresh-diagnostics";
import {
  diagnosticRef, providerDiagnosticRefs, type LoginTokenMetadata,
} from "./auth-diagnostic-metadata";

type RefreshEvent =
  | "login_succeeded" | "started" | "waiting" | "session_reloaded" | "already_fresh"
  | "grant_started" | "grant_succeeded" | "session_saved" | "completed" | "failed";
export type RefreshPhase = "session_reload" | "discovery" | "grant" | "session_save" | "waiting";

// Identifies a process, not a host, user, or deployment credential.
const processRef = randomUUID();

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    && value >= 0 && value <= 253402300799 ? Math.floor(value) : null;
}

function tokenMetadata(user: any) {
  const issuedAt = timestamp(user?.claims?.iat);
  const expiresAt = timestamp(user?.expires_at);
  const now = Math.floor(Date.now() / 1000);
  return {
    token_issued_at: issuedAt,
    token_expires_at: expiresAt,
    token_age_seconds: issuedAt === null ? null : Math.max(0, now - issuedAt),
    access_token_expired: expiresAt === null ? null : now > expiresAt,
    refresh_token_present: typeof user?.refresh_token === "string" && user.refresh_token.length > 0,
  };
}

export function createRefreshTrace(sessionID: unknown) {
  const startedAt = Date.now();
  const attemptRef = randomUUID();
  const sessionLabel = diagnosticRef("session", sessionID);
  return (
    event: RefreshEvent,
    user: unknown,
    details: {
      phase?: RefreshPhase; refreshTokenRotated?: boolean; error?: unknown;
      config?: unknown; login?: LoginTokenMetadata;
    } = {},
  ) => {
    try {
      // Explicit fields only. No request objects, raw tokens, user claims,
      // exception messages, provider descriptions, headers, or cookies.
      const record = {
        event,
        timestamp: new Date().toISOString(),
        process_ref: processRef,
        attempt_ref: attemptRef,
        session_ref: sessionLabel,
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        ...tokenMetadata(user),
        ...(details.config ? providerDiagnosticRefs(details.config) : {}),
        ...(event === "login_succeeded" && details.login ? {
          access_token_present: details.login.access_token_present,
          id_token_present: details.login.id_token_present,
          refresh_token_returned: details.login.refresh_token_returned,
          access_token_lifetime_seconds: details.login.access_token_lifetime_seconds,
          refresh_expires_in_seconds: details.login.refresh_expires_in_seconds,
          refresh_token_expires_in_seconds: details.login.refresh_token_expires_in_seconds,
          scope_returned: details.login.scope_returned,
          offline_access_returned: details.login.offline_access_returned,
          offline_access_requested: true,
        } : {}),
        ...(details.phase ? { phase: details.phase } : {}),
        ...(typeof details.refreshTokenRotated === "boolean"
          ? { refresh_token_rotated: details.refreshTokenRotated } : {}),
        ...(event === "failed" ? {
          ...refreshFailureDiagnostics(details.error),
          provider_description_signals: providerRejectionSignals(details.error),
        } : {}),
      };
      // One line preserves the association between the event and its fields
      // when production log aggregation interleaves simultaneous requests.
      console.info(`[auth] refresh_trace ${JSON.stringify(record)}`);
    } catch {
      // Diagnostic failures must never change login or refresh behavior.
      console.warn("[auth] refresh_trace unavailable");
    }
  };
}
