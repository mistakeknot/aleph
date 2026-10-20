import { describe, expect, it } from "vitest";
import {
  createConnection,
  getStoredAlephInstallRequest,
  insertStoredAlephInstallRequest,
  listStoredAlephInstallRequests,
  migrate,
  updateStoredAlephInstallRequest,
  type StoredAlephInstallRequest,
} from "../../src/index.js";

function record(
  index: number,
  overrides: Partial<StoredAlephInstallRequest> = {},
): StoredAlephInstallRequest {
  return {
    dismissed: false,
    manifestDigest: "a".repeat(64),
    nonce: index.toString(16).padStart(32, "0"),
    notifiedAt: null,
    requestedAt: index,
    state: "requested",
    target: "0.6.9+aleph",
    ...overrides,
  };
}

function open() {
  const db = createConnection(":memory:");
  migrate(db);
  return db;
}

describe("aleph install requests", () => {
  it("stores one open request and refuses a second", () => {
    const db = open();
    try {
      expect(insertStoredAlephInstallRequest(db, record(1), 20)).toEqual({
        outcome: "inserted",
      });
      expect(insertStoredAlephInstallRequest(db, record(2), 20)).toEqual({
        outcome: "open-exists",
      });
      expect(listStoredAlephInstallRequests(db)).toHaveLength(1);
    } finally {
      db.$client.close();
    }
  });

  it("refuses a reused nonce and frees the slot on a terminal state", () => {
    const db = open();
    try {
      insertStoredAlephInstallRequest(db, record(1), 20);
      expect(insertStoredAlephInstallRequest(db, record(1), 20)).toEqual({
        outcome: "nonce-exists",
      });
      updateStoredAlephInstallRequest(db, record(1).nonce, {
        state: "cancelled",
      });
      expect(insertStoredAlephInstallRequest(db, record(2), 20)).toEqual({
        outcome: "inserted",
      });
      expect(getStoredAlephInstallRequest(db, record(1).nonce)?.state).toBe(
        "cancelled",
      );
    } finally {
      db.$client.close();
    }
  });

  it("keeps only the newest records", () => {
    const db = open();
    try {
      for (let index = 1; index <= 25; index += 1) {
        insertStoredAlephInstallRequest(
          db,
          record(index, { state: "expired" }),
          20,
        );
      }
      const rows = listStoredAlephInstallRequests(db);
      expect(rows).toHaveLength(20);
      expect(rows[0]?.requestedAt).toBe(25);
      expect(rows.at(-1)?.requestedAt).toBe(6);
    } finally {
      db.$client.close();
    }
  });

  it("keeps the newest notified record per digest through pruning", () => {
    const db = open();
    try {
      insertStoredAlephInstallRequest(
        db,
        record(1, { notifiedAt: 1, state: "cancelled" }),
        20,
      );
      for (let index = 2; index <= 30; index += 1) {
        insertStoredAlephInstallRequest(
          db,
          record(index, { state: "cancelled" }),
          20,
        );
      }
      const rows = listStoredAlephInstallRequests(db);
      expect(rows.some((row) => row.notifiedAt === 1)).toBe(true);
      expect(rows).toHaveLength(20);
    } finally {
      db.$client.close();
    }
  });

  it("never exceeds the cap when many digests were notified", () => {
    const db = open();
    try {
      for (let index = 1; index <= 40; index += 1) {
        insertStoredAlephInstallRequest(
          db,
          record(index, {
            manifestDigest: index.toString(16).padStart(64, "0"),
            notifiedAt: index,
            state: "cancelled",
          }),
          20,
        );
      }
      expect(listStoredAlephInstallRequests(db)).toHaveLength(20);
    } finally {
      db.$client.close();
    }
  });

  it("enforces a single open row in the database itself", () => {
    const db = open();
    try {
      db.$client
        .prepare(
          "INSERT INTO aleph_install_requests (nonce, target, manifest_digest, state, requested_at) VALUES ('a', 't', 'd', 'requested', 1)",
        )
        .run();
      expect(() =>
        db.$client
          .prepare(
            "INSERT INTO aleph_install_requests (nonce, target, manifest_digest, state, requested_at) VALUES ('b', 't', 'd', 'requested', 2)",
          )
          .run(),
      ).toThrow(/UNIQUE/u);
    } finally {
      db.$client.close();
    }
  });
});
