import type { Express } from "express";
import request from "supertest";
import { randomBytes } from "crypto";
import cookieSignature from "cookie-signature";
import type { PgBridge } from "./ws-pg-bridge";
import type { OidcDiscoveryStub } from "./oidc-discovery-stub";

// The app import chain (storage -> db.ts) throws without DATABASE_URL at load
// time. CI sets it to the scratch postgres service; local runs fall back to
// the same default the workflow uses.
process.env.DATABASE_URL ??= "postgresql://postgres:postgres@localhost:5432/postgres";

// SESSION_SECRET and REPL_ID are read inside createApp() (session signing and
// OIDC discovery), not at import time, so they are set in createTestApp().
// REPL_ID in particular must not be set at import time: vite.config.ts
// top-level-imports the Replit cartographer plugin whenever REPL_ID is set.

const { createApp } = await import("../app");
const { storage } = await import("../storage");
const { db, pool } = await import("../db");
const { sql } = await import("drizzle-orm");
const { neonConfig } = await import("@neondatabase/serverless");
const { startPgBridge } = await import("./ws-pg-bridge");
const { startOidcDiscoveryStub } = await import("./oidc-discovery-stub");

export const TEST_USER_ID = "integration-test-user";
export const TEST_SHOW_ID = 999001;

const SESSION_SECRET = "integration-test-session-secret";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let bridge: PgBridge | null = null;
let oidcStub: OidcDiscoveryStub | null = null;

/** Issuer URL of the local OIDC discovery stub (set by createTestApp). */
export function testOidcIssuer(): string {
  if (!oidcStub) throw new Error("OIDC discovery stub is not running");
  return oidcStub.url;
}

/**
 * Assemble the REAL app (server/app.ts) against the scratch database: real
 * Express wiring, real passport + session store, real isAuthenticated, real
 * routes, real storage, real database. Also creates the connect-pg-simple
 * sessions table, which is not part of the drizzle schema.
 *
 * The app hardcodes the Neon WebSocket-only driver, so when DATABASE_URL
 * points at a local postgres the driver is bridged to it with a transparent
 * byte-pipe (see ws-pg-bridge.ts). Against a real Neon host the driver is
 * used as-is.
 */
export async function createTestApp(): Promise<Express> {
  process.env.SESSION_SECRET ??= SESSION_SECRET;
  process.env.REPL_ID ??= "integration-test-repl-id";

  // Start the local OIDC discovery stub BEFORE createApp(): setupAuth()
  // awaits client.discovery() against ISSUER_URL, and the suite must not
  // depend on the live replit.com provider. The stub serves HTTPS with a
  // test-only self-signed certificate, so TLS verification is disabled for
  // the test process. Everything else stays real: the real pg session
  // store, real Passport strategy construction, real isAuthenticated.
  oidcStub = await startOidcDiscoveryStub();
  process.env.ISSUER_URL = oidcStub.url;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const dbUrl = new URL(process.env.DATABASE_URL!);
  if (dbUrl.hostname === "localhost" || dbUrl.hostname === "127.0.0.1") {
    bridge = await startPgBridge(dbUrl.hostname, parseInt(dbUrl.port || "5432", 10));
    neonConfig.wsProxy = bridge.wsProxyTarget;
    neonConfig.useSecureWebSocket = false;
    // The driver defaults to pipelining a cleartext password immediately
    // (an optimization for Neon's proxy). A real postgres requests SASL,
    // so use the normal auth handshake here instead.
    neonConfig.pipelineConnect = false;
  }

  const { app } = await createApp();
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "sessions" (
      "sid" varchar NOT NULL,
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "sessions_pkey" PRIMARY KEY ("sid")
    )`);
  return app;
}

/**
 * Establish a real login session for userId in the real session store and
 * return a Cookie header value carrying the signed session id — the same
 * cookie a browser would send after completing the OIDC flow. The only
 * faked part is the OIDC provider itself: CI has no interactive login, so
 * the passport session is written directly instead of via /api/callback.
 * Unauthenticated tests simply omit the cookie and expect 401s.
 */
export async function createSessionCookie(userId: string): Promise<string> {
  const sid = randomBytes(32).toString("hex");
  const sess = {
    cookie: {
      originalMaxAge: SESSION_TTL_MS,
      expires: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      httpOnly: true,
      path: "/",
      secure: true,
    },
    passport: {
      user: {
        claims: { sub: userId },
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      },
    },
  };
  await db.execute(sql`
    INSERT INTO "sessions" (sid, sess, expire)
    VALUES (${sid}, ${JSON.stringify(sess)}::json, ${new Date(Date.now() + SESSION_TTL_MS)})`);
  const signed = `s:${cookieSignature.sign(sid, process.env.SESSION_SECRET!)}`;
  return `connect.sid=${encodeURIComponent(signed)}`;
}

/** Seed one show plus the test user's library row via the real storage. */
export async function seedLibrary(): Promise<void> {
  await storage.createShow({ id: TEST_SHOW_ID, name: "Integration Test Show" });
  await storage.addUserShow({ userId: TEST_USER_ID, showId: TEST_SHOW_ID });
}

/** Release test resources (stub, bridge, drizzle pool) so the process can exit. */
export async function closeTestResources(): Promise<void> {
  await pool.end();
  if (oidcStub) {
    await oidcStub.close();
    oidcStub = null;
  }
  if (bridge) {
    await bridge.close();
    bridge = null;
  }
}

export { request };
