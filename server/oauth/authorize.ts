// Authorization Code Grant (RFC 6749 §4.1): browser-facing endpoints.
//
// GET /oauth/authorize validates the authorization request and renders an
// approve/deny consent page; POST /oauth/authorize/decision records the
// decision, mints a single-use code, and redirects back to the client.
// Both require Brian's live Replit OIDC session; the decision form carries a
// synchronizer CSRF token (the app has no global CSRF middleware).
//
// client_id and redirect_uri are re-validated on POST: the hidden form
// fields are user-tamperable, and we never redirect to a URI outside the
// client's allow-list.

import type { Request, Response } from "express";
import { eq, lt } from "drizzle-orm";
import { db } from "../db";
import { oauthAuthorizationCodes, oauthClients } from "@shared/schema";
import { newOpaqueToken, pkceChallengeOk, sha256Hex } from "./crypto";
import { isLoggedIn, sessionUserId, stashReturnTo } from "./request";
import { esc, page } from "./page";
import { checkCsrf, csrfToken } from "./verify";

export const AUTH_CODE_TTL_SEC = 600; // 10 minutes (RFC 6749 §4.1.2)

const PKCE_METHODS = ["S256", "plain"];

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorPage(heading: string, detail: string): string {
  return page(
    "Front Row — authorization error",
    `<h1 class="error">${esc(heading)}</h1><p>${esc(detail)}</p>`
  );
}

// Validate client_id + redirect_uri before any redirect happens: per RFC
// 6749 §4.1.2.1 an untrusted redirect target must never receive one.
async function validatedClient(clientId: string, redirectUri: string) {
  const [client] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId));
  if (!client) return null;
  const allowed = client.allowedRedirectUris ?? [];
  if (!redirectUri || !allowed.includes(redirectUri)) return null;
  return client;
}

function validatedScopes(client: { allowedScopes: string[] | null }, scopeParam: string): string[] | null {
  const allowed = new Set(client.allowedScopes ?? []);
  const scopes = scopeParam ? scopeParam.split(/\s+/).filter(Boolean) : [...allowed];
  if (scopes.length === 0 || scopes.some((s) => !allowed.has(s))) return null;
  return scopes;
}

function redirectWithParams(redirectUri: string, params: Record<string, string>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) url.searchParams.append(key, value);
  return url.toString();
}

// Rebuild the GET /oauth/authorize URL from a decision form's body so a
// logged-out POST can resume at the consent page after login. handleAuthorize
// re-validates everything, so tampered fields can't bypass the allow-list.
function decisionReturnTo(body: Record<string, unknown>): string {
  const params = new URLSearchParams({ response_type: "code" });
  for (const key of ["client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method"]) {
    const value = str(body[key]);
    if (value) params.set(key, value);
  }
  return `/oauth/authorize?${params.toString()}`;
}

