import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveView } from "./view";
import { mockStorage } from "./test-utils/tools";

vi.mock("../storage", () => ({ storage: mockStorage() }));

import { storage } from "../storage";

const mocked = storage as unknown as ReturnType<typeof mockStorage>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveView", () => {
  it("resolves personal view without touching groups", async () => {
    const resolved = await resolveView("user-1", "personal");
    expect(resolved).toEqual({ view: "personal", showMode: "personal", groupIds: [] });
    expect(mocked.getUserGroupIds).not.toHaveBeenCalled();
  });

  it("resolves family view to shared mode with the user's group ids", async () => {
    mocked.getUserGroupIds.mockResolvedValue(["g1", "g2"]);
    const resolved = await resolveView("user-1", "family");
    expect(resolved).toEqual({ view: "family", showMode: "shared", groupIds: ["g1", "g2"] });
  });

  it("resolves family view with no groups to an empty group list", async () => {
    mocked.getUserGroupIds.mockResolvedValue([]);
    const resolved = await resolveView("user-1", "family");
    expect(resolved.groupIds).toEqual([]);
  });
});
