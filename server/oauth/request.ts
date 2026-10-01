// Small request helpers shared by the OAuth modules.

import type { Request } from "express";

export function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

export function isLoggedIn(req: Request): boolean {
  const fn = (req as any).isAuthenticated;
  return typeof fn === "function" ? fn.call(req) : false;
}

export function sessionUserId(req: Request): string | undefined {
  return (req as any).user?.claims?.sub;
}

// Stash a local return target before bouncing to /api/login: the OIDC
// callback honors req.session.returnTo (successReturnToOrRedirect), so the
// OAuth flow resumes after login. Only relative paths are stored — never
// attacker-influenced absolute URLs.
export function stashReturnTo(req: Request, returnTo: string): void {
  if (returnTo.startsWith("/")) {
    (req.session as any).returnTo = returnTo;
  }
}
