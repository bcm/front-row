// Public TVMaze client (issue #5): every outbound api.tvmaze.com call
// from the sync jobs and the MCP catalog_search proxy goes through here.
// tvmazeFetch admits through the shared Postgres pace gate (rate +
// concurrency) and fetches directly; on denial it sleeps with jitter
// until the retry hint or the caller's timeout. Throws TvmazePaceTimeout
// when the budget runs out (MCP turns it into 429 + retry hint) or
// TvmazeRequestFailed after repeated transport failures. GET 200s are
// served from a short in-memory cache.

import { getCachedResponse, putCachedResponse } from "./cache";
import {
  tryAcquireSlot,
  releaseSlot,
  setPaceCooldown,
  setPaceCooldownUntil,
  MAX_RETRY_AFTER_SEC,
} from "./pace";

export const TVMAZE_USER_AGENT = "FrontRow/1.0 (https://github.com/bcm/front-row)";
export const TVMAZE_MCP_TIMEOUT_MS = 8_000;
export const TVMAZE_SYNC_TIMEOUT_MS = 120_000;

const FETCH_TIMEOUT_MS = 15_000; // per upstream attempt
const MAX_ATTEMPTS = 3; // transport failures before giving up
const RETRY_JITTER_MS = 250; // de-synchronize waiters racing for the next slot

export class TvmazePaceTimeout extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`TVMaze pace gate timed out; retry in ${retryAfterSec}s`);
    this.name = "TvmazePaceTimeout";
    this.retryAfterSec = retryAfterSec;
  }
}

export class TvmazeRequestFailed extends Error {
  constructor(detail: string) {
    super(`TVMaze request failed: ${detail}`);
    this.name = "TvmazeRequestFailed";
  }
}

export interface TvmazeFetchOptions {
  /** How long the caller waits for a pace slot. Default: MCP budget. */
  timeoutMs?: number;
  /** Skip the in-memory GET cache (e.g. forced new-releases refresh). */
  bypassCache?: boolean;
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ scope: "tvmaze", event, ...fields }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delta-seconds Retry-After; null for HTTP-date, missing, unparsable. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (!Number.isFinite(secs) || secs < 0) return null;
  return clampRetryAfter(Math.floor(secs), value);
}

/** HTTP-date Retry-After to its absolute instant; null otherwise. */
export function parseRetryAfterInstant(value: string | null): Date | null {
  if (!value) return null;
  if (Number.isFinite(Number(value))) return null; // delta-seconds form
  const at = Date.parse(value);
  if (Number.isNaN(at)) return null;
  return new Date(at);
}

function clampRetryAfter(secs: number, raw: string): number {
  if (secs <= MAX_RETRY_AFTER_SEC) return secs;
  logEvent("retry_after_clamped", {
    raw,
    requestedSec: secs,
    appliedSec: MAX_RETRY_AFTER_SEC,
  });
  return MAX_RETRY_AFTER_SEC;
}

export async function tvmazeFetch(
  url: string,
  init?: RequestInit,
  opts?: TvmazeFetchOptions,
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? TVMAZE_MCP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const method = init?.method ?? "GET";
  const useCache = method === "GET" && !opts?.bypassCache;
  const headers: Record<string, string> = { "User-Agent": TVMAZE_USER_AGENT };
  if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });

  if (useCache) {
    const cached = getCachedResponse(url);
    if (cached) {
      logEvent("cache_hit", { url });
      return cached;
    }
  }

  let attempts = 0;
  let lastRetryAfterMs = 0;
  for (;;) {
    // Deadline checked BEFORE each acquisition: a timed-out waiter must
    // never consume a shared admission it can't use.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      logEvent("timeout", { url, waitedMs: timeoutMs });
      throw new TvmazePaceTimeout(Math.max(1, Math.ceil(lastRetryAfterMs / 1000)));
    }
    const slot = await tryAcquireSlot();
    if (!slot.admitted) {
      lastRetryAfterMs = slot.retryAfterMs;
      const waitMs = Math.min(
        slot.retryAfterMs + Math.floor(Math.random() * RETRY_JITTER_MS),
        remaining,
      );
      logEvent("deny", { url, retryAfterMs: slot.retryAfterMs });
      await sleep(waitMs);
      continue;
    }
    logEvent("admit", { url, leaseId: slot.leaseId });
    const leaseId = slot.leaseId;
    try {
      // Deadline also binds admitted attempts (re-checked for the race
      // where it falls inside tryAcquireSlot()): each fetch is capped at
      // the remaining budget, not the full 15s.
      const postAcquireRemaining = deadline - Date.now();
      if (postAcquireRemaining <= 0) {
        logEvent("timeout", { url, waitedMs: timeoutMs });
        throw new TvmazePaceTimeout(1);
      }
      const res = await fetch(url, {
        method,
        headers,
        body: typeof init?.body === "string" ? init.body : undefined,
        signal: AbortSignal.timeout(Math.min(FETCH_TIMEOUT_MS, postAcquireRemaining)),
      });
      const body = await res.text();
      if (res.status === 429) {
        // Honor Retry-After, then loop back — the cooldown denial sleeps
        // for it. HTTP-date keeps its absolute instant (DB clock in SQL);
        // delta-seconds is anchored by setPaceCooldown.
        const raw = res.headers.get("retry-after");
        const instant = parseRetryAfterInstant(raw);
        if (instant) {
          const applied = await setPaceCooldownUntil(instant);
          if (applied.getTime() < instant.getTime()) {
            logEvent("retry_after_clamped", {
              raw,
              requestedAt: instant.toISOString(),
              appliedAt: applied.toISOString(),
            });
          }
          logEvent("cooldown", { url, retryAfterAt: applied.toISOString() });
        } else {
          const retryAfterSec = parseRetryAfter(raw) ?? 5;
          await setPaceCooldown(retryAfterSec);
          logEvent("cooldown", { url, retryAfterSec });
        }
        continue;
      }
      if (useCache && res.status === 200) putCachedResponse(url, 200, body);
      return new Response(body, { status: res.status });
    } catch (error) {
      // A pace timeout is terminal — never converted into a retry.
      if (error instanceof TvmazePaceTimeout) throw error;
      // A fetch aborted because the caller's budget ran out is a timeout,
      // not a transport failure.
      if (Date.now() >= deadline) {
        logEvent("timeout", { url, waitedMs: timeoutMs });
        throw new TvmazePaceTimeout(1);
      }
      attempts += 1;
      const detail = error instanceof Error ? error.message : String(error);
      if (attempts >= MAX_ATTEMPTS) {
        logEvent("request_failed", { url, attempts });
        throw new TvmazeRequestFailed(detail);
      }
      logEvent("retry", { url, attempt: attempts, error: detail });
    } finally {
      // Best-effort: a release failure must never override the outcome.
      if (leaseId) {
        try {
          await releaseSlot(leaseId);
        } catch (error) {
          logEvent("release_failed", {
            url,
            leaseId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }
}
