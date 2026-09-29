// MCP server mounted at /mcp (docs/agent-interface-design.md §3).
//
// Uses the official @modelcontextprotocol/sdk with the Streamable HTTP
// transport in stateless mode (sessionIdGenerator: undefined): no session
// state anywhere, safe across autoscale replicas. Each request gets a fresh
// transport; the tool handlers close over the request's auth context.
//
// Auth: the existing requireMcpAuth + requireScope("library:read")
// middleware (server/oauth/middleware.ts). Invalid token → 401, missing
// scope → 403, no demo-user fallback — same invariants as the OAuth surface.

import type { Express, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireMcpAuth, requireScope, type McpAuthContext } from "../oauth/middleware";
import { toolRegistrar } from "./register";
import { registerReadTools } from "./tools";

export const MCP_SERVER_NAME = "front-row";
export const MCP_SERVER_VERSION = "1.0.0";

export function createMcpServer(auth: McpAuthContext): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
  registerReadTools(toolRegistrar(server), auth);
  return server;
}

async function handleMcp(req: Request, res: Response): Promise<void> {
  const auth = (req as { mcpAuth?: McpAuthContext }).mcpAuth;
  if (!auth) {
    res.status(401).json({ error: "invalid_token", error_description: "missing auth context" });
    return;
  }
  const server = createMcpServer(auth);
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  }
}

function methodNotAllowed(_req: Request, res: Response): void {
  // Stateless mode has no SSE stream (GET) or session lifecycle (DELETE).
  res.status(405).json({ error: "method_not_allowed", error_description: "use POST for JSON-RPC requests" });
}

export function registerMcpRoutes(app: Express): void {
  app.post("/mcp", requireMcpAuth, requireScope("library:read"), handleMcp);
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);
}
