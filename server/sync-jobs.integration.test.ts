// Integration suite for durable sync job state (issue #6): the PG-backed
// SyncJobManager and the re-added sync_status MCP tool, against a real
// scratch postgres (CI provisions it; see .github/workflows/ci.yml).
//
// Not part of `npm test`; run with `npm run test:integration`.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { Express } from "express";
import {
  closeTestResources,
  createSessionCookie,
  createTestApp,
  request,
} from "./test/integration-harness";

// The harness sets DATABASE_URL before these imports resolve server/db.
import { db } from "./db";
import { syncJobs, userShows } from "@shared/schema";
import { storage } from "./storage";
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

  it("an addError chained mid-drain is not dropped by the terminal transition", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 7);
    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);
    await reporter.setTotal(10);

    // Adversarial interleaving, issued synchronously so no await can
    // interleave between the calls:
    //   1. an unawaited addError starts a tracked write,
    //   2. the terminal transition begins draining it,
    //   3. throttled progress is queued, so the transition's flush has a
    //      progress write to install after the drain,
    //   4. a second addError chains onto the first write while the drain
    //      await is pending.
    // The drain must re-check the map and await the chained write before
    // installing the progress write — otherwise the terminal UPDATE could
    // commit while the second error is still running, and the active-row
    // guard would silently drop it.
    const first = reporter.addError("first");
    const terminal = syncJobManager.markJobSuccess(id, 1, 0);
    const tick = reporter.incrementCompleted("tick");
    const second = reporter.addError("second");
    await Promise.all([first, terminal, tick, second]);

    const job = (await syncJobManager.getJob(id))!;
    expect(job.status).toBe("success");
    expect(job.errors).toEqual(["first", "second"]);
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

  it("an unawaited addError lands before an immediate terminal transition", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 40);
    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);

    // Slow addError's UPDATE down: without in-flight tracking, the terminal
    // UPDATE below commits first and the active-row guard turns the delayed
    // append into a silent no-op, losing the error. The delay is timer-based
    // (not gated on the terminal transition) so the fixed code — which
    // drains in-flight writes before committing — cannot deadlock on it.
    const ADD_ERROR_DELAY_MS = 150;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms));
    const originalUpdate = db.update.bind(db);
    const updateSpy = vi
      .spyOn(db, "update")
      .mockImplementation(((table: any) => {
        const builder: any = originalUpdate(table);
        const originalSet = builder.set.bind(builder);
        builder.set = (values: any) => {
          const chained: any = originalSet(values);
          if (values && typeof values === "object" && "errors" in values) {
            // addError's chain is update -> set -> where -> then; delay the
            // final thenable so the UPDATE stays in flight.
            return {
              where: (cond: any) => ({
                then: (onFulfilled?: any, onRejected?: any) =>
                  sleep(ADD_ERROR_DELAY_MS).then(() =>
                    (chained.where(cond) as PromiseLike<unknown>).then(
                      onFulfilled,
                      onRejected
                    )
                  ),
              }),
            };
          }
          return chained;
        };
        return builder;
      }) as any);

    try {
      // Route call sites fire addError without awaiting it.
      void reporter.addError("boom");
      await syncJobManager.markJobError(id, "fatal boom");
    } finally {
      updateSpy.mockRestore();
    }

    const row = (await rawRow(id))!;
    expect(row.status).toBe("error");
    expect(row.errors).toEqual(["boom"]);
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

  it("an awaiting addError caller sees a write failure as a rejection", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 40);
    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);

    // Fail addError's UPDATE: without propagating the rejection, the
    // awaiting caller would believe the error was durable even though it
    // was lost.
    const WRITE_ERROR = new Error("addError write boom");
    const originalUpdate = db.update.bind(db);
    const updateSpy = vi
      .spyOn(db, "update")
      .mockImplementation(((table: any) => {
        const builder: any = originalUpdate(table);
        const originalSet = builder.set.bind(builder);
        builder.set = (values: any) => {
          const chained: any = originalSet(values);
          if (values && typeof values === "object" && "errors" in values) {
            // addError's chain is update -> set -> where -> then; reject
            // the final thenable so the tracked write fails.
            return {
              where: (cond: any) => ({
                then: (onFulfilled?: any, onRejected?: any) =>
                  onRejected
                    ? onRejected(WRITE_ERROR)
                    : Promise.reject(WRITE_ERROR),
              }),
            };
          }
          return chained;
        };
        return builder;
      }) as any);

    try {
      await expect(reporter.addError("boom")).rejects.toThrow(
        "addError write boom"
      );
    } finally {
      updateSpy.mockRestore();
    }

    // The failed write must not leave the job's write chain stuck: a
    // subsequent write still runs.
    await reporter.addError("after");
    const row = (await rawRow(id))!;
    expect(row.errors).toEqual(["after"]);
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

