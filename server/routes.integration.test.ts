import type { Express } from "express";
import { beforeAll, describe, expect, it } from "vitest";
import {
  TEST_SHOW_ID,
  buildTestApp,
  request,
  seedLibrary,
} from "./test/integration-harness";

// Integration suite: runs against a real scratch postgres (see
// .github/workflows/ci.yml). Not part of `npm test`; run with
// `npm run test:integration`.
//
// Explicitly out of scope here: 403 scope checks (arrive with #11's write
// tools), 405 handling (not Express-default behavior), and tripping the
// TVMaze rate limiter (requires 60+ upstream calls; not CI-appropriate).
describe("/api auth gating (integration)", () => {
  let app: Express;

  beforeAll(async () => {
    app = await buildTestApp();
    await seedLibrary();
  }, 60000);

  it("rejects unauthenticated GET /api/library with 401", async () => {
    const res = await request(app).get("/api/library");
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated POST /api/recommendations/dismiss with 401", async () => {
    const res = await request(app)
      .post("/api/recommendations/dismiss")
      .send({ tmdbId: 123 });
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated DELETE /api/user/shows/:id with 401", async () => {
    const res = await request(app).delete(`/api/user/shows/${TEST_SHOW_ID}`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown /api route", async () => {
    const res = await request(app)
      .get("/api/does-not-exist")
      .set("x-test-auth", "yes");
    expect(res.status).toBe(404);
  });

  it("keeps /api/login public", async () => {
    const res = await request(app).get("/api/login");
    expect(res.status).toBe(200);
  });

  it("serves the seeded library to an authenticated user", async () => {
    const res = await request(app)
      .get("/api/library")
      .set("x-test-auth", "yes");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map((row: any) => row.show?.name ?? row.name);
    expect(names).toContain("Integration Test Show");
  });
});
