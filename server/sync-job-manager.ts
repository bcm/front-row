// Durable sync job state (issue #6). Replaces the old per-replica in-memory
// Map: every state transition writes through to the sync_jobs table, so any
// replica (UI polling, API, MCP sync_status) reads the same job state.
//
// Heartbeat: the reporter's progress writes advance heartbeat_at, throttled
// to at most one write per second. Readers treat a 'running' job whose
// heartbeat is older than SYNC_HEARTBEAT_TIMEOUT_MS as dead — computed on
// read, the row itself is never mutated by a reader.

import { eq, and, desc, lt, or, sql } from "drizzle-orm";
import { db } from "./db";
import { syncJobs, type SyncJobRow } from "@shared/schema";

export type SyncJobKind = "show-sync" | "library-import" | "episode-import";
export type SyncJobStatus = "queued" | "running" | "success" | "error" | "canceled";
export type SyncJobPhase =
  | "fetch-show"
  | "fetch-scrobbles"
  | "fetch-episodes"
  | "process-episodes"
  | "finalize";

// The paced TVMaze client can pause longer than this between shows, so the
// heartbeat rides on every throttled progress tick — not only on phase
// changes. Five minutes is generous; a worker silent this long is gone.
export const SYNC_HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;
export const SYNC_WORKER_LOST_MESSAGE = "Sync worker lost (heartbeat timeout)";

// Progress flushes are throttled to at most one DB write per second per job;
// the trailing flush guarantees the final values land.
const PROGRESS_FLUSH_MS = 1000;

// Cap on re-check passes in the write-drain loops (flushProgress and
// flushProgressQuietly). Each pass awaits at most one tracked write;
// reporter writes are throttled to ~1/s, so in practice the drain settles
// in one or two passes — the bound only guards against a pathological
// constantly-chattering writer starving the drain forever. A straggler
// past the bound stays chained behind the other writes (see
// trackInflightWrite), so it still lands in order and can only no-op
// against an already-terminal row via the active-row guard, never
// clobber it.
const DRAIN_MAX_PASSES = 10;

export interface SyncJob {
  id: string;
  userId: string;
  kind: SyncJobKind;
  showId: number | null;
  status: SyncJobStatus;
  phase: string;
  totalShows: number;
  completedShows: number;
  percent: number;
  etaSeconds: number | null;
  errors: string[];
  startedAt: Date;
  updatedAt: Date;
  heartbeatAt: Date;
  finishedAt: Date | null;
  canceled: boolean;
  lastMessage: string | null;
  episodesImported: number;
  episodesUpdated: number;
}

export interface ProgressReporter {
  setPhase(phase: SyncJobPhase, message: string): Promise<void>;
  setTotal(total: number): Promise<void>;
  incrementCompleted(message?: string): Promise<void>;
  addError(error: string): Promise<void>;
  checkCanceled(): Promise<boolean>;
  getJob(): Promise<SyncJob | null>;
}

function toView(row: SyncJobRow): SyncJob {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind as SyncJobKind,
    showId: row.showId,
    status: row.status as SyncJobStatus,
    phase: row.phase,
    totalShows: row.totalShows,
    completedShows: row.completedShows,
    percent: row.percent,
    etaSeconds: row.etaSeconds,
    errors: row.errors ?? [],
    startedAt: row.startedAt ?? new Date(0),
    updatedAt: row.updatedAt ?? new Date(0),
    heartbeatAt: row.heartbeatAt ?? new Date(0),
    finishedAt: row.finishedAt,
    canceled: row.canceled,
    lastMessage: row.lastMessage,
    episodesImported: row.episodesImported,
    episodesUpdated: row.episodesUpdated,
  };
}

// A 'running' job whose worker stopped heartbeating reads as a dead job.
// A 'queued' job only lives in the milliseconds between createJob and the
// deferred markJobRunning, so one older than the timeout means the replica
// crashed in that window — its age is measured from startedAt, which is the
// insert time and never advances while queued. The row is left untouched —
// this is a read-time interpretation only.
function applyHeartbeatTimeout(row: SyncJobRow): SyncJob {
  const view = toView(row);
  if (
    (view.status === "running" &&
      Date.now() - view.heartbeatAt.getTime() > SYNC_HEARTBEAT_TIMEOUT_MS) ||
    (view.status === "queued" &&
      Date.now() - view.startedAt.getTime() > SYNC_HEARTBEAT_TIMEOUT_MS)
  ) {
    view.status = "error";
    view.lastMessage = SYNC_WORKER_LOST_MESSAGE;
  }
  return view;
}

