import { describe, expect, it } from "vitest";
import {
  clearConnectBinding,
  getConnectBinding,
  recordGateAssertionUse,
  replaceConnectBinding,
  sweepExpiredGateAssertionUses,
} from "../../src/data/connect-binding.js";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";

function freshDb() {
  const db = createConnection(":memory:");
  migrate(db);
  return db;
}

const binding = {
  issuer: "https://getbb.app",
  ownerUserId: "user_a",
  runtime: "production",
  serverId: "srv_a",
} as const;

describe("connect binding", () => {
  it("reports change only for a new or differing binding", () => {
    const db = freshDb();
    expect(replaceConnectBinding(db, binding).changed).toBe(true);
    expect(replaceConnectBinding(db, binding).changed).toBe(false);
    expect(
      replaceConnectBinding(db, { ...binding, serverId: "srv_b" }).changed,
    ).toBe(true);
    expect(getConnectBinding(db)?.serverId).toBe("srv_b");
    expect(clearConnectBinding(db).changed).toBe(true);
    expect(getConnectBinding(db)).toBeNull();
    expect(clearConnectBinding(db).changed).toBe(false);
  });
});

describe("gate assertion uses", () => {
  it("accepts a jti once and sweeps expired rows", () => {
    const db = freshDb();
    expect(recordGateAssertionUse(db, { jti: "j1", expiresAt: 100 })).toBe(true);
    expect(recordGateAssertionUse(db, { jti: "j1", expiresAt: 100 })).toBe(false);
    expect(recordGateAssertionUse(db, { jti: "j2", expiresAt: 500 })).toBe(true);
    expect(sweepExpiredGateAssertionUses(db, 200)).toBe(1);
    expect(recordGateAssertionUse(db, { jti: "j1", expiresAt: 900 })).toBe(true);
    expect(recordGateAssertionUse(db, { jti: "j2", expiresAt: 900 })).toBe(false);
  });
});
