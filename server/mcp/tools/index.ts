// v1 read-tool registry. Every tool requires the library:read scope
// (enforced at the /mcp mount); write tools arrive in a later phase.

import type { McpAuthContext } from "../../oauth/middleware";
import type { ToolRegistrar } from "../register";
import { registerLibraryTools } from "./library";
import { registerCatalogTools } from "./catalog";
import { registerShowTools } from "./shows";
import { registerEpisodeTools } from "./episodes";
import { registerDiscoveryTools } from "./discovery";
import { registerSyncTools } from "./sync";

export const READ_TOOL_NAMES = [
  "library_list",
  "library_search",
  "catalog_search",
  "show_get",
  "queue_next_up",
  "upcoming_episodes",
  "releases_new",
  "recommendations_list",
  "sync_status",
] as const;

export function registerReadTools(tools: ToolRegistrar, auth: McpAuthContext): void {
  registerLibraryTools(tools, auth);
  registerCatalogTools(tools, auth);
  registerShowTools(tools, auth);
  registerEpisodeTools(tools, auth);
  registerDiscoveryTools(tools, auth);
  registerSyncTools(tools, auth);
}
