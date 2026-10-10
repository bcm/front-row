import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";

import passport from "passport";
import session from "express-session";
import type { Express, Request, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { authStorage } from "./storage";
import { refreshFailureDiagnostics } from "./refresh-diagnostics";
import { createRefreshTrace, type RefreshPhase } from "./refresh-tracing";
import { loginTokenMetadata, type LoginTokenMetadata } from "./auth-diagnostic-metadata";
import { updateUserSession } from "./session-tokens";

export { updateUserSession } from "./session-tokens";

// Diagnostic metadata only; no tokens or credentials are retained here.
const pendingLoginMetadata = new WeakMap<object, LoginTokenMetadata>();

const getOidcConfig = memoize(
  async () => {
    return await client.discovery(
      new URL(process.env.ISSUER_URL ?? "https://replit.com/oidc"),
      process.env.REPL_ID!
    );
  },
  // promise: true drops rejected discoveries from the cache instead of
  // serving the failure for maxAge. A single failed discovery must not
  // poison every token refresh for the next hour.
  { maxAge: 3600 * 1000, promise: true }
);

export function getSession() {
  const sessionTtl = 7 * 24 * 60 * 60 * 1000; // 1 week
  const pgStore = connectPg(session);
  const sessionStore = new pgStore({
    conString: process.env.DATABASE_URL,
    createTableIfMissing: false,
    ttl: sessionTtl,
    tableName: "sessions",
  });
  return session({
    secret: process.env.SESSION_SECRET!,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      maxAge: sessionTtl,
    },
  });
}

async function upsertUser(claims: any) {
  await authStorage.upsertUser({
    id: claims["sub"],
    email: claims["email"],
    firstName: claims["first_name"],
    lastName: claims["last_name"],
    profileImageUrl: claims["profile_image_url"],
  });
}

export async function setupAuth(app: Express) {
  app.set("trust proxy", 1);
  app.use(getSession());
  app.use(passport.initialize());
  app.use(passport.session());

  const config = await getOidcConfig();

  const verify: VerifyFunction = async (
    tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers,
    verified: passport.AuthenticateCallback
  ) => {
    const user = {};
    updateUserSession(user, tokens);
    await upsertUser(tokens.claims());
    pendingLoginMetadata.set(user, loginTokenMetadata(tokens));
    verified(null, user);
  };

  // Keep track of registered strategies
  const registeredStrategies = new Set<string>();

  // Helper function to ensure strategy exists for a domain
  const ensureStrategy = (domain: string) => {
    const strategyName = `replitauth:${domain}`;
    if (!registeredStrategies.has(strategyName)) {
      const strategy = new Strategy(
        {
          name: strategyName,
          config,
          scope: "openid email profile offline_access",
          callbackURL: `https://${domain}/api/callback`,
        },
        verify
      );
      passport.use(strategy);
      registeredStrategies.add(strategyName);
    }
  };

  passport.serializeUser((user: Express.User, cb) => cb(null, user));
  passport.deserializeUser((user: Express.User, cb) => cb(null, user));

  app.get("/api/login", (req, res, next) => {
    ensureStrategy(req.hostname);
    passport.authenticate(`replitauth:${req.hostname}`, {
      prompt: "login consent",
      scope: ["openid", "email", "profile", "offline_access"],
    })(req, res, next);
  });

  app.get("/api/callback", (req, res, next) => {
    ensureStrategy(req.hostname);
    // Passport regenerates the session during sign-in. Observe the final
    // session ID after its existing redirect, not the pre-login session ID.
    res.once("finish", () => {
      const user = req.user;
      if (!user) return;
      const metadata = pendingLoginMetadata.get(user);
      if (!metadata) return;
      pendingLoginMetadata.delete(user);
      if (res.statusCode < 300 || res.statusCode >= 400 || !req.isAuthenticated()) return;
      createRefreshTrace(req.sessionID)("login_succeeded", user, { config, login: metadata });
    });
    passport.authenticate(`replitauth:${req.hostname}`, {
      successReturnToOrRedirect: "/",
      failureRedirect: "/api/login",
    })(req, res, next);
  });

  app.get("/api/logout", (req, res) => {
    req.logout(() => {
      res.redirect(
        client.buildEndSessionUrl(config, {
          client_id: process.env.REPL_ID!,
          post_logout_redirect_uri: `${req.protocol}://${req.hostname}`,
        }).href
      );
    });
  });
}

