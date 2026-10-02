// TVMaze paced queue (issue #5): enqueue outbound calls, drain at TVMaze's pace.
//
// Producers: sync jobs and the MCP catalog_search proxy enqueue via
// client.tvmazeFetch. Consumer: the scheduled drain worker (worker.ts),
// which claims rows FIFO with relay.claimRelayRows (SELECT ... FOR UPDATE
// SKIP LOCKED) and admits each through the shared Postgres pace gate before
// touching api.tvmaze.com. Rows carry their upstream response so waiters can
// build a normal Response; rows nobody waits on are pruned after a day.

import { and, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db";
import { tvmazeQueue, type TvmazeQueueRow } from "@shared/schema";
import { claimRelayRows } from "../relay";
import { admitPacedCall, setPaceCooldown } from "./pace";

export const TVMAZE_USER_AGENT = "FrontRow/1.0 (https://github.com/bcm/front-row)";
export const MAX_ATTEMPTS = 3;
const STUCK_AFTER_MS = 5 * 60_000;
const PRUNE_AFTER_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Raw claimed row: single-word columns come back as-is from the driver. */
interface ClaimedRow {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string> | null;
  body: string | null;
  attempts: number;
}

export interface EnqueueRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export async function enqueueTvmazeRequest(req: EnqueueRequest): Promise<string> {
  const [row] = await db
    .insert(tvmazeQueue)
    .values({
      method: req.method ?? "GET",
      url: req.url,
      headers: req.headers ?? null,
      body: req.body ?? null,
    })
    .returning({ id: tvmazeQueue.id });
  return row.id;
}

export async function getQueuedRow(id: string): Promise<TvmazeQueueRow | undefined> {
  const [row] = await db.select().from(tvmazeQueue).where(eq(tvmazeQueue.id, id));
  return row;
}

/** Wait for a queued row to reach done/failed. Returns null on timeout. */
export async function waitForRow(id: string, timeoutMs: number, pollMs = 250): Promise<TvmazeQueueRow | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await getQueuedRow(id);
    if (row && (row.status === "done" || row.status === "failed")) return row;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs, 60);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.min(Math.max(0, Math.ceil((at - Date.now()) / 1000)), 60);
  return null;
}

async function settleRow(id: string, attempts: number, error?: string): Promise<void> {
  // attempts was already incremented by the claim; exhausted rows fail so
  // waiters stop waiting, the rest go back to the queue.
  if (attempts >= MAX_ATTEMPTS) {
    await db
      .update(tvmazeQueue)
      .set({ status: "failed", error: error ?? "attempts exhausted", completedAt: new Date() })
      .where(eq(tvmazeQueue.id, id));
    return;
  }
  await db
    .update(tvmazeQueue)
    .set({ status: "queued", claimedAt: null })
    .where(eq(tvmazeQueue.id, id));
}

/**
 * One drain pass: claim queued rows FIFO, admit each through the pace gate,
 * fetch, and record the upstream response on the row. Stops at the first
 * unclaimable row or denied gate. Returns the number of completed fetches.
 * fetchFn is injectable for tests.
 */
export async function drainTvmazeQueue(fetchFn: typeof fetch = fetch): Promise<number> {
  let completed = 0;
  for (;;) {
    const [row] = await claimRelayRows<ClaimedRow>({
      table: "tvmaze_queue",
      eligibleWhere: "status = 'queued'",
      claimSet: "status = 'claimed', claimed_at = now(), attempts = attempts + 1",
      limit: 1,
    });
    if (!row) break;
    const gate = await admitPacedCall();
    if (!gate.admitted) {
      // Pace exhausted: release the row, the next tick retries it.
      await db
        .update(tvmazeQueue)
        .set({ status: "queued", claimedAt: null })
        .where(eq(tvmazeQueue.id, row.id));
      break;
    }
    try {
      const res = await fetchFn(row.url, {
        method: row.method,
        headers: { ...(row.headers ?? {}), "User-Agent": TVMAZE_USER_AGENT },
        body: row.body ?? undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const body = await res.text();
      if (res.status === 429) {
        // Backstop: honor Retry-After, requeue, stop this pass.
        await setPaceCooldown(parseRetryAfter(res.headers.get("retry-after")) ?? 5);
        await settleRow(row.id, row.attempts);
        break;
      }
      await db
        .update(tvmazeQueue)
        .set({ status: "done", responseStatus: res.status, responseBody: body, completedAt: new Date() })
        .where(eq(tvmazeQueue.id, row.id));
      completed++;
    } catch (error) {
      await settleRow(row.id, row.attempts, error instanceof Error ? error.message : String(error));
    }
  }
  return completed;
}

/** Recover rows orphaned by a crashed worker so they drain on a later tick. */
export async function requeueStuckRows(): Promise<void> {
  await db
    .update(tvmazeQueue)
    .set({ status: "queued", claimedAt: null })
    .where(
      and(eq(tvmazeQueue.status, "claimed"), lt(tvmazeQueue.claimedAt, new Date(Date.now() - STUCK_AFTER_MS)))
    );
}

/** Retention: completed rows exist for waiters that already gave up; prune daily. */
export async function pruneCompletedRows(): Promise<void> {
  await db
    .delete(tvmazeQueue)
    .where(
      and(
        inArray(tvmazeQueue.status, ["done", "failed"]),
        lt(tvmazeQueue.completedAt, new Date(Date.now() - PRUNE_AFTER_MS))
      )
    );
}
