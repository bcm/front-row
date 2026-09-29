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
