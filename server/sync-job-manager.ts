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
// The row is left untouched — this is a read-time interpretation only.
function applyHeartbeatTimeout(row: SyncJobRow): SyncJob {
  const view = toView(row);
  if (
    view.status === "running" &&
    Date.now() - view.heartbeatAt.getTime() > SYNC_HEARTBEAT_TIMEOUT_MS
  ) {
    view.status = "error";
    view.lastMessage = SYNC_WORKER_LOST_MESSAGE;
  }
  return view;
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
  // In-flight progress DB writes, per job. flushProgress awaits these before
  // writing, so an older progress write can never land after a terminal
  // update issued from another call.
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
  async getJob(id: string, userId?: string): Promise<SyncJob | null> {
    const rows = await db
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
          ? and(eq(syncJobs.status, "running"), eq(syncJobs.userId, userId))
          : eq(syncJobs.status, "running")
      );
    // Timed-out workers are dead, not active.
    return rows
      .map(applyHeartbeatTimeout)
      .filter((j) => j.status === "running");
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
    return updated.length > 0;
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
  }

  /**
   * Flush any throttled progress for a job. Awaiting it guarantees the
   * latest progress is durable:
   *
   * - It first awaits any in-flight progress write, so a terminal
   *   transition can never run concurrently with an older write that would
   *   land afterward and clobber terminal fields (e.g. percent: 100).
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

    const inflight = this.inflightWrites.get(jobId);
    if (inflight) {
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
      .where(eq(syncJobs.id, jobId));
    const tracked: Promise<void> = write.then(
      () => {
        if (this.inflightWrites.get(jobId) === tracked) {
          this.inflightWrites.delete(jobId);
        }
        scheduled?.resolve();
      },
      (error) => {
        if (this.inflightWrites.get(jobId) === tracked) {
          this.inflightWrites.delete(jobId);
        }
        console.error(`[SYNC_JOB] progress flush failed for ${jobId}:`, error);
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
    );
    this.inflightWrites.set(jobId, tracked);
    // Observe internally so fire-and-forget callers are safe; awaiters of
    // the returned promise still see the rejection.
    tracked.catch(() => {});
    return tracked;
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
          .where(eq(syncJobs.id, jobId));
      } catch (error) {
        console.error(`[SYNC_JOB] progress write failed for ${jobId}:`, error);
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

      addError: async (error) => {
        // Atomic JSONB append in a single UPDATE: route call sites invoke
        // addError without awaiting it, so a read-modify-write here could
        // lose errors when concurrent appends read the same array.
        const now = new Date();
        try {
          await db
            .update(syncJobs)
            .set({
              errors: sql`coalesce(${syncJobs.errors}, '[]'::jsonb) || ${JSON.stringify(error)}::jsonb`,
              updatedAt: now,
              heartbeatAt: now,
            })
            .where(eq(syncJobs.id, jobId));
        } catch (err) {
          console.error(`[SYNC_JOB] addError failed for ${jobId}:`, err);
        }
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
 * then reap terminal jobs older than retention as before.
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
      and(eq(syncJobs.status, "running"), lt(syncJobs.heartbeatAt, cutoff))
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
