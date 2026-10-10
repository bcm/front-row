import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticRef, providerDiagnosticRefs } from "./auth-diagnostic-metadata";

const mocks = vi.hoisted(() => ({
  verify: undefined as undefined | ((tokens: any, done: (error: any, user: any) => void) => Promise<void>),
  tokens: {} as any,
  failCallback: false,
  saveFails: false,
  completion: undefined as undefined | Promise<void>,
  config: {
    serverMetadata: () => ({
      issuer: "https://private-provider.test", token_endpoint: "https://private-provider.test/token",
    }),
    clientMetadata: () => ({ client_id: "private-client", client_secret: "private-secret" }),
  },
  upsert: vi.fn(async () => {}),
}));
vi.mock("./storage", () => ({ authStorage: { upsertUser: mocks.upsert } }));
vi.mock("openid-client", () => ({ discovery: vi.fn(async () => mocks.config) }));
vi.mock("openid-client/passport", () => ({
  Strategy: class {
    constructor(_options: unknown, verify: typeof mocks.verify) { mocks.verify = verify; }
  },
}));
vi.mock("express-session", () => ({ default: vi.fn(() => () => {}) }));
vi.mock("connect-pg-simple", () => ({ default: () => class {} }));
vi.mock("passport", () => ({
  default: {
    initialize: () => () => {}, session: () => () => {}, use: vi.fn(),
    serializeUser: vi.fn(), deserializeUser: vi.fn(),
    authenticate: vi.fn(() => (req: any, res: any) => {
      mocks.completion = (async () => {
        if (mocks.failCallback) { res.emit("finish"); return; }
        await mocks.verify!(mocks.tokens, (error, user) => {
          if (error) throw error;
          req.user = user;
          // Mimic Passport's successful-login session regeneration.
          req.sessionID = "private-final-session-id";
        });
        if (mocks.saveFails) res.statusCode = 500;
        res.emit("finish");
      })();
    }),
  },
}));
import { setupAuth } from "./replitAuth";

describe("successful callback diagnostic observer", () => {
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "private-signing-key");
    log = vi.spyOn(console, "info").mockImplementation(() => {});
    mocks.failCallback = false;
    mocks.saveFails = false;
    mocks.completion = undefined;
    mocks.tokens = {
      claims: () => ({
        sub: "private-user", email: "private@example.test", iat: 100, exp: 200,
      }),
      access_token: "private-access-token", refresh_token: "private-refresh-token",
      id_token: "private-id-token", expires_in: 3600, refresh_expires_in: 7200,
      scope: "openid email profile offline_access private-scope",
    };
    mocks.upsert.mockClear();
  });
  afterEach(() => { log.mockRestore(); vi.unstubAllEnvs(); });

  async function runCallback() {
    const routes = new Map<string, (...args: any[]) => any>();
    const app = { set: vi.fn(), use: vi.fn(), get: (path: string, handler: any) => routes.set(path, handler) };
    await setupAuth(app as any);
    const req = { hostname: "private-host.test", sessionID: "private-pre-login-session-id" } as any;
    req.isAuthenticated = () => !!req.user;
    const res = Object.assign(new EventEmitter(), { statusCode: 302 });
    await routes.get("/api/callback")!(req, res, vi.fn());
    await mocks.completion;
    return req;
  }

  it("uses the final session label and correctly updated access-token lifetime", async () => {
    const now = Math.floor(Date.now() / 1000);
    const req = await runCallback();
    expect(req.user).toEqual({
      claims: mocks.tokens.claims(), access_token: mocks.tokens.access_token,
      refresh_token: mocks.tokens.refresh_token, expires_at: expect.any(Number),
      access_token_received_at: expect.any(Number),
    });
    expect(req.user.expires_at).toBe(req.user.access_token_received_at + 3600);
    expect(req.user.access_token_received_at).toBeGreaterThanOrEqual(now);
    expect(mocks.upsert).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    const record = JSON.parse(line.slice("[auth] refresh_trace ".length));
    expect(record).toMatchObject({
      event: "login_succeeded",
      session_ref: diagnosticRef("session", "private-final-session-id"),
      ...providerDiagnosticRefs(mocks.config),
      refresh_token_returned: true, access_token_lifetime_seconds: 3600,
      refresh_expires_in_seconds: 7200, refresh_token_expires_in_seconds: null,
      scope_returned: true, offline_access_returned: true, offline_access_requested: true,
    });
    expect(record.session_ref).not.toBe(diagnosticRef("session", "private-pre-login-session-id"));
    expect(line).not.toContain("private");
  });

  it("does not emit a successful-login record for a failed callback", async () => {
    mocks.failCallback = true;
    const req = await runCallback();
    expect(req.user).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("does not label a callback session-save error as a successful login", async () => {
    mocks.saveFails = true;
    await runCallback();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not let a diagnostic log failure interrupt successful authentication", async () => {
    log.mockImplementationOnce(() => { throw new Error("private-log-error"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const req = await runCallback();
      expect(req.user.claims.sub).toBe("private-user");
      expect(warn).toHaveBeenCalledWith("[auth] refresh_trace unavailable");
    } finally { warn.mockRestore(); }
  });
});
