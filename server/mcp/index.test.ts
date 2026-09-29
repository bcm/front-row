import express from "express";
import { describe, expect, it, vi } from "vitest";
import { db, resetDbMocks } from "../oauth/test-utils/mock-db";
import { mockReq, mockRes } from "../oauth/test-utils/http";
import { registerMcpRoutes, createMcpServer, MCP_SERVER_NAME } from "./index";
import { READ_TOOL_NAMES } from "./tools";
import { testAuth } from "./test-utils/tools";

vi.mock("../db", () => ({ db }));

resetDbMocks();

function mcpRoutes() {
  const app = express();
  registerMcpRoutes(app);
  const stack = (app as any)._router.stack as any[];
  const byMethod = (method: string) =>
    stack.find((l) => l.route && l.route.path === "/mcp" && l.route.methods[method])?.route;
  return { post: byMethod("post"), get: byMethod("get"), delete: byMethod("delete") };
}

describe("registerMcpRoutes", () => {
  it("mounts POST /mcp behind bearer auth and the library:read scope gate", () => {
    const { post } = mcpRoutes();
    expect(post).toBeDefined();
    const handlers = post.stack.map((s: any) => s.handle);
    expect(handlers[0].name).toBe("requireMcpAuth");
    // The scope gate rejects a request with no auth context: 403, not a fallback.
    const res = mockRes();
    handlers[1](mockReq(), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "insufficient_scope" })
    );
  });

  it("rejects GET and DELETE on /mcp with 405 (stateless mode has no streams/sessions)", () => {
    const { get, delete: del } = mcpRoutes();
    for (const route of [get, del]) {
      expect(route).toBeDefined();
      const res = mockRes();
      route.stack[0].handle(mockReq(), res);
      expect(res.status).toHaveBeenCalledWith(405);
    }
  });
});

describe("createMcpServer", () => {
  it("registers exactly the v1 read tools", () => {
    const server = createMcpServer(testAuth);
    const tools = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect(Object.keys(tools).sort()).toEqual([...READ_TOOL_NAMES].sort());
    expect(MCP_SERVER_NAME).toBe("front-row");
  });

  it("marks every tool read-only", () => {
    const server = createMcpServer(testAuth);
    const tools = (server as unknown as { _registeredTools: Record<string, any> })._registeredTools;
    for (const name of READ_TOOL_NAMES) {
      expect(tools[name].annotations?.readOnlyHint).toBe(true);
    }
  });
});
