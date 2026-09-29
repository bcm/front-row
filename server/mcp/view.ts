// Explicit view/scope parameter for every MCP tool (design §5, §10.2).
//
// Group-aware from v1: reads against shared (family) context are deliberate,
// never implicit. There is no default — the caller must choose.

import { z } from "zod";
import { storage } from "../storage";

export const viewSchema = z
  .enum(["personal", "family"])
  .describe(
    "Which library view to read. 'personal' = the user's own shows only; " +
      "'family' = shows shared with the user's groups. Required: shared-context reads are never implicit."
  );

export type ViewParam = z.infer<typeof viewSchema>;

export interface ResolvedView {
  /** The requested view, echoed back in tool results. */
  view: ViewParam;
  /** Storage-level show mode: 'personal' or 'shared'. */
  showMode: "personal" | "shared";
  /** The user's group ids (family view only; empty when the user has no groups). */
  groupIds: string[];
}

export async function resolveView(userId: string, view: ViewParam): Promise<ResolvedView> {
  if (view === "personal") {
    return { view, showMode: "personal", groupIds: [] };
  }
  const groupIds = await storage.getUserGroupIds(userId);
  return { view, showMode: "shared", groupIds };
}
