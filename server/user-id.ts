import type { Request } from "express";

// Resolves the authenticated user's id from the request. Fails closed: the
// /api routes sit behind the isAuthenticated middleware, so a missing subject
// means the request was never authenticated. Falling back to a shared
// placeholder here would silently serve one user's data to another.
export function getUserId(req: Request): string {
  const user = req.user as { claims?: { sub?: string } } | undefined;
  const sub = user?.claims?.sub;
  if (!sub) {
    throw new Error("getUserId: no authenticated user on request");
  }
  return sub;
}
