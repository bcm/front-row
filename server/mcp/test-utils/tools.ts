// Helpers for MCP tool unit tests: a programmable storage mock and a
// direct tool-invocation helper (bypasses the HTTP transport).

import { vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpAuthContext } from "../../oauth/middleware";

export const testAuth: McpAuthContext = {
  userId: "user-1",
  clientId: "ghost",
  scopes: ["library:read"],
};

/** Storage mock with a vi.fn() per method the read tools use. */
export function mockStorage() {
  return {
    getUserShows: vi.fn(),
    getUserShowIds: vi.fn(),
    getUserGroupIds: vi.fn(),
    getShow: vi.fn(),
    getEpisodes: vi.fn(),
    getUserEpisodes: vi.fn(),
    getUserEpisodesForShow: vi.fn(),
    getUpcomingEpisodes: vi.fn(),
    getUserSettings: vi.fn(),
    getRecommendations: vi.fn(),
    searchUserShows: vi.fn(),
    searchUserEpisodes: vi.fn(),
  };
}

type ToolHandler = (args: any) => Promise<CallToolResult>;

function toolHandler(server: McpServer, name: string): ToolHandler {
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: ToolHandler }>;
    }
  )._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool.handler;
}

export interface ToolResult {
  isError: boolean;
  body: any;
}

/** Invoke a registered tool and parse its JSON text payload. */
export async function callTool(server: McpServer, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await toolHandler(server, name)(args);
  const text = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { text: string }).text)
    .join("");
  return { isError: result.isError ?? false, body: JSON.parse(text) };
}

// Minimal domain fixtures.

export function showFixture(overrides: Record<string, any> = {}) {
  return {
    id: 1,
    name: "Test Show",
    summary: null,
    image: null,
    network: { name: "HBO" },
    webChannel: null,
    genres: ["Drama"],
    status: "Running",
    premiered: "2020-01-01",
    ended: null,
    rating: { average: 8.5 },
    runtime: 60,
    averageRuntime: 60,
    schedule: null,
    officialSite: null,
    language: "English",
    type: "Scripted",
    updated: 1700000000,
    tmdbId: null,
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}

export function userShowFixture(overrides: Record<string, any> = {}) {
  const show = overrides.show ?? showFixture();
  return {
    id: "us-1",
    userId: "user-1",
    showId: show.id,
    groupId: null,
    addedAt: new Date("2024-02-01"),
    isRemoved: false,
    isShared: false,
    show,
    ...overrides,
  };
}

export function episodeFixture(overrides: Record<string, any> = {}) {
  return {
    id: 101,
    showId: 1,
    name: "Pilot",
    season: 1,
    number: 1,
    airdate: "2020-01-01",
    runtime: 60,
    summary: null,
    image: null,
    ...overrides,
  };
}
