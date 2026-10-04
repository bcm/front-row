// Integration suite for durable sync job state (issue #6): the PG-backed
// SyncJobManager and the re-added sync_status MCP tool, against a real
// scratch postgres (CI provisions it; see .github/workflows/ci.yml).
//
// Not part of `npm test`; run with `npm run test:integration`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Express } from "express";
import {
  closeTestResources,
  createSessionCookie,
  createTestApp,
  request,
} from "./test/integration-harness";

// The harness sets DATABASE_URL before these imports resolve server/db.
import { db } from "./db";
import { syncJobs } from "@shared/schema";
import {
  syncJobManager,
  SyncJobManager,
  SYNC_WORKER_LOST_MESSAGE,
  cleanupSyncJobs,
} from "./sync-job-manager";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSyncTools } from "./mcp/tools/sync";
import { toolRegistrar } from "./mcp/register";
import { callTool, testAuth } from "./mcp/test-utils/tools";

const USER_A = "sync-test-user-a";
const USER_B = "sync-test-user-b";

function syncServer() {
  const s = new McpServer({ name: "test", version: "0" });
  registerSyncTools(toolRegistrar(s), testAuth);
  return s;
}

async function rawRow(id: string) {
  const rows = await db.select().from(syncJobs).where(eq(syncJobs.id, id));
  return rows[0] ?? null;
}

async function backdateHeartbeat(id: string, minutesAgo: number) {
  await db.execute(sql`
    UPDATE "sync_jobs"
    SET "heartbeat_at" = now() - (${minutesAgo} || ' minutes')::interval
    WHERE "id" = ${id}`);
}

let app: Express;

beforeAll(async () => {
  app = await createTestApp();
}, 120000);

afterAll(async () => {
  await closeTestResources();
});

