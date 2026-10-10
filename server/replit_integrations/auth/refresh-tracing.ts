import { createHmac, randomUUID } from "node:crypto";
import { refreshFailureDiagnostics } from "./refresh-diagnostics";

type RefreshEvent =
  | "started" | "waiting" | "session_reloaded" | "already_fresh"
  | "grant_started" | "grant_succeeded" | "session_saved" | "completed" | "failed";
export type RefreshPhase = "session_reload" | "discovery" | "grant" | "session_save" | "waiting";

// Identifies a process, not a host, user, or deployment credential.
const processRef = randomUUID();

function sessionRef(sessionID: unknown): string {
  const secret = process.env.SESSION_SECRET;
  if (typeof sessionID !== "string" || !sessionID || !secret) return "unavailable";
  // A keyed, domain-separated label: stable across instances sharing the
  // session signing key, but never the session ID or a usable cookie.
  return createHmac("sha256", secret)
    .update("front-row:refresh-trace:session:")
    .update(sessionID)
    .digest("hex")
    .slice(0, 32);
}

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
  const sessionLabel = sessionRef(sessionID);
  return (
    event: RefreshEvent,
    user: unknown,
    details: { phase?: RefreshPhase; refreshTokenRotated?: boolean; error?: unknown } = {},
  ) => {
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
      ...(details.phase ? { phase: details.phase } : {}),
      ...(typeof details.refreshTokenRotated === "boolean"
        ? { refresh_token_rotated: details.refreshTokenRotated } : {}),
      ...(event === "failed" ? refreshFailureDiagnostics(details.error) : {}),
    };
    // One line preserves the association between the event and its fields
    // when production log aggregation interleaves simultaneous requests.
    console.info(`[auth] refresh_trace ${JSON.stringify(record)}`);
  };
}
