// Human-approval step of the device flow: GET /oauth/device shows the code
// entry / consent page, POST /oauth/device/approve|deny records the decision.
// Requires Brian's live Replit OIDC session; approval binds the grant to the
// approver's claims.sub. Forms carry a synchronizer CSRF token (the app has
// no global CSRF middleware).

import type { Request, Response } from "express";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { oauthClients, oauthDeviceCodes } from "@shared/schema";
import { normalizeUserCode } from "./crypto";
import { esc, page } from "./page";
import { isLoggedIn, sessionUserId } from "./request";

const VERIFY_ATTEMPTS_PER_MINUTE = 20; // per-session throttle on the approval form

export function csrfToken(req: Request): string {
  const session = req.session as any;
  if (!session.oauthCsrf) session.oauthCsrf = randomBytes(16).toString("hex");
  return session.oauthCsrf;
}

// Per-session throttle on verification attempts (session store is Postgres,
// so this works across autoscale replicas).
function verificationAttemptsAllowed(req: Request): boolean {
  const session = req.session as any;
  const now = Date.now();
  const state = session.oauthAttempts ?? { count: 0, resetAt: now + 60_000 };
  if (now > state.resetAt) {
    state.count = 0;
    state.resetAt = now + 60_000;
  }
  state.count += 1;
  session.oauthAttempts = state;
  return state.count <= VERIFY_ATTEMPTS_PER_MINUTE;
}

async function lookupPendingCode(userCode: string) {
  const [row] = await db
    .select()
    .from(oauthDeviceCodes)
    .where(eq(oauthDeviceCodes.userCode, userCode));
  if (!row || row.status !== "pending" || row.expiresAt < new Date()) return null;
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, row.clientId));
  return { row, client };
}

export function checkCsrf(req: Request): boolean {
  return typeof req.body?.csrf === "string" && req.body.csrf === (req.session as any)?.oauthCsrf;
}

export async function handleDevicePage(req: Request, res: Response): Promise<void> {
  if (!isLoggedIn(req)) {
    res.redirect("/api/login");
    return;
  }
  try {
    const codeParam = typeof req.query.code === "string" ? normalizeUserCode(req.query.code) : "";
    if (!codeParam) {
      res.send(
        page(
          "Front Row — connect a device",
          `<h1>Connect a device</h1>
           <p>Enter the code shown by the app requesting access to your Front Row library.</p>
           <form method="get" action="/oauth/device">
             <input type="text" name="code" placeholder="XXXX-XXXX" autocomplete="off" autofocus>
             <button class="single" type="submit">Continue</button>
           </form>`
        )
      );
      return;
    }
    const found = await lookupPendingCode(codeParam);
    if (!found) {
      res.send(
        page(
          "Front Row — invalid code",
          `<h1 class="error">Invalid or expired code</h1>
           <p>That code doesn't match a pending request, or it already expired (codes last 10 minutes). Ask the app for a fresh code.</p>`
        )
      );
      return;
    }
    const { row, client } = found;
    const scopes = row.scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join("");
    const minutesLeft = Math.max(1, Math.round((row.expiresAt.getTime() - Date.now()) / 60000));
    res.send(
      page(
        "Front Row — approve access",
        `<h1>Approve access?</h1>
         <p><strong>${esc(client?.name ?? row.clientId)}</strong> is requesting access to your Front Row library with these permissions:</p>
         <ul>${scopes}</ul>
         <p>This code expires in about ${minutesLeft} minute${minutesLeft === 1 ? "" : "s"}.</p>
         <div class="row">
           <form method="post" action="/oauth/device/approve" style="flex:1;display:flex">
             <input type="hidden" name="user_code" value="${esc(row.userCode)}">
             <input type="hidden" name="csrf" value="${esc(csrfToken(req))}">
             <button class="approve" type="submit">Approve</button>
           </form>
           <form method="post" action="/oauth/device/deny" style="flex:1;display:flex">
             <input type="hidden" name="user_code" value="${esc(row.userCode)}">
             <input type="hidden" name="csrf" value="${esc(csrfToken(req))}">
             <button class="deny" type="submit">Deny</button>
           </form>
         </div>`
      )
    );
  } catch (err) {
    res.status(500).send(page("Front Row — error", `<h1 class="error">Something went wrong</h1><p>Please try again.</p>`));
  }
}

export async function handleApprove(req: Request, res: Response): Promise<void> {
  if (!isLoggedIn(req)) {
    res.redirect("/api/login");
    return;
  }
  try {
    if (!checkCsrf(req)) {
      res.status(403).send(page("Front Row — forbidden", `<h1 class="error">Invalid form token</h1><p>Please reload the page and try again.</p>`));
      return;
    }
    if (!verificationAttemptsAllowed(req)) {
      res.status(429).send(page("Front Row — slow down", `<h1 class="error">Too many attempts</h1><p>Wait a minute and try again.</p>`));
      return;
    }
    const userCode = normalizeUserCode(typeof req.body?.user_code === "string" ? req.body.user_code : "");
    const found = await lookupPendingCode(userCode);
    if (!found) {
      res.send(page("Front Row — invalid code", `<h1 class="error">Invalid or expired code</h1><p>That code doesn't match a pending request.</p>`));
      return;
    }
    const userId = sessionUserId(req);
    if (!userId) {
      res.redirect("/api/login");
      return;
    }
    await db
      .update(oauthDeviceCodes)
      .set({ status: "approved", approvedByUserId: userId })
      .where(eq(oauthDeviceCodes.deviceCodeHash, found.row.deviceCodeHash));
    res.send(
      page(
        "Front Row — approved",
        `<h1>Access approved</h1>
         <p><strong>${esc(found.client?.name ?? found.row.clientId)}</strong> can now access your Front Row library. You can close this window and return to your agent.</p>
         <p>Revoke access anytime from the authorized-apps section.</p>`
      )
    );
  } catch (err) {
    res.status(500).send(page("Front Row — error", `<h1 class="error">Something went wrong</h1><p>Please try again.</p>`));
  }
}

export async function handleDeny(req: Request, res: Response): Promise<void> {
  if (!isLoggedIn(req)) {
    res.redirect("/api/login");
    return;
  }
  try {
    if (!checkCsrf(req)) {
      res.status(403).send(page("Front Row — forbidden", `<h1 class="error">Invalid form token</h1><p>Please reload the page and try again.</p>`));
      return;
    }
    const userCode = normalizeUserCode(typeof req.body?.user_code === "string" ? req.body.user_code : "");
    const [row] = await db.select().from(oauthDeviceCodes).where(eq(oauthDeviceCodes.userCode, userCode));
    if (row && row.status === "pending") {
      await db
        .update(oauthDeviceCodes)
        .set({ status: "denied" })
        .where(eq(oauthDeviceCodes.deviceCodeHash, row.deviceCodeHash));
    }
    res.send(
      page(
        "Front Row — denied",
        `<h1>Access denied</h1><p>The request was denied. The app was not granted access. You can close this window.</p>`
      )
    );
  } catch (err) {
    res.status(500).send(page("Front Row — error", `<h1 class="error">Something went wrong</h1><p>Please try again.</p>`));
  }
}