describe("SyncJobManager (durable, PG-backed)", () => {
  beforeEach(async () => {
    await db.delete(syncJobs);
  });

  it("creates a job and transitions it queued -> running -> success", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 42);
    expect(id).toMatch(/^sync_42_\d+_[a-z0-9]+$/);

    let job = (await syncJobManager.getJob(id))!;
    expect(job.status).toBe("queued");
    expect(job.kind).toBe("show-sync");
    expect(job.showId).toBe(42);
    expect(job.userId).toBe(USER_A);

    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);
    await reporter.setPhase("process-episodes", "Processing");
    await reporter.setTotal(10);
    await reporter.incrementCompleted("show one");
    await reporter.incrementCompleted("show two");
    await syncJobManager.flushProgress(id);

    job = (await syncJobManager.getJob(id))!;
    expect(job.status).toBe("running");
    expect(job.phase).toBe("process-episodes");
    expect(job.totalShows).toBe(10);
    expect(job.completedShows).toBe(2);
    expect(job.percent).toBe(20);
    expect(job.lastMessage).toBe("show two");

    await syncJobManager.markJobSuccess(id, 25, 3);
    job = (await syncJobManager.getJob(id))!;
    expect(job.status).toBe("success");
    expect(job.episodesImported).toBe(25);
    expect(job.episodesUpdated).toBe(3);
    expect(job.percent).toBe(100);
    expect(job.finishedAt).not.toBeNull();
  });

  it("records errors and terminal error state", async () => {
    const id = await syncJobManager.createJob(USER_A, "library-import");
    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);
    await reporter.addError("boom");
    await syncJobManager.markJobError(id, "fatal boom");

    const job = (await syncJobManager.getJob(id))!;
    expect(job.status).toBe("error");
    expect(job.errors).toEqual(["boom"]);
    expect(job.lastMessage).toBe("Sync failed: fatal boom");
    expect(job.finishedAt).not.toBeNull();
  });

  it("two manager instances (two replicas) see the same job state", async () => {
    const replicaA = syncJobManager;
    const replicaB = new SyncJobManager();

    const id = await replicaA.createJob(USER_A, "episode-import");
    await replicaA.markJobRunning(id);

    // Progress written through replica A is visible from replica B.
    const reporterA = replicaA.createReporter(id);
    await reporterA.setTotal(4);
    await reporterA.incrementCompleted();
    await replicaA.flushProgress(id);

    const fromB = (await replicaB.getJob(id))!;
    expect(fromB.status).toBe("running");
    expect(fromB.totalShows).toBe(4);
    expect(fromB.completedShows).toBe(1);

    // Terminal state written by B is visible from A.
    await replicaB.markJobSuccess(id, 7, 0);
    const fromA = (await replicaA.getJob(id))!;
    expect(fromA.status).toBe("success");
    expect(fromA.episodesImported).toBe(7);
  });

  it("a running job with a stale heartbeat reads as worker-lost without mutating the row", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 7);
    await syncJobManager.markJobRunning(id);
    await backdateHeartbeat(id, 10);

    const job = (await syncJobManager.getJob(id))!;
    expect(job.status).toBe("error");
    expect(job.lastMessage).toBe(SYNC_WORKER_LOST_MESSAGE);

    // The row itself is untouched: readers compute the timeout, never write it.
    const row = (await rawRow(id))!;
    expect(row.status).toBe("running");

    // Dead workers are not "active".
    expect(await syncJobManager.getActiveJobs(USER_A)).toEqual([]);
  });

  it("a cancel from another replica is honored by checkCanceled", async () => {
    const replicaB = new SyncJobManager();
    const id = await syncJobManager.createJob(USER_A, "show-sync", 9);
    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);

    expect(await reporter.checkCanceled()).toBe(false);
    expect(await replicaB.cancelJob(id)).toBe(true);
    expect(await reporter.checkCanceled()).toBe(true);

    const job = (await syncJobManager.getJob(id))!;
    expect(job.status).toBe("canceled");

    // Canceling a non-running job is a no-op.
    expect(await replicaB.cancelJob(id)).toBe(false);
  });

  it("jobs are scoped to their user", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 11);
    expect(await syncJobManager.getJob(id, USER_B)).toBeNull();
    expect(await syncJobManager.getLatestJob(USER_B)).toBeNull();
    expect((await syncJobManager.getJob(id, USER_A))!.id).toBe(id);
  });

  it("getActiveJobs returns running jobs for the user", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 12);
    await syncJobManager.markJobRunning(id);
    const other = await syncJobManager.createJob(USER_B, "show-sync", 13);
    await syncJobManager.markJobRunning(other);

    const active = await syncJobManager.getActiveJobs(USER_A);
    expect(active.map((j) => j.id)).toEqual([id]);
  });

  it("a terminal update does not overwrite a cancellation that won the race", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 31);
    await syncJobManager.markJobRunning(id);

    // The worker's final checkCanceled() passed, then the user canceled.
    expect(await syncJobManager.cancelJob(id)).toBe(true);

    // The worker's terminal write must not resurrect the job.
    expect(await syncJobManager.markJobSuccess(id, 5, 1)).toBe(false);
    const job = (await syncJobManager.getJob(id))!;
    expect(job.status).toBe("canceled");
    expect(job.lastMessage).toBe("Sync canceled by user");
    expect(job.episodesImported).toBe(0);
  });

  it("markJobError is likewise conditional on the job still being active", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 32);
    await syncJobManager.markJobRunning(id);
    await syncJobManager.cancelJob(id);

    expect(await syncJobManager.markJobError(id, "late failure")).toBe(false);
    expect((await syncJobManager.getJob(id))!.status).toBe("canceled");
  });

  it("terminal transitions still apply to queued and running jobs", async () => {
    const queued = await syncJobManager.createJob(USER_A, "show-sync", 33);
    expect(await syncJobManager.markJobSuccess(queued, 1, 0)).toBe(true);

    const running = await syncJobManager.createJob(USER_A, "show-sync", 34);
    await syncJobManager.markJobRunning(running);
    expect(await syncJobManager.markJobError(running, "boom")).toBe(true);
    expect((await syncJobManager.getJob(running))!.status).toBe("error");
  });

  it("a terminal transition awaits an in-flight progress write", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 35);
    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);
    await reporter.setTotal(10);

    // Fire-and-forget: the throttled flush starts its DB write in the
    // background (first tick always flushes immediately).
    void reporter.incrementCompleted("show one");

    // Must not run concurrently with the older write: without the await,
    // the progress write could land after this and clobber percent: 100.
    await syncJobManager.markJobSuccess(id, 1, 0);

    const row = (await rawRow(id))!;
    expect(row.status).toBe("success");
    expect(row.percent).toBe(100);
    expect(row.completedShows).toBe(1);
    expect(row.lastMessage).toBe(
      "Sync completed successfully. 1 episodes imported, 0 updated."
    );
  });

  it("progress writes after a cancel are dropped, never clobbering the terminal row", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 37);
    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);
    await reporter.setTotal(10);
    await reporter.incrementCompleted("show one");

    // The user cancels; the worker hasn't observed it yet and keeps
    // writing progress, phase messages, and errors.
    expect(await syncJobManager.cancelJob(id)).toBe(true);

    await reporter.incrementCompleted("show two");
    await syncJobManager.flushProgress(id);
    await reporter.setPhase("process-episodes", "late phase message");
    await reporter.addError("late error");

    // The row stays canceled with the cancel message: no progress field,
    // no phase message, and no late error touched it.
    const row = (await rawRow(id))!;
    expect(row.status).toBe("canceled");
    expect(row.lastMessage).toBe("Sync canceled by user");
    expect(row.completedShows).toBe(1);
    expect(row.percent).toBe(10);
    expect(row.phase).toBe("fetch-show");
    expect(row.errors).toEqual([]);
  });

  it("concurrent addError calls do not lose errors", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 36);
    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);

    // Route call sites invoke addError without awaiting it; a
    // read-modify-write here would let all three read the same array and
    // keep only the last write.
    await Promise.all([
      reporter.addError("e1"),
      reporter.addError("e2"),
      reporter.addError("e3"),
    ]);

    const row = (await rawRow(id))!;
    expect(row.errors).toHaveLength(3);
    expect(row.errors).toEqual(expect.arrayContaining(["e1", "e2", "e3"]));
  });

  it("cleanup terminates heartbeat-dead running jobs and reaps old terminal jobs", async () => {
    // Dead worker: heartbeat stale beyond retention -> terminated as error,
    // but not deleted on the same pass (its updatedAt is now fresh).
    const dead = await syncJobManager.createJob(USER_A, "show-sync", 37);
    await syncJobManager.markJobRunning(dead);
    await backdateHeartbeat(dead, 25 * 60);

    // Old terminal job -> reaped.
    const old = await syncJobManager.createJob(USER_A, "show-sync", 38);
    await syncJobManager.markJobRunning(old);
    await syncJobManager.markJobSuccess(old, 1, 0);
    await db.execute(
      sql`UPDATE "sync_jobs" SET "updated_at" = now() - interval '25 hours' WHERE "id" = ${old}`
    );

    // Fresh running job -> untouched.
    const fresh = await syncJobManager.createJob(USER_A, "show-sync", 39);
    await syncJobManager.markJobRunning(fresh);

    await cleanupSyncJobs();

    const deadRow = (await rawRow(dead))!;
    expect(deadRow.status).toBe("error");
    expect(deadRow.lastMessage).toBe(SYNC_WORKER_LOST_MESSAGE);
    expect(deadRow.finishedAt).not.toBeNull();

    expect(await rawRow(old)).toBeNull();
    expect((await rawRow(fresh))!.status).toBe("running");
  });
});

