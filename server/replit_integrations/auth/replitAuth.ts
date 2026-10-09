import * as client from "openid-client";
import { Strategy, type VerifyFunction } from "openid-client/passport";

import passport from "passport";
import session from "express-session";
import type { Express, Request, RequestHandler } from "express";
import memoize from "memoizee";
import connectPg from "connect-pg-simple";
import { authStorage } from "./storage";

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

export function updateUserSession(
  user: any,
  tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers
) {
  user.claims = tokens.claims();
  user.access_token = tokens.access_token;
  // A refresh response may omit refresh_token (the provider didn't rotate
  // it); the spec says the client must keep using the old one. Overwriting
  // with undefined permanently breaks future refreshes: the next expiry
  // finds no refresh token and the user is logged out.
  if (tokens.refresh_token) {
    user.refresh_token = tokens.refresh_token;
  }
  user.expires_at = user.claims?.exp;
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
    console.error("[auth] OIDC refresh grant failed", {
      error: error instanceof Error ? error.message : String(error),
      code: (error as { code?: unknown })?.code,
    });
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
};

// In-flight refresh grants, keyed by session id. Concurrent requests sharing
// an expired access token must not each fire a refresh: with rotating refresh
// tokens the losers look like token reuse and can get the grant chain revoked,
// logging the user out for real. Single-flight them instead: the first
// request refreshes, the rest await its outcome and continue on the stored
// session (express-session persists the winner's token update by hashing the
// session; unmodified followers don't overwrite it).
const inflightRefreshes = new Map<string, Promise<void>>();

export async function refreshSessionTokens(
  req: Pick<Request, "sessionID">,
  user: any,
): Promise<void> {
  const key = req.sessionID ?? user?.claims?.sub ?? "unknown";
  const existing = inflightRefreshes.get(key);
  if (existing) {
    await existing;
    return;
  }
  const task = (async () => {
    const config = await getOidcConfig();
    const tokenResponse = await client.refreshTokenGrant(config, user.refresh_token);
    updateUserSession(user, tokenResponse);
  })();
  inflightRefreshes.set(key, task);
  try {
    await task;
  } finally {
    inflightRefreshes.delete(key);
  }
}