export async function handleAuthorize(req: Request, res: Response): Promise<void> {
  if (!isLoggedIn(req)) {
    stashReturnTo(req, req.originalUrl ?? "");
    res.redirect("/api/login");
    return;
  }
  try {
    const clientId = str(req.query.client_id);
    const redirectUri = str(req.query.redirect_uri);
    const state = str(req.query.state);
    const client = await validatedClient(clientId, redirectUri);
    if (!client) {
      // Unknown client or unlisted redirect_uri: tell the user directly,
      // never redirect (RFC 6749 §4.1.2.1).
      res.status(400).send(errorPage("Invalid authorization request", "Unknown client or redirect URI."));
      return;
    }
    // From here the redirect target is trusted, so errors go back to it.
    const redirectError = (error: string) =>
      res.redirect(redirectWithParams(redirectUri, { ...(state ? { state } : {}), error }));
    if (str(req.query.response_type) !== "code") {
      redirectError("unsupported_response_type");
      return;
    }
    const scopes = validatedScopes(client, str(req.query.scope));
    if (!scopes) {
      redirectError("invalid_scope");
      return;
    }
    const codeChallenge = str(req.query.code_challenge);
    const codeChallengeMethod = str(req.query.code_challenge_method) || (codeChallenge ? "plain" : "");
    // The challenge must be redeemable: a short plain challenge, or an S256
    // challenge that isn't exactly 43 chars, could never match at exchange,
    // so reject it up front instead of issuing a dead code.
    if (!pkceChallengeOk(codeChallenge, codeChallengeMethod) || !PKCE_METHODS.includes(codeChallengeMethod)) {
      redirectError("invalid_request");
      return;
    }
    const scopeList = scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join("");
    const hidden: Record<string, string> = {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes.join(" "),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
    };
    const hiddenInputs = Object.entries(hidden)
      .map(([key, value]) => `<input type="hidden" name="${key}" value="${esc(value)}">`)
      .join("\n");
    const decisionForm = (decision: string, label: string, cssClass: string) => `
      <form method="post" action="/oauth/authorize/decision" style="flex:1;display:flex">
        ${hiddenInputs}
        <input type="hidden" name="decision" value="${decision}">
        <input type="hidden" name="csrf" value="${esc(csrfToken(req))}">
        <button class="${cssClass}" type="submit">${label}</button>
      </form>`;
    res.send(
      page(
        "Front Row — approve access",
        `<h1>Approve access?</h1>
         <p><strong>${esc(client.name)}</strong> is requesting access to your Front Row library with these permissions:</p>
         <ul>${scopeList}</ul>
         <div class="row">
           ${decisionForm("approve", "Approve", "approve")}
           ${decisionForm("deny", "Deny", "deny")}
         </div>`
      )
    );
  } catch (err) {
    res.status(500).send(errorPage("Something went wrong", "Please try again."));
  }
}

export async function handleDecision(req: Request, res: Response): Promise<void> {
  if (!isLoggedIn(req)) {
    stashReturnTo(req, decisionReturnTo(req.body ?? {}));
    res.redirect("/api/login");
    return;
  }
  try {
    if (!checkCsrf(req)) {
      res.status(403).send(errorPage("Invalid form token", "Please reload the page and try again."));
      return;
    }
    const body = req.body ?? {};
    const client = await validatedClient(str(body.client_id), str(body.redirect_uri));
    const scopes = client ? validatedScopes(client, str(body.scope)) : null;
    const codeChallenge = str(body.code_challenge);
    const codeChallengeMethod = str(body.code_challenge_method) || (codeChallenge ? "plain" : "");
    if (!client || !scopes || !pkceChallengeOk(codeChallenge, codeChallengeMethod) || !PKCE_METHODS.includes(codeChallengeMethod)) {
      res.status(400).send(errorPage("Invalid authorization request", "Unknown client, redirect URI, scope, or PKCE method."));
      return;
    }
    const userId = sessionUserId(req);
    if (!userId) {
      stashReturnTo(req, decisionReturnTo(body));
      res.redirect("/api/login");
      return;
    }
    const redirectUri = str(body.redirect_uri);
    const state = str(body.state);
    if (str(body.decision) !== "approve") {
      res.redirect(redirectWithParams(redirectUri, { ...(state ? { state } : {}), error: "access_denied" }));
      return;
    }
    const code = newOpaqueToken();
    const now = new Date();
    // Opportunistic cleanup: abandoned codes are otherwise only deleted on
    // exchange, so sweep expired rows at issuance to bound table growth.
    await db.delete(oauthAuthorizationCodes).where(lt(oauthAuthorizationCodes.expiresAt, now));
    await db.insert(oauthAuthorizationCodes).values({
      codeHash: sha256Hex(code),
      clientId: client.clientId,
      userId,
      redirectUri,
      scopes,
      codeChallenge: codeChallenge || null,
      codeChallengeMethod: codeChallengeMethod || null,
      expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_SEC * 1000),
    });
    res.redirect(redirectWithParams(redirectUri, { ...(state ? { state } : {}), code }));
  } catch (err) {
    res.status(500).send(errorPage("Something went wrong", "Please try again."));
  }
}
