// Integration suite for durable sync job state (issue #6): the PG-backed
// SyncJobManager and the re-added sync_status MCP tool, against a real
// scratch postgres (CI provisions it; see .github/workflows/ci.yml).
//
// Not part of `npm test`; run with `npm run test:integration`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  closeTestResources,
  createTestApp,
} from "./test/integration-harness";

// The harness sets DATABASE_URL before these imports resolve server/db.
import { db } from "./db";
import { syncJobs } from "@shared/schema";
import {
  syncJobManager,
  SyncJobManager,
  SYNC_WORKER_LOST_MESSAGE,
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

beforeAll(async () => {
  await createTestApp();
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
