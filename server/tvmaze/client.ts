// Public TVMaze client (issue #5): every outbound api.tvmaze.com call from
// the sync jobs and the MCP catalog_search proxy goes through here.
//
// tvmazeFetch enqueues into tvmaze_queue and waits for the scheduled drain
// worker; the worker admits through the shared Postgres pace gate (18 calls
// per 10s per IP, evenly spaced). Synchronous from the caller's perspective:
// it resolves with the upstream Response, throws TvmazePaceTimeout when the
// wait exceeds the caller's budget (MCP tools turn that into 429 + retry
// hint — never a ticket for the client to poll), or TvmazeRequestFailed when
// the upstream call exhausted its attempts. On timeout the queued row is
// cancelled if it never started, so expired requests don't burn the shared
// upstream budget ahead of live ones.

import { cancelQueuedRow, enqueueTvmazeRequest, waitForRow } from "./queue";
import { TVMAZE_PACE_WINDOW_MS } from "./pace";

export const TVMAZE_MCP_TIMEOUT_MS = 8_000;
export const TVMAZE_SYNC_TIMEOUT_MS = 120_000;

export class TvmazePaceTimeout extends Error {
  readonly retryAfterSec: number;
  constructor(retryAfterSec: number) {
    super(`TVMaze pace queue timed out; retry in ${retryAfterSec}s`);
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
  /** How long the caller waits for the drain worker. Default: MCP budget. */
  timeoutMs?: number;
}

export async function tvmazeFetch(
  url: string,
  init?: RequestInit,
  opts?: TvmazeFetchOptions
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init?.headers) new Headers(init.headers).forEach((v, k) => {
    headers[k] = v;
  });
  const id = await enqueueTvmazeRequest({
    url,
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? init.body : undefined,
  });
  const row = await waitForRow(id, opts?.timeoutMs ?? TVMAZE_MCP_TIMEOUT_MS);
  if (!row) {
    // The caller gave up: drop the request if it never started, so expired
    // searches don't sit ahead of live ones burning the shared budget.
    // Already-claimed rows finish normally.
    await cancelQueuedRow(id);
    throw new TvmazePaceTimeout(Math.ceil(TVMAZE_PACE_WINDOW_MS / 1000));
  }
  if (row.status === "failed") throw new TvmazeRequestFailed(row.error ?? "unknown");
  return new Response(row.responseBody ?? "", { status: row.responseStatus ?? 502 });
}
