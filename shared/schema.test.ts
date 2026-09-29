import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import {
  insertOauthClientSchema,
  insertOauthDeviceCodeSchema,
  insertOauthTokenSchema,
  insertOutboxEventSchema,
  oauthClients,
  oauthDeviceCodes,
  oauthTokens,
  outboxEvents,
} from "./schema";

function columnNames(table: any): string[] {
  return getTableConfig(table).columns.map((c: any) => c.name);
}

describe("oauthClients", () => {
  it("maps to oauth_clients with the expected columns", () => {
    expect(getTableConfig(oauthClients).name).toBe("oauth_clients");
    expect(columnNames(oauthClients)).toEqual([
      "client_id",
      "name",
      "allowed_scopes",
      "created_at",
    ]);
  });

  it("validates insert input", () => {
    const parsed = insertOauthClientSchema.parse({
      clientId: "ghost",
      name: "Ghost",
      allowedScopes: ["library:read"],
    });
    expect(parsed.clientId).toBe("ghost");
    expect(() => insertOauthClientSchema.parse({ clientId: "ghost" })).toThrow();
  });
});

describe("oauthDeviceCodes", () => {
  it("maps to oauth_device_codes with the expected columns", () => {
    expect(getTableConfig(oauthDeviceCodes).name).toBe("oauth_device_codes");
    expect(columnNames(oauthDeviceCodes)).toEqual([
      "device_code_hash",
      "user_code",
      "client_id",
      "scopes",
      "status",
      "approved_by_user_id",
      "expires_at",
      "created_at",
    ]);
  });

  it("validates insert input", () => {
    const parsed = insertOauthDeviceCodeSchema.parse({
      deviceCodeHash: "abc",
      userCode: "ABCD1234",
      clientId: "ghost",
      scopes: ["library:read"],
      status: "pending",
      expiresAt: new Date(),
    });
    expect(parsed.userCode).toBe("ABCD1234");
    expect(() =>
      insertOauthDeviceCodeSchema.parse({ deviceCodeHash: "abc" })
    ).toThrow();
  });
});

describe("oauthTokens", () => {
  it("maps to oauth_tokens with the expected columns", () => {
    expect(getTableConfig(oauthTokens).name).toBe("oauth_tokens");
    expect(columnNames(oauthTokens)).toEqual([
      "id",
      "client_id",
      "user_id",
      "scopes",
      "access_token_hash",
      "refresh_token_hash",
      "access_expires_at",
      "refresh_expires_at",
      "rotated_at",
      "revoked_at",
      "created_at",
    ]);
  });

  it("validates insert input", () => {
    const now = new Date();
    const parsed = insertOauthTokenSchema.parse({
      clientId: "ghost",
      userId: "user-1",
      scopes: ["library:read"],
      accessTokenHash: "a",
      refreshTokenHash: "r",
      accessExpiresAt: now,
      refreshExpiresAt: now,
    });
    expect(parsed.clientId).toBe("ghost");
    expect(() => insertOauthTokenSchema.parse({ clientId: "ghost" })).toThrow();
  });
});

describe("outboxEvents", () => {
  it("maps to events with the expected columns and drain index", () => {
    expect(getTableConfig(outboxEvents).name).toBe("events");
    expect(columnNames(outboxEvents)).toEqual([
      "id",
      "type",
      "payload",
      "dedupe_key",
      "created_at",
      "processed_at",
      "processed_by",
    ]);
    const drainIdx = getTableConfig(outboxEvents).indexes.find(
      (i: any) => i.config.name === "events_drain_idx"
    );
    expect(drainIdx).toBeDefined();
    const indexedColumns = drainIdx!.config.columns.map((c: any) => c.name);
    expect(indexedColumns).toEqual(["processed_at", "created_at"]);
  });

  it("validates insert input", () => {
    const parsed = insertOutboxEventSchema.parse({
      type: "sync.completed",
      payload: { ok: true },
      dedupeKey: "sync-123",
    });
    expect(parsed.type).toBe("sync.completed");
    expect(() => insertOutboxEventSchema.parse({})).toThrow();
  });
});