// Reporter progress writes only touch active rows. A terminal transition
// (cancel/success/error, possibly from another replica) that commits while
// the worker is mid-item must win: Postgres rechecks this predicate at
// write time, so a late progress flush no-ops instead of clobbering
// terminal fields (e.g. replacing the cancel message with an item's
// progress message). Same guard the terminal transitions use.
function activeJob(jobId: string) {
  return and(
    eq(syncJobs.id, jobId),
    or(eq(syncJobs.status, "queued"), eq(syncJobs.status, "running"))
  );
}

interface PendingProgress {
  completedShows: number;
  percent: number;
  etaSeconds: number | null;
  lastMessage?: string;
}

export class SyncJobManager {
  private pendingProgress = new Map<string, PendingProgress>();
  private progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastProgressFlush = new Map<string, number>();
  // In-flight DB writes per job (progress flushes and addError appends),
  // chained so an older write can never land after a newer one. Terminal
  // transitions drain these before committing (see flushProgressQuietly),
  // so a fire-and-forget write always lands while the row is still active.
  private inflightWrites = new Map<string, Promise<void>>();
  // Deferred handles for throttled (trailing-edge) flushes, per job: the
  // promise a reporter method returned settles when its flush lands, so an
  // awaiting caller gets durability, not fire-and-forget.
  private scheduledFlushes = new Map<
    string,
    {
      promise: Promise<void>;
      resolve: () => void;
      reject: (err: unknown) => void;
    }
  >();

