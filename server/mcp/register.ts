import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

/**
 * Type-level shim over McpServer.registerTool.
 *
 * @modelcontextprotocol/sdk 1.31 types tool schemas against BOTH zod v3 and
 * zod v4 (the SDK nests zod v4 while this repo uses zod v3). Under TS 5.6 the
 * resulting cross-version conditional-type checks exceed the instantiation
 * depth limit (TS2589) for every registerTool call, even though the code is
 * correct and the SDK validates arguments against the schemas at runtime.
 *
 * This keeps a single honest `as unknown as` cast in one place. At runtime
 * this calls the real McpServer.registerTool with a raw shape inputSchema,
 * exactly as the SDK documents - nothing about the MCP protocol is
 * reimplemented. Tool definitions stay fully typed: handler arguments
 * are inferred from the zod v3 schemas via z.objectOutputType.
 */

export type TextResult = CallToolResult;

export interface ToolRegistrar {
  registerReadTool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    handler: (args: z.objectOutputType<Shape, z.ZodTypeAny, "strip">) => Promise<TextResult>,
  ): void;
}

interface RawRegisterTool {
  registerTool(
    name: string,
    config: {
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: { readOnlyHint: boolean };
    },
    cb: (args: unknown) => Promise<TextResult>,
  ): unknown;
}

export function toolRegistrar(server: McpServer): ToolRegistrar {
  const raw = (server as unknown as RawRegisterTool).registerTool.bind(server);
  return {
    registerReadTool(name, description, shape, handler) {
      raw(
        name,
        { description, inputSchema: shape, annotations: { readOnlyHint: true } },
        (args) => handler(args as z.objectOutputType<typeof shape, z.ZodTypeAny, "strip">),
      );
    },
  };
}
