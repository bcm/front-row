import type { Express } from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_SHOW_ID,
  TEST_USER_ID,
  closeTestResources,
  createSessionCookie,
  createTestApp,
  request,
  seedLibrary,
  testOidcIssuer,
} from "./test/integration-harness";

// Integration suite: runs against a real scratch postgres (see
// .github/workflows/ci.yml). Not part of `npm test`; run with
// `npm run test:integration`.
//
// This exercises the REAL server assembly (server/app.ts): real Express
// wiring, real passport + session store, real isAuthenticated, real routes,
// real storage, real database. The only faked parts are the OIDC provider
// itself — sessions are established directly since CI has no interactive
// login — and OIDC discovery, which is served by a local stub
// (server/test/oidc-discovery-stub.ts) so the suite never depends on the
// live replit.com provider. If the app.use("/api", isAuthenticated) line is
// removed from server/app.ts, the 401 tests below fail: that revert-proof
// was verified.
//
// Explicitly out of scope here: 403 scope checks (arrive with #11's write
// tools), 405 handling (not Express-default behavior), and tripping the
// TVMaze rate limiter (requires 60+ upstream calls; not CI-appropriate).
describe("/api auth gating (integration)", () => {
  let app: Express;
  let authCookie: string;

  beforeAll(async () => {
    app = await createTestApp();
    await seedLibrary();
    authCookie = await createSessionCookie(TEST_USER_ID);
  }, 120000);

  afterAll(async () => {
    await closeTestResources();
  });

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
      .set("Cookie", authCookie);
    expect(res.status).toBe(404);
    // Distinguishes the explicit /api catch-all in server/app.ts from
    // Express's default HTML 404.
    expect(res.body).toEqual({ message: "Not Found" });
  });

  it("keeps /api/login public (redirects to OIDC, not 401)", async () => {
    const res = await request(app).get("/api/login");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain(testOidcIssuer());
  });

  it("serves the seeded library to an authenticated user", async () => {
    const res = await request(app)
      .get("/api/library")
      .set("Cookie", authCookie);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const names = res.body.map((row: any) => row.show?.name ?? row.name);
    expect(names).toContain("Integration Test Show");
  });
});