describe("sync route async error forwarding (integration)", () => {
  // Express 4 does not forward async handler rejections to error middleware;
  // the sync routes wrap their handlers in asyncHandler so a rejected DB call
  // becomes a 500 via next(error) instead of a hung request. These tests force
  // the rejection with a mocked manager method and assert the client sees the
  // 500 — before the fix, the request would hang until supertest timed out.
  it("returns 500 when the status lookup rejects (GET /api/sync/:id/status)", async () => {
    const cookie = await createSessionCookie(USER_A);
    const spy = vi
      .spyOn(syncJobManager, "getJob")
      .mockRejectedValue(new Error("db down"));
    try {
      const res = await request(app)
        .get("/api/sync/sync_1_2_3/status")
        .set("Cookie", cookie);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ message: "db down" });
    } finally {
      spy.mockRestore();
    }
  });

  it("returns 500 when the cancellation rejects (DELETE /api/sync/:id)", async () => {
    const cookie = await createSessionCookie(USER_A);
    const id = await syncJobManager.createJob(USER_A, "show-sync", 99);
    await syncJobManager.markJobRunning(id);
    const spy = vi
      .spyOn(syncJobManager, "cancelJob")
      .mockRejectedValue(new Error("cancel failed"));
    try {
      const res = await request(app)
        .delete(`/api/sync/${id}`)
        .set("Cookie", cookie);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ message: "cancel failed" });
    } finally {
      spy.mockRestore();
      await db.delete(syncJobs).where(eq(syncJobs.id, id));
    }
  });
});

describe("add-show 202 contract (integration)", () => {
  // The add-show dialog's mutationFn receives whatever mutationFn returns, so
  // the JSON body (including jobId) must be parsed before onSuccess runs —
  // apiRequest hands back the raw Response. This locks the server side of
  // that contract: 202 with a JSON body containing the durable job id, so the
  // client can start its progress poller. TVMaze is mocked so the test does
  // not depend on the network.
  it("POST /api/user/shows returns 202 JSON with jobId", async () => {
    const cookie = await createSessionCookie(USER_A);
    const spy = vi
      .spyOn(storage, "syncShowFromTVMaze")
      .mockResolvedValue({ id: 99999, name: "Mock Show" } as never);
    try {
      // A previous run may have left the library row behind; the route
      // 400s on duplicates, so start clean for isolation.
      await db
        .delete(userShows)
        .where(
          and(eq(userShows.userId, USER_A), eq(userShows.showId, 99999)),
        );
      const res = await request(app)
        .post("/api/user/shows")
        .set("Cookie", cookie)
        .send({ showId: 99999, status: "new" });
      expect(res.status).toBe(202);
      expect(typeof res.body.jobId).toBe("string");
      expect(res.body.jobId.length).toBeGreaterThan(0);
      expect(res.body.message).toEqual(expect.any(String));
    } finally {
      spy.mockRestore();
      await db.delete(syncJobs).where(eq(syncJobs.userId, USER_A));
      await db
        .delete(userShows)
        .where(
          and(eq(userShows.userId, USER_A), eq(userShows.showId, 99999)),
        );
    }
  });
});

describe("deferred sync-task rejection handling (integration)", () => {
  // The sync routes launch their background work via setImmediate and return
  // the HTTP response immediately. The background function's error path
  // performs rejecting DB writes (markJobError); if nobody observes the
  // launched promise, a DB outage turns that into an unhandled rejection
  // after the response has been returned. These tests force both the work
  // and the error path to fail, then assert the response still completes
  // and no unhandled rejection is emitted.
  it("observes the deferred task rejection (POST /api/shows/:id/sync/start)", async () => {
    const cookie = await createSessionCookie(USER_A);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    const runSpy = vi
      .spyOn(syncJobManager, "markJobRunning")
      .mockRejectedValue(new Error("db down"));
    const errSpy = vi
      .spyOn(syncJobManager, "markJobError")
      .mockRejectedValue(new Error("db still down"));
    try {
      const res = await request(app)
        .post("/api/shows/42/sync/start")
        .set("Cookie", cookie)
        .send({});
      // The response path is unaffected: 200 with the job id.
      expect(res.status).toBe(200);
      expect(typeof res.body.jobId).toBe("string");

      // Let the deferred task run and the rejection settle; a rejected
      // promise nobody observes would surface here as unhandledRejection.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      runSpy.mockRestore();
      errSpy.mockRestore();
      await db.delete(syncJobs).where(eq(syncJobs.userId, USER_A));
    }
  });
});