describe("episode import cancel route scoping", () => {
  beforeEach(async () => {
    await db.delete(syncJobs);
  });

  it("user B cannot cancel user A's job; the owner can", async () => {
    const id = await syncJobManager.createJob(USER_A, "episode-import");
    await syncJobManager.markJobRunning(id);

    const cookieB = await createSessionCookie(USER_B);
    const denied = await request(app)
      .post(`/api/episodes/import/cancel/${id}`)
      .set("Cookie", cookieB);
    expect(denied.status).toBe(404);
    expect((await syncJobManager.getJob(id, USER_A))!.status).toBe("running");

    const cookieA = await createSessionCookie(USER_A);
    const allowed = await request(app)
      .post(`/api/episodes/import/cancel/${id}`)
      .set("Cookie", cookieA);
    expect(allowed.status).toBe(200);
    expect((await syncJobManager.getJob(id, USER_A))!.status).toBe("canceled");
  });
});

describe("sync_status MCP tool", () => {
  beforeEach(async () => {
    await db.delete(syncJobs);
  });

  it("returns the user's most recent job when job_id is omitted", async () => {
    const first = await syncJobManager.createJob(testAuth.userId, "library-import");
    await syncJobManager.markJobRunning(first);
    // Ensure distinct started_at ordering.
    await new Promise((r) => setTimeout(r, 10));
    const second = await syncJobManager.createJob(testAuth.userId, "show-sync", 21);

    const { isError, body } = await callTool(syncServer(), "sync_status", {});
    expect(isError).toBe(false);
    expect(body.job.id).toBe(second);
    expect(body.job.kind).toBe("show-sync");
    expect(body.job.status).toBe("queued");
    expect(body.job.show_id).toBe(21);
  });

  it("reflects the heartbeat timeout in its status", async () => {
    const id = await syncJobManager.createJob(testAuth.userId, "episode-import");
    await syncJobManager.markJobRunning(id);
    await backdateHeartbeat(id, 10);

    const { isError, body } = await callTool(syncServer(), "sync_status", {
      job_id: id,
    });
    expect(isError).toBe(false);
    expect(body.job.status).toBe("error");
    expect(body.job.last_message).toBe(SYNC_WORKER_LOST_MESSAGE);
  });

  it("errors on unknown job ids and jobs owned by another user", async () => {
    const other = await syncJobManager.createJob("someone-else", "show-sync", 22);

    const unknown = await callTool(syncServer(), "sync_status", {
      job_id: "sync_nope_123",
    });
    expect(unknown.isError).toBe(true);

    const foreign = await callTool(syncServer(), "sync_status", { job_id: other });
    expect(foreign.isError).toBe(true);

    const empty = await callTool(syncServer(), "sync_status", {});
    expect(empty.isError).toBe(true);
  });

  it("is read-only: calling it never mutates the job row", async () => {
    const id = await syncJobManager.createJob(testAuth.userId, "show-sync", 23);
    await syncJobManager.markJobRunning(id);
    const before = await rawRow(id);

    await callTool(syncServer(), "sync_status", { job_id: id });
    await callTool(syncServer(), "sync_status", {});

    const after = await rawRow(id);
    expect(after).toEqual(before);
  });
});