  private makeId(showId: number | null | undefined): string {
    const sid = showId ?? 0;
    return `sync_${sid}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async createJob(
    userId: string,
    kind: SyncJobKind,
    showId?: number | null
  ): Promise<string> {
    const id = this.makeId(showId);
    await db.insert(syncJobs).values({
      id,
      userId,
      kind,
      showId: showId ?? null,
      status: "queued",
      phase: "fetch-show",
      lastMessage: "Starting sync...",
    });
    return id;
  }

  /** Read a job by id, with the heartbeat timeout applied. When userId is
   *  given, jobs owned by another user read as not found. */
  async getJob(id: string, userId?: string): Promise<SyncJob | null> {   const rows = await db
      .select()
      .from(syncJobs)
      .where(
        userId
          ? and(eq(syncJobs.id, id), eq(syncJobs.userId, userId))
          : eq(syncJobs.id, id)
      )
      .limit(1);
    if (rows.length === 0) return null;
    return applyHeartbeatTimeout(rows[0]);
  }

  /** The user's most recent job, with the heartbeat timeout applied. */
  async getLatestJob(userId: string): Promise<SyncJob | null> {
    const rows = await db
      .select()
      .from(syncJobs)
      .where(eq(syncJobs.userId, userId))
      .orderBy(desc(syncJobs.startedAt))
      .limit(1);
    if (rows.length === 0) return null;
    return applyHeartbeatTimeout(rows[0]);
  }

  async getActiveJobs(userId?: string): Promise<SyncJob[]> {
    const rows = await db
      .select()
      .from(syncJobs)
      .where(
        userId
          ? and(
              or(eq(syncJobs.status, "running"), eq(syncJobs.status, "queued")),
              eq(syncJobs.userId, userId)
            )
          : or(eq(syncJobs.status, "running"), eq(syncJobs.status, "queued"))
      );
    // Timed-out workers are dead, not active. Stale queued jobs (crashed
    // between createJob and markJobRunning) read as error via the
    // heartbeat-timeout interpretation and are filtered out here.
    return rows
      .map(applyHeartbeatTimeout)
      .filter((j) => j.status === "running" || j.status === "queued");
  }

  async markJobRunning(jobId: string): Promise<void> {
    await this.flushProgressQuietly(jobId);
    const now = new Date();
    await db
      .update(syncJobs)
      .set({ status: "running", updatedAt: now, heartbeatAt: now })
      .where(eq(syncJobs.id, jobId));
  }

  /**
   * Terminal transitions are conditional on the row still being active: a
   * cancellation that wins after the worker's final cancellation check must
   * stay terminal. Returns whether the transition was applied.
   */
  async markJobSuccess(
    jobId: string,
    episodesImported: number,
    episodesUpdated: number
  ): Promise<boolean> {
    await this.flushProgressQuietly(jobId);
    const now = new Date();
    const updated = await db
      .update(syncJobs)
      .set({
        status: "success",
        episodesImported,
        episodesUpdated,
        lastMessage: `Sync completed successfully. ${episodesImported} episodes imported, ${episodesUpdated} updated.`,
        percent: 100,
        updatedAt: now,
        heartbeatAt: now,
        finishedAt: now,
      })
      .where(
        and(
          eq(syncJobs.id, jobId),
          or(eq(syncJobs.status, "queued"), eq(syncJobs.status, "running"))
        )
      )
      .returning({ id: syncJobs.id });
    // The job can never make progress again; drop the per-job throttle
    // state so the in-memory maps don't retain an entry per finished job.
    this.clearThrottleState(jobId);
    return updated.length > 0;
  }

  /** Same conditional-transition contract as markJobSuccess. */
  async markJobError(jobId: string, error: string): Promise<boolean> {
    await this.flushProgressQuietly(jobId);
    const now = new Date();
    const updated = await db
      .update(syncJobs)
      .set({
        status: "error",
        lastMessage: `Sync failed: ${error}`,
        updatedAt: now,
        heartbeatAt: now,
        finishedAt: now,
      })
      .where(
        and(
          eq(syncJobs.id, jobId),
          or(eq(syncJobs.status, "queued"), eq(syncJobs.status, "running"))
        )
      )
      .returning({ id: syncJobs.id });
    this.clearThrottleState(jobId);
    return updated.length > 0;
  }

  async cancelJob(jobId: string): Promise<boolean> {
    await this.flushProgressQuietly(jobId);
    const now = new Date();
    const updated = await db
      .update(syncJobs)
      .set({
        canceled: true,
        status: "canceled",
        lastMessage: "Sync canceled by user",
        updatedAt: now,
        heartbeatAt: now,
        finishedAt: now,
      })
      .where(and(eq(syncJobs.id, jobId), eq(syncJobs.status, "running")))
      .returning({ id: syncJobs.id });
    this.clearThrottleState(jobId);
    return updated.length > 0;
  }

  /**
   * Track an in-flight DB write for a job so a terminal transition can
   * drain it first (see flushProgressQuietly). New writes chain onto the
   * previous tracked write, so draining awaits every write issued so far
   * even when several fire-and-forget writes overlap — e.g. an unawaited
   * addError racing a terminal transition.
   *
   * The thunk runs only after previously tracked writes settle, so an
   * older write can never land after a newer one. Tracked writes are plain
   * UPDATEs that never wait on a terminal transition, so draining them
   * cannot deadlock.
   */
  private trackInflightWrite(
    jobId: string,
    startWrite: () => Promise<void>
  ): Promise<void> {
    const previous = this.inflightWrites.get(jobId);
    let settled!: Promise<void>;
    settled = (async () => {
      if (previous) {
        try {
          await previous;
        } catch {
          // A failed write preserved its own snapshot / logged itself;
          // later writes still go through.
        }
      }
      await startWrite();
    })().then(
      () => {
        if (this.inflightWrites.get(jobId) === settled) {
          this.inflightWrites.delete(jobId);
        }
      },
      (error) => {
        if (this.inflightWrites.get(jobId) === settled) {
          this.inflightWrites.delete(jobId);
        }
        throw error;
      }
    );
    this.inflightWrites.set(jobId, settled);
    // Observed internally so fire-and-forget callers (e.g. an unawaited
    // addError) can't trigger unhandled-rejection warnings; explicit
    // awaiters still see the rejection.
    settled.catch(() => {});
    return settled;
  }

  /**
   * Flush wrapper for the state-transition methods: a failed progress flush
   * preserves its snapshot for the next flush (see flushProgress), and the
   * transition itself must still be attempted — terminal state matters more
   * than the last progress tick.
   */
  private async flushProgressQuietly(jobId: string): Promise<void> {
    try {
      await this.flushProgress(jobId);
    } catch (error) {
      console.error(
        `[SYNC_JOB] pre-transition progress flush failed for ${jobId}:`,
        error
      );
      // The failed flush preserved its snapshot, but no further progress
      // ticks will come after a terminal transition — drop it rather than
      // leak it in the pending map.
      this.pendingProgress.delete(jobId);
    }
    // Drain stragglers: a fire-and-forget write issued while the flush
    // above was running (e.g. an unawaited addError) must land before the
    // terminal UPDATE commits — the error has to arrive while the row is
    // still active, or the active-row guard turns it into a silent no-op.
    // Re-check the map after each await: a write issued during the drain
    // chains onto the tracked promise and is awaited in turn. Tracked
    // writes are plain UPDATEs that never wait on a terminal transition,
    // so this cannot deadlock. Bounded by DRAIN_MAX_PASSES (see above):
    // with the ordering chain, a straggler past the bound lands after the
    // terminal commit and no-ops cleanly against the terminal row.
    for (let pass = 0; pass < DRAIN_MAX_PASSES; pass++) {
      const inflight = this.inflightWrites.get(jobId);
      if (!inflight) return;
      try {
        await inflight;
      } catch {
        // Failures are logged where the write was issued; the terminal
        // transition must still be attempted.
      }
    }
  }

  /**
   * Flush any throttled progress for a job. Awaiting it guarantees the
   * latest progress is durable:
   *
   * - It first awaits any in-flight write, so a terminal
   *   transition can never run concurrently with an older write that would
   *   land afterward and clobber terminal fields (e.g. percent: 100).
   * - The write only touches active rows (queued/running): a terminal
   *   transition that committed while the flush was pending makes the
   *   write a clean no-op, so a late progress tick can't clobber the
   *   terminal message either.
   * - On DB failure the pending snapshot is preserved for the next flush
   *   (heartbeats resume instead of silently stopping) and the returned
   *   promise rejects, so awaited writes observe the failure. The rejection
   *   is also observed internally, so intentionally fire-and-forget callers
   *   can't trigger unhandled-rejection warnings.
   */
  async flushProgress(jobId: string): Promise<void> {
    const timer = this.progressTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.progressTimers.delete(jobId);
    }
    // A trailing flush was scheduled but this explicit flush supersedes it:
    // its awaiters ride on this flush's outcome.
    const scheduled = this.scheduledFlushes.get(jobId);
    if (scheduled) this.scheduledFlushes.delete(jobId);

    // Re-checking drain: a reporter write issued while the drain await is
    // pending (e.g. an unawaited addError) chains a newer promise into
    // inflightWrites. Drain again until a full pass finds the map stable —
    // otherwise the progress write installed below would overwrite the
    // newer entry, the straggler drain in flushProgressQuietly would see an
    // empty map, and the terminal UPDATE could commit while the newer write
    // was still running (its active-row guard would then silently drop it).
    // Bounded by DRAIN_MAX_PASSES (see above); a straggler past the bound
    // stays chained behind the progress write and lands in order.
    for (let pass = 0; pass < DRAIN_MAX_PASSES; pass++) {
      const inflight = this.inflightWrites.get(jobId);
      if (!inflight) break;
      try {
        await inflight;
      } catch {
        // The failed write preserved its snapshot (see below); proceed —
        // a terminal transition must still be attempted.
      }
    }

    const pending = this.pendingProgress.get(jobId);
    this.pendingProgress.delete(jobId);
    if (!pending) {
      scheduled?.resolve();
      return;
    }

    this.lastProgressFlush.set(jobId, Date.now());
    const now = new Date();
    const write = db
      .update(syncJobs)
      .set({
        completedShows: pending.completedShows,
        percent: pending.percent,
        etaSeconds: pending.etaSeconds,
        ...(pending.lastMessage !== undefined
          ? { lastMessage: pending.lastMessage }
          : {}),
        updatedAt: now,
        heartbeatAt: now,
      })
      // Active rows only: a terminal transition that committed while this
      // flush was pending makes the write a no-op instead of clobbering
      // terminal fields.
      .where(activeJob(jobId));
    // Chain onto whatever is tracked now rather than overwriting the map:
    // a write issued during the drain above stays ahead of this flush in
    // the ordering chain, so it can never be hidden from the straggler
    // drain in flushProgressQuietly.
    const tracked = this.trackInflightWrite(jobId, () =>
      write
        .returning({ id: syncJobs.id })
        .then(
          (updated) => {
            if (updated.length === 0) {
              // The flush was a no-op: the job reached a terminal state
              // (locally, or on another replica observed via the active-row
              // guard) while this flush was pending. Drop the per-job
              // throttle state — no further progress will ever land, and
              // retaining the timestamp entry would leak one map entry per
              // finished job.
              this.clearThrottleState(jobId);
            }
            scheduled?.resolve();
          },
          (error) => {
            console.error(
              `[SYNC_JOB] progress flush failed for ${jobId}:`,
              error
            );
            // Preserve the snapshot so the next flush retries it instead of
            // silently dropping the heartbeat — unless newer progress has
            // already superseded it.
            const existing = this.pendingProgress.get(jobId);
            if (
              !existing ||
              existing.completedShows < pending.completedShows
            ) {
              this.pendingProgress.set(jobId, pending);
            }
            scheduled?.reject(error);
            throw error;
          }
        )
    );
    return tracked;
  }

  /**
   * Drop per-job progress-throttle state (pending snapshot, timer, last
   * flush timestamp). Called once the job can never make progress again:
   * after a local terminal transition commits, or when a flush no-ops
   * against a terminal row (the job finished on another replica). Without
   * this, the in-memory maps retain one entry per finished job for the
   * replica's lifetime. scheduledFlushes is consumed by flushProgress
   * itself and inflightWrites self-cleans on settle, so only these three
   * maps need explicit clearing.
   */
  private clearThrottleState(jobId: string): void {
    this.pendingProgress.delete(jobId);
    const timer = this.progressTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.progressTimers.delete(jobId);
    }
    this.lastProgressFlush.delete(jobId);
  }

  /** Exported for tests: number of per-job throttle entries currently held. */
  throttleStateSize(): number {
    return (
      this.pendingProgress.size +
      this.progressTimers.size +
      this.lastProgressFlush.size +
      this.scheduledFlushes.size +
      this.inflightWrites.size
    );
  }

  private scheduleProgressFlush(jobId: string): Promise<void> {
    const elapsed = Date.now() - (this.lastProgressFlush.get(jobId) ?? 0);
    if (elapsed >= PROGRESS_FLUSH_MS) {
      return this.flushProgress(jobId);
    }
    const scheduled = this.scheduledFlushes.get(jobId);
    if (scheduled) return scheduled.promise;
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Fire-and-forget callers are safe; awaiters still observe failures.
    promise.catch(() => {});
    this.scheduledFlushes.set(jobId, { promise, resolve, reject });
    const timer = setTimeout(() => {
      this.progressTimers.delete(jobId);
      this.scheduledFlushes.delete(jobId);
      this.flushProgress(jobId).then(resolve, reject);
    }, PROGRESS_FLUSH_MS - elapsed);
    this.progressTimers.set(jobId, timer);
    return promise;
  }

  createReporter(jobId: string): ProgressReporter {
    const startTime = Date.now();
    let processStartTime: number | null = null;
    let completedShows = 0;
    let totalShows = 0;

    const touchHeartbeat = async (fields: Record<string, unknown>) => {
      const now = new Date();
      try {
        await db
          .update(syncJobs)
          .set({ ...fields, updatedAt: now, heartbeatAt: now })
          // Active rows only: a phase/message write after a terminal
          // transition must not clobber the terminal message (or heartbeat).
          .where(activeJob(jobId));
      } catch (error) {
        // setPhase/setTotal are awaited to guarantee durable ordering, so a
        // failed UPDATE must be visible to the caller: re-throw after
        // logging instead of converting the failure into apparent success
        // (the worker would otherwise continue and mark the job successful
        // although the phase/total write was lost). The worker's try/catch
        // funnels it into markJobError, and the deferred task has an
        // explicit rejection handler — it can never become an unhandled
        // rejection.
        console.error(`[SYNC_JOB] progress write failed for ${jobId}:`, error);
        throw error;
      }
    };

    return {
      setPhase: async (phase, message) => {
        if (phase === "process-episodes") {
          processStartTime = Date.now();
        }
        await touchHeartbeat({ phase, lastMessage: message });
      },

      setTotal: async (total) => {
        totalShows = total;
        await touchHeartbeat({ totalShows: total });
      },

      incrementCompleted: (message) => {
        completedShows++;
        const percent =
          totalShows > 0 ? Math.round((completedShows / totalShows) * 100) : 0;
        let etaSeconds: number | null = null;
        if (processStartTime && completedShows >= 3) {
          const elapsed = (Date.now() - processStartTime) / 1000;
          const avgPerShow = elapsed / completedShows;
          etaSeconds = Math.round((totalShows - completedShows) * avgPerShow);
        }
        this.pendingProgress.set(jobId, {
          completedShows,
          percent,
          etaSeconds,
          ...(message !== undefined ? { lastMessage: message } : {}),
        });
        // Awaiting this guarantees the progress is durable; non-awaiting
        // callers get at-most-once-per-second throttled writes.
        return this.scheduleProgressFlush(jobId);
      },

      addError: (error) => {
        // Atomic JSONB append in a single UPDATE: route call sites invoke
        // addError without awaiting it, so a read-modify-write here could
        // lose errors when concurrent appends read the same array.
        const now = new Date();
        const tracked = this.trackInflightWrite(jobId, () =>
          db
            .update(syncJobs)
            .set({
              errors: sql`coalesce(${syncJobs.errors}, '[]'::jsonb) || ${JSON.stringify(error)}::jsonb`,
              updatedAt: now,
              heartbeatAt: now,
            })
            // Active rows only: errors arriving after a terminal transition
            // (e.g. from a worker that hasn't observed the cancel yet) must
            // not touch the row.
            .where(activeJob(jobId))
            .then(() => {})
        );
        // Tracked alongside the progress writes: terminal transitions drain
        // in-flight writes before committing (see flushProgressQuietly), so
        // an unawaited addError lands while the row is still active instead
        // of racing the terminal UPDATE and no-op'ing against the
        // now-terminal row. The raw tracked promise is returned, so an
        // awaiting caller sees a write failure as a rejection instead of
        // believing the error was durable. This .catch keeps fire-and-forget
        // callers safe (no unhandled-rejection warnings) and logs the lost
        // error.
        tracked.catch((err) => {
          console.error(`[SYNC_JOB] addError failed for ${jobId}:`, err);
        });
        return tracked;
      },

      // Reads the row, so a cancel issued from any replica is honored.
      checkCanceled: async () => {
        const rows = await db
          .select({ canceled: syncJobs.canceled })
          .from(syncJobs)
          .where(eq(syncJobs.id, jobId))
          .limit(1);
        return rows[0]?.canceled ?? false;
      },

      getJob: () => this.getJob(jobId),
    };
  }
}

// Global instance
export const syncJobManager = new SyncJobManager();

// Jobs are retained for 24h after their last update, then reaped.
const SYNC_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Hourly maintenance, exported for tests.
 *
 * Dead workers leave 'running' rows that nothing would ever delete (readers
 * only compute the heartbeat timeout, never persist it), so first terminate
 * running jobs whose heartbeat has been stale beyond the retention period,
 * then reap terminal jobs older than retention as before. 'queued' rows are
 * included in the first pass: a replica can crash between createJob and the
 * deferred markJobRunning, leaving an orphan that no worker will ever pick
 * up (heartbeat_at is the insert time for queued rows, since nothing
 * advances it while queued, so the same cutoff identifies them).
 */
export async function cleanupSyncJobs(now: number = Date.now()): Promise<void> {
  const cutoff = new Date(now - SYNC_JOB_RETENTION_MS);
  const stamp = new Date(now);
  await db
    .update(syncJobs)
    .set({
      status: "error",
      lastMessage: SYNC_WORKER_LOST_MESSAGE,
      updatedAt: stamp,
      finishedAt: stamp,
    })
    .where(
      and(
        or(eq(syncJobs.status, "running"), eq(syncJobs.status, "queued")),
        lt(syncJobs.heartbeatAt, cutoff)
      )
    );
  await db
    .delete(syncJobs)
    .where(
      and(
        lt(syncJobs.updatedAt, cutoff),
        or(
          eq(syncJobs.status, "success"),
          eq(syncJobs.status, "error"),
          eq(syncJobs.status, "canceled")
        )
      )
    );
}

// Reap old jobs hourly.
setInterval(() => {
  cleanupSyncJobs().catch((error) =>
    console.error("[SYNC_JOB] cleanup failed:", error)
  );
}, 60 * 60 * 1000);
