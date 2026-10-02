// Tests for the shared relay claim machinery.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { claimRelayRows } from "./relay";
import { pool } from "./db";

vi.mock("./db", () => ({ pool: { query: vi.fn() } }));

const query = vi.mocked(pool.query);

beforeEach(() => query.mockReset());

describe("claimRelayRows", () => {
  it("claims eligible rows oldest-first with SKIP LOCKED in one statement", async () => {
    query.mockResolvedValue({ rows: [{ id: "a" }] });
    const rows = await claimRelayRows<{ id: string }>({
      table: "tvmaze_queue",
      eligibleWhere: "status = 'queued'",
      claimSet: "status = 'claimed'",
      limit: 3,
    });
    expect(rows).toEqual([{ id: "a" }]);
    expect(query).toHaveBeenCalledTimes(1);
    const [text, params] = query.mock.calls[0] as [string, unknown[]];
    expect(text).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(text).toMatch(/ORDER BY created_at ASC/);
    expect(text).toMatch(/RETURNING t\.\*/);
    expect(params).toEqual([3]);
  });

  it("defaults to claiming one row", async () => {
    query.mockResolvedValue({ rows: [] });
    const rows = await claimRelayRows({ table: "events", eligibleWhere: "x", claimSet: "y" });
    expect(rows).toEqual([]);
    expect((query.mock.calls[0] as [string, unknown[]])[1]).toEqual([1]);
  });

  it("parameterizes only the limit; clauses come from internal spec constants", async () => {
    query.mockResolvedValue({ rows: [] });
    await claimRelayRows({
      table: "tvmaze_queue",
      eligibleWhere: "status = 'queued'",
      claimSet: "status = 'claimed'",
    });
    const [text, params] = query.mock.calls[0] as [string, unknown[]];
    expect(text).toContain("tvmaze_queue");
    expect(text.match(/\$\d+/g)).toEqual(["$1"]);
    expect(params).toEqual([1]);
  });
});
