// Public TVMaze client (issue #5): every outbound api.tvmaze.com call from
// the sync jobs and the MCP catalog_search proxy goes through here.
//
// No durable queue: tvmazeFetch admits through the shared Postgres pace
// gate (rate + concurrency) and fetches directly. On denial it sleeps with
// jitter until the retry hint or the caller's timeout — synchronous from
// the caller's perspective, never a ticket to poll. Throws
// TvmazePaceTimeout when the budget runs out (MCP tools turn that into 429
// + retry hint) or TvmazeRequestFailed after repeated transport failures.
// GET 200s are served from a short in-memory cache.

import { getCachedResponse, putCachedResponse } from "./cache";
import { tryAcquireSlot, releaseSlot, setPaceCooldown } from "./pace";

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
}

function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ scope: "tvmaze", event, ...fields }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return clampRetryAfter(Math.floor(secs), value);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) {
    return clampRetryAfter(Math.max(0, Math.ceil((at - Date.now()) / 1000)), value);
  }
  return null;
}

// Anomaly bound on upstream backoff. TVMaze would never legitimately ask
// for more than minutes, but a malformed or malicious header must not
// block the shared gate indefinitely — there is no admin UI to clear it,
// so the gate self-heals after this bound instead. Every realistic
// backoff is honored exactly; only absurd values are clamped (with a log).
const MAX_RETRY_AFTER_SEC = 3600;

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
  const headers: Record<string, string> = { "User-Agent": TVMAZE_USER_AGENT };
  if (init?.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });

  if (method === "GET") {
    const cached = getCachedResponse(url);
    if (cached) {
      logEvent("cache_hit", { url });
      return cached;
    }
  }

  let attempts = 0;
  for (;;) {
    const slot = await tryAcquireSlot();
    if (!slot.admitted) {
      const remaining = deadline - Date.now();
      const waitMs = Math.min(
        slot.retryAfterMs + Math.floor(Math.random() * RETRY_JITTER_MS),
        remaining,
      );
      if (waitMs <= 0) {
        logEvent("timeout", { url, waitedMs: timeoutMs });
        throw new TvmazePaceTimeout(Math.max(1, Math.ceil(slot.retryAfterMs / 1000)));
      }
      logEvent("deny", { url, retryAfterMs: slot.retryAfterMs });
      await sleep(waitMs);
      continue;
    }
    logEvent("admit", { url, leaseId: slot.leaseId });
    const leaseId = slot.leaseId;
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: typeof init?.body === "string" ? init.body : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = await res.text();
      if (res.status === 429) {
        // Backstop: honor Retry-After, then loop back — the cooldown denial
        // below sleeps for it. Bounded by the caller's deadline.
        const retryAfterSec = parseRetryAfter(res.headers.get("retry-after")) ?? 5;
        await setPaceCooldown(retryAfterSec);
        logEvent("cooldown", { url, retryAfterSec });
        continue;
      }
      if (method === "GET" && res.status === 200) putCachedResponse(url, 200, body);
      return new Response(body, { status: res.status });
    } catch (error) {
      attempts += 1;
      const detail = error instanceof Error ? error.message : String(error);
      if (attempts >= MAX_ATTEMPTS) {
        logEvent("request_failed", { url, attempts });
        throw new TvmazeRequestFailed(detail);
      }
      logEvent("retry", { url, attempt: attempts, error: detail });
    } finally {
      if (leaseId) await releaseSlot(leaseId);
    }
  }
}