export const isAuthenticated: RequestHandler = async (req, res, next) => {
  const user = req.user as any;

  if (!req.isAuthenticated() || !user.expires_at) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now <= user.expires_at) {
    return next();
  }

  const refreshToken = user.refresh_token;
  if (!refreshToken) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }

  try {
    await refreshSessionTokens(req, user);
    return next();
  } catch (error) {
    // A silent 401 here is how "logged out every day" mysteries are born:
    // log the provider's failure server-side so the next incident leaves
    // evidence. Never log token material.
    console.error("[auth] OIDC refresh grant failed", refreshFailureDiagnostics(error));
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
};

// In-flight refresh grants, keyed by session id. Concurrent requests sharing
// an expired access token must not each fire a refresh: with rotating refresh
// tokens the losers look like token reuse and can get the grant chain revoked,
// logging the user out for real. The critical section covers a fresh session
// read, the grant, and the save: a request whose session copy predates another
// request's rotation re-reads inside the lock and adopts the rotated tokens
// instead of granting with the consumed one.
const inflightRefreshes = new Map<string, Promise<any>>();

export async function refreshSessionTokens(
  req: Pick<Request, "sessionID" | "session">,
  user: any,
): Promise<any> {
  const key = req.sessionID ?? user?.claims?.sub ?? "unknown";
  const trace = createRefreshTrace(req.sessionID);
  trace("started", user);
  const existing = inflightRefreshes.get(key);
  if (existing) {
    trace("waiting", user, { phase: "waiting" });
    try {
      const freshUser = await existing;
      adoptFreshUser(req, freshUser);
      trace("completed", freshUser, { phase: "waiting" });
    } catch (error) {
      trace("failed", user, { phase: "waiting", error });
      throw error;
    }
    return;
  }
  let phase: RefreshPhase = "session_reload";
  let providerConfig: client.Configuration | undefined;
  const task = (async () => {
    // Fresh read inside the critical section: this request's session copy
    // may predate another request's rotation.
    await reloadSession(req);
    const sessionUser = (req.session as any)?.passport?.user;
    trace("session_reloaded", sessionUser, { phase });
    const nowSec = Math.floor(Date.now() / 1000);
    if (sessionUser?.expires_at && nowSec <= sessionUser.expires_at) {
      trace("already_fresh", sessionUser, { phase });
      return sessionUser; // already refreshed by someone else
    }
    if (!sessionUser?.refresh_token) {
      throw new Error("no refresh token in session");
    }
    phase = "discovery";
    const config = await getOidcConfig();
    providerConfig = config;
    phase = "grant";
    trace("grant_started", sessionUser, { phase, config });
    const previousRefreshToken = sessionUser.refresh_token;
    const tokenResponse = await client.refreshTokenGrant(
      config,
      sessionUser.refresh_token,
    );
    updateUserSession(sessionUser, tokenResponse);
    trace("grant_succeeded", sessionUser, {
      phase,
      refreshTokenRotated: sessionUser.refresh_token !== previousRefreshToken,
    });
    // The lock must be held until the rotated tokens are durable in the
    // session store; releasing it earlier leaves a window for a stale
    // reader to grant with the consumed token.
    phase = "session_save";
    await saveSession(req);
    trace("session_saved", sessionUser, { phase });
    return sessionUser;
  })();
  inflightRefreshes.set(key, task);
  try {
    const freshUser = await task;
    adoptFreshUser(req, freshUser);
    trace("completed", freshUser);
    return freshUser;
  } catch (error) {
    trace("failed", (req.session as any)?.passport?.user ?? user, {
      phase, error, config: providerConfig,
    });
    throw error;
  } finally {
    inflightRefreshes.delete(key);
  }
}

// Point req.user and the request's session copy at the fresh user object so
// downstream handlers and the end-of-response save observe the rotated tokens.
function adoptFreshUser(req: any, freshUser: any) {
  if (!freshUser) return;
  req.user = freshUser;
  if (req.session?.passport) {
    req.session.passport.user = freshUser;
  }
}

function reloadSession(req: Pick<Request, "session">): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.reload((err) => (err ? reject(err) : resolve()));
  });
}

// Persist the session explicitly instead of waiting for express-session's
// end-of-response save, so the critical section above covers durability.
function saveSession(req: Pick<Request, "session">): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}
