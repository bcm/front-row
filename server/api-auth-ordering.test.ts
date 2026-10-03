import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The auth module's import chain requires DATABASE_URL at load time. The
// value is never used here: isAuthenticated answers 401 before touching any
// storage, and the authenticated case below carries a non-expired token so
// the refresh path is never reached.
process.env.DATABASE_URL ??= "postgres://localhost:5432/front-row-test";

const { isAuthenticated } = await import("./replit_integrations/auth/replitAuth");

// Mirrors the registration order in server/index.ts: public auth routes are
// registered first, then app.use("/api", isAuthenticated), then the UI
// routes. Bare express has no passport, so the test defines
// req.isAuthenticated itself, the way passport.session() would.
describe("/api auth gating order", () => {
  let base: string;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const app = express();

    app.use((req: any, _res, next) => {
      if (req.headers["x-test-auth"] === "yes") {
        req.isAuthenticated = () => true;
        req.user = {
          claims: { sub: "user-123" },
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        };
      } else {
        req.isAuthenticated = () => false;
      }
      next();
    });

    app.get("/api/login", (_req, res) => res.send("login"));
    app.use("/api", isAuthenticated);
    app.get("/api/library", (_req, res) => res.json({ ok: true }));

    await new Promise<void>((resolve) => {
      const server = app.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        base = `http://127.0.0.1:${port}`;
        close = () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          );
        resolve();
      });
    });
  });

  afterAll(async () => {
    await close();
  });

  it("leaves routes registered before the gate public", async () => {
    const res = await fetch(`${base}/api/login`);
    expect(res.status).toBe(200);
  });

  it("rejects unauthenticated requests to routes registered after the gate", async () => {
    const res = await fetch(`${base}/api/library`);
    expect(res.status).toBe(401);
  });

  it("lets authenticated requests through the gate", async () => {
    const res = await fetch(`${base}/api/library`, {
      headers: { "x-test-auth": "yes" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