describe("Copilot round 8 findings (integration)", () => {
  beforeEach(async () => {
    await db.delete(syncJobs);
  });

  it("setPhase re-throws a failed UPDATE so the caller observes the lost write", async () => {
    // setPhase/setTotal are awaited to guarantee durable ordering. A failed
    // UPDATE used to be swallowed (converted to apparent success), letting
    // the worker continue and mark the job successful although the
    // phase/total write was lost.
    const id = await syncJobManager.createJob(USER_A, "show-sync", 42);
    await syncJobManager.markJobRunning(id);
    const reporter = syncJobManager.createReporter(id);
    const boom = new Error("update exploded");
    const spy = vi.spyOn(db, "update").mockImplementationOnce(() => {
      throw boom;
    });
    try {
      await expect(reporter.setPhase("fetch-show", "hi")).rejects.toBe(boom);
      await expect(reporter.setTotal(10)).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("a queued job older than the heartbeat timeout reads as worker-lost", async () => {
    // A replica can crash between createJob and the deferred markJobRunning,
    // leaving an orphan 'queued' row no worker will ever pick up. Readers
    // must not report it as queued forever.
    const id = await syncJobManager.createJob(USER_A, "show-sync", 43);
    expect((await syncJobManager.getJob(id))!.status).toBe("queued");

    await db.execute(sql`
      UPDATE "sync_jobs"
      SET "started_at" = now() - interval '6 minutes'
      WHERE "id" = ${id}`);

    const job = (await syncJobManager.getJob(id))!;
    expect(job.status).toBe("error");
    expect(job.lastMessage).toBe(SYNC_WORKER_LOST_MESSAGE);

    // The row itself is untouched — read-time interpretation only.
    expect((await rawRow(id))!.status).toBe("queued");

    // Stale queued jobs are not "active".
    expect(await syncJobManager.getActiveJobs(USER_A)).toEqual([]);
  });

  it("getActiveJobs includes fresh queued jobs", async () => {
    const id = await syncJobManager.createJob(USER_A, "episode-import");
    const active = await syncJobManager.getActiveJobs(USER_A);
    expect(active.map((j) => j.id)).toEqual([id]);
  });

  it("cleanupSyncJobs terminates stale queued rows", async () => {
    const id = await syncJobManager.createJob(USER_A, "show-sync", 44);
    await db.execute(sql`
      UPDATE "sync_jobs"
      SET "heartbeat_at" = now() - interval '25 hours'
      WHERE "id" = ${id}`);

    const fresh = await syncJobManager.createJob(USER_A, "show-sync", 45);

    await cleanupSyncJobs();

    const stale = (await rawRow(id))!;
    expect(stale.status).toBe("error");
    expect(stale.lastMessage).toBe(SYNC_WORKER_LOST_MESSAGE);
    // A fresh queued job is untouched.
    expect((await rawRow(fresh))!.status).toBe("queued");
  });

  it("clears per-job throttle state after a terminal transition", async () => {
    // A fresh manager isolates the throttle maps from background deferred
    // workers left over from API-level tests sharing the singleton.
    const manager = new SyncJobManager();
    const id = await manager.createJob(USER_A, "show-sync", 46);
    await manager.markJobRunning(id);
    const reporter = manager.createReporter(id);
    await reporter.incrementCompleted();
    // The throttled flush ran and retained its timestamp entry.
    expect(manager.throttleStateSize()).toBeGreaterThan(0);

    await manager.markJobSuccess(id, 0, 0);
    expect(manager.throttleStateSize()).toBe(0);
  });

  it("clears throttle state when a flush no-ops against a terminal row", async () => {
    // Cross-replica case: the job finished elsewhere, so this replica's
    // flush no-ops via the active-row guard. The per-job throttle entry
    // must not leak for the replica's lifetime.
    const manager = new SyncJobManager();
    const id = await manager.createJob(USER_A, "show-sync", 47);
    await manager.markJobRunning(id);
    await manager.markJobSuccess(id, 0, 0);
    expect(manager.throttleStateSize()).toBe(0);

    const reporter = manager.createReporter(id);
    await reporter.incrementCompleted();
    expect(manager.throttleStateSize()).toBe(0);
  });

  it("DELETE /api/sync/:id reports the cancel race honestly", async () => {
    const cookie = await createSessionCookie(USER_A);

    // Positive case: a running job cancels.
    const id = await syncJobManager.createJob(USER_A, "show-sync", 48);
    await syncJobManager.markJobRunning(id);
    const canceled = await request(app)
      .delete(`/api/sync/${id}`)
      .set("Cookie", cookie);
    expect(canceled.status).toBe(200);
    expect(canceled.body.canceled).toBe(true);

    // Race case: the job completed between the status read and the
    // cancellation UPDATE. The route must not claim the cancel landed.
    const raced = await syncJobManager.createJob(USER_A, "show-sync", 49);
    await syncJobManager.markJobRunning(raced);
    const cancelSpy = vi
      .spyOn(syncJobManager, "cancelJob")
      .mockResolvedValue(false);
    try {
      const res = await request(app)
        .delete(`/api/sync/${raced}`)
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body.canceled).toBe(false);
      expect(res.body.message).toMatch(/already completed/i);
    } finally {
      cancelSpy.mockRestore();
    }
  });
});
