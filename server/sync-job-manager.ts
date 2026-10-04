// Durable sync job state (issue #6). Replaces the old per-replica in-memory
// Map: every state transition writes through to the sync_jobs table, so any
// replica (UI polling, API, MCP sync_status) reads the same job state.
//
// Heartbeat: the reporter's progress writes advance heartbeat_at, throttled
// to at most one write per second. Readers treat a 'running' job whose
// heartbeat is older than SYNC_HEARTBEAT_TIMEOUT_MS as dead — computed on
// read, the row itself is never mutated by a reader.

import { eq, and, desc, lt, or } from "drizzle-orm";
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
  // Awaitable handles for in-flight throttled flushes, so callers that
  // await a reporter method get durability, not fire-and-forget.
  private inflightFlush = new Map<string, { promise: Promise<void>; resolve: () => void }>();

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
    await this.flushProgress(jobId);
    const now = new Date();
    await db
      .update(syncJobs)
      .set({ status: "running", updatedAt: now, heartbeatAt: now })
      .where(eq(syncJobs.id, jobId));
  }

  async markJobSuccess(
    jobId: string,
    episodesImported: number,
    episodesUpdated: number
  ): Promise<void> {
    await this.flushProgress(jobId);
    const now = new Date();
    await db
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
      .where(eq(syncJobs.id, jobId));
  }

  async markJobError(jobId: string, error: string): Promise<void> {
    await this.flushProgress(jobId);
    const now = new Date();
    await db
      .update(syncJobs)
      .set({
        status: "error",
        lastMessage: `Sync failed: ${error}`,
        updatedAt: now,
        heartbeatAt: now,
        finishedAt: now,
      })
      .where(eq(syncJobs.id, jobId));
  }

  async cancelJob(jobId: string): Promise<boolean> {
    await this.flushProgress(jobId);
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

  /** Flush any throttled progress for a job. Awaiting it guarantees the
   *  latest progress is durable. Called by the terminal transitions; also
   *  exposed for tests. */
  async flushProgress(jobId: string): Promise<void> {
    const timer = this.progressTimers.get(jobId);
    if (timer) {
      clearTimeout(timer);
      this.progressTimers.delete(jobId);
    }
    const pending = this.pendingProgress.get(jobId);
    this.pendingProgress.delete(jobId);
    if (!pending) {
      this.settleFlush(jobId);
      return;
    }
    this.lastProgressFlush.set(jobId, Date.now());
    const now = new Date();
    try {
      await db
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
    } catch (error) {
      console.error(`[SYNC_JOB] progress flush failed for ${jobId}:`, error);
    }
    this.settleFlush(jobId);
  }

  private settleFlush(jobId: string): void {
    const entry = this.inflightFlush.get(jobId);
    if (entry) {
      this.inflightFlush.delete(jobId);
      entry.resolve();
    }
  }

  private trackFlush(jobId: string, p: Promise<void>): Promise<void> {
    const existing = this.inflightFlush.get(jobId);
    if (existing) return existing.promise;
    let resolve!: () => void;
    const tracked = new Promise<void>((res) => {
      resolve = res;
    });
    this.inflightFlush.set(jobId, { promise: tracked, resolve });
    p.then(
      () => this.settleFlush(jobId),
      () => this.settleFlush(jobId)
    );
    return tracked;
  }

  private scheduleProgressFlush(jobId: string): Promise<void> {
    const elapsed = Date.now() - (this.lastProgressFlush.get(jobId) ?? 0);
    if (elapsed >= PROGRESS_FLUSH_MS) {
      return this.trackFlush(jobId, this.flushProgress(jobId));
    }
    const existing = this.inflightFlush.get(jobId);
    if (existing) return existing.promise;
    let resolve!: () => void;
    const tracked = new Promise<void>((res) => {
      resolve = res;
    });
    this.inflightFlush.set(jobId, { promise: tracked, resolve });
    const timer = setTimeout(() => {
      this.progressTimers.delete(jobId);
      const p = this.flushProgress(jobId);
      p.then(
        () => this.settleFlush(jobId),
        () => this.settleFlush(jobId)
      );
    }, PROGRESS_FLUSH_MS - elapsed);
    this.progressTimers.set(jobId, timer);
    return tracked;
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
        // Append without a read-modify-write race: errors are only ever
        // appended by the single worker owning the job.
        const rows = await db
          .select({ errors: syncJobs.errors })
          .from(syncJobs)
          .where(eq(syncJobs.id, jobId))
          .limit(1);
        const errors = [...(rows[0]?.errors ?? []), error];
        await touchHeartbeat({ errors });
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

// Reap finished jobs older than 24h, hourly. Running jobs are never reaped:
// a dead worker's row stays 'running' and reads as a heartbeat timeout.
setInterval(async () => {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
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
  } catch (error) {
    console.error("[SYNC_JOB] cleanup failed:", error);
  }
}, 60 * 60 * 1000);
