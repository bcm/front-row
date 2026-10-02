// Programmable mock for the drizzle `db` client used in OAuth unit tests.
//
// Usage in a test file:
//   import { db, chainable, resetDbMocks } from "./test-utils/mock-db";
//   vi.mock("../db", () => ({ db }));
//   beforeEach(() => resetDbMocks());
//
// Each db method (select/insert/update/delete) returns a chainable query
// builder: every chained call returns the same builder, and awaiting it
// resolves to the configured result.

import { vi } from "vitest";

const CHAIN_METHODS = [
  "select",
  "from",
  "where",
  "insert",
  "values",
  "onConflictDoUpdate",
  "onConflictDoNothing",
  "returning",
  "update",
  "set",
  "delete",
  "orderBy",
  "limit",
] as const;

/** A thenable chainable: chain calls return self, await resolves `result`. */
export function chainable(result: unknown = []): any {
  const chain: Record<string, any> = {
    _result: result,
    then(resolve: (value: unknown) => void) {
      resolve(chain._result);
    },
  };
  for (const method of CHAIN_METHODS) {
    chain[method] = vi.fn((..._args: unknown[]) => chain);
  }
  return chain;
}

function mockMethod() {
  return vi.fn((..._args: unknown[]) => chainable());
}

export const db = {
  select: mockMethod(),
  insert: mockMethod(),
  update: mockMethod(),
  delete: mockMethod(),
  execute: mockMethod(),
  // Wired per test file: must invoke its callback with a tx double.
  transaction: vi.fn(),
};

export function resetDbMocks(): void {
  for (const [name, method] of Object.entries(db)) {
    method.mockClear();
    // transaction is exempt: the default chainable would swallow the
    // callback instead of running it. Each test file sets its own
    // implementation after resetDbMocks().
    if (name !== "transaction") {
      method.mockImplementation((..._args: unknown[]) => chainable());
    }
  }
}
