import express, { type Express, type Request, type Response, type NextFunction } from "express";
import type { Server } from "http";
import { registerRoutes } from "./routes";
import { log } from "./vite";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { registerOAuthRoutes } from "./oauth";
import { registerMcpRoutes } from "./mcp";

/**
 * Assemble the Express app exactly as server/index.ts does, minus the parts
 * that must only run in a real server process (vite/static serving, the
 * TVMaze seed, schedulers, listen). Tests import this instead of index.ts:
 * index.ts listens on PORT at import time, so it can never be imported by
 * tests. Registration order is load-bearing (see the /api gate comment) and
 * must stay identical to the production assembly.
 */
export async function createApp(): Promise<{ app: Express; server: Server }> {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, any> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      const duration = Date.now() - start;
      if (path.startsWith("/api")) {
        let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
        if (capturedJsonResponse) {
          logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
        }

        if (logLine.length > 80) {
          logLine = logLine.slice(0, 79) + "…";
        }

        log(logLine);
      }
    });

    next();
  });

  // Setup auth BEFORE registering routes
  await setupAuth(app);
  registerAuthRoutes(app);
  registerOAuthRoutes(app);
  registerMcpRoutes(app);

  // Gate every /api route registered after this point. Express evaluates
  // middleware in registration order, so /api/login, /api/callback and
  // /api/logout (registered earlier by setupAuth) stay public while every
  // UI route registered below by registerRoutes requires authentication.
  // /oauth/* and /mcp live outside /api/* and are unaffected.
  app.use("/api", isAuthenticated);

  const server = await registerRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  return { app, server };
}
