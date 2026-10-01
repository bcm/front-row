// Protocol-level MCP tests: exercise tools through a real SDK client over an
// in-memory transport, so inputSchema validation runs — not just the handler
// logic the unit tests invoke directly.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { db } from "../oauth/test-utils/mock-db";
import { mockStorage, testAuth, userShowFixture } from "./test-utils/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./index";

vi.mock("../storage", async () => {
  const { mockStorage } = await import("./test-utils/tools");
  return { storage: mockStorage() };
});
vi.mock("../db", () => ({ db }));
vi.mock("../rate-limit", () => ({ checkRateLimit: vi.fn(), rateLimitKey: vi.fn(() => "k") }));

import { storage } from "../storage";

const mocked = storage as unknown as ReturnType<typeof mockStorage>;

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getUserGroupIds.mockResolvedValue(["g1"]);
});

async function linkedClient() {
  const server = createMcpServer(testAuth);
  const client = new Client({ name: "test-client", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function bodyOf(result: unknown): any {
  return JSON.parse(textOf(result));
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
}

describe("MCP protocol", () => {
  it("serves a valid tool call through the client", async () => {
    mocked.getUserShows.mockResolvedValue([userShowFixture()]);
    const { server, client } = await linkedClient();
    try {
      const result = await client.callTool({ name: "library_list", arguments: { view: "personal" } });
      const body = bodyOf(result);
      expect(body.view).toBe("personal");
      expect(body.shows).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects an invalid view with Invalid params", async () => {
    mocked.getUserShows.mockResolvedValue([userShowFixture()]);
    const { server, client } = await linkedClient();
    try {
      // SDK McpServer surfaces input-validation failures as an isError tool
      // result (not a thrown JSON-RPC error); assert the -32602 message.
      const result = await client.callTool({ name: "library_list", arguments: { view: "bogus" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("-32602");
      expect(textOf(result)).toContain("Invalid enum value");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects a missing required view with Invalid params", async () => {
    mocked.getUserShows.mockResolvedValue([userShowFixture()]);
    const { server, client } = await linkedClient();
    try {
      const result = await client.callTool({ name: "library_list", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("-32602");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
