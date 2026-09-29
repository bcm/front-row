// Minimal Express req/res mocks for handler unit tests.

import { vi } from "vitest";

export function mockReq(overrides: Record<string, any> = {}): any {
  return {
    body: {},
    query: {},
    params: {},
    protocol: "https",
    session: {},
    get: (_name: string) => undefined,
    ...overrides,
  };
}

export function mockRes(): any {
  const res: Record<string, any> = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  res.send = vi.fn(() => res);
  res.redirect = vi.fn(() => res);
  res.set = vi.fn(() => res);
  res.end = vi.fn(() => res);
  return res;
}
