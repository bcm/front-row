import express, { type Express } from "express";
import request from "supertest";

// The routes import chain (storage -> db.ts) throws without DATABASE_URL at
// load time. CI sets it to the scratch postgres service; local runs fall back
// to the same default the workflow uses.
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";

const { isAuthenticated } = await import("../replit_integrations/auth/replitAuth");
const { registerRoutes } = await import("../routes");
const { storage } = await import("../storage");

export const TEST_USER_ID = "integration-test-user";
export const TEST_SHOW_ID = 999001;

/**
 * Build an Express app mirroring server/index.ts's middleware ordering:
 * public auth routes first, then the /api auth gate, then the UI routes.
 * Bare express has no passport, so the stub defines req.isAuthenticated the
 * way passport.session() would, keyed off the x-test-auth header.
 */
export async function buildTestApp(): Promise<Express> {
  const app = express();
  app.use(express.json());

  app.use((req: any, _res, next) => {
    if (req.headers["x-test-auth"] === "yes") {
      req.isAuthenticated = () => true;
      req.user = {
        claims: { sub: TEST_USER_ID },
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
    } else {
      req.isAuthenticated = () => false;
    }
    next();
  });

  // Public auth surface, mirroring setupAuth's registrations.
  app.get("/api/login", (_req, res) => res.send("login"));
  app.get("/api/callback", (_req, res) => res.send("callback"));
  app.get("/api/logout", (_req, res) => res.send("logout"));

  app.use("/api", isAuthenticated);
  await registerRoutes(app);
  return app;
}

/** Seed one show plus the test user's library row via the real storage. */
export async function seedLibrary(): Promise<void> {
  await storage.createShow({ id: TEST_SHOW_ID, name: "Integration Test Show" });
  await storage.addUserShow({ userId: TEST_USER_ID, showId: TEST_SHOW_ID });
}

export { request };
