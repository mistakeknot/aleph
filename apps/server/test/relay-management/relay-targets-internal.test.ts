import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { getRelayTarget, insertRelayTarget } from "@bb/db";
import { describe, expect, it } from "vitest";
import {
  RELAY_ASSERTION_ISSUERS,
  validateRelayAssertionKeyTable,
  type RelayAssertionKey,
} from "../../src/services/relay-management/assertion-keys.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 29);

function key(kid: string, overrides: Partial<RelayAssertionKey> = {}) {
  return {
    issuer: RELAY_ASSERTION_ISSUERS.production,
    kid,
    notAfter: NOW + 100 * DAY,
    notBefore: NOW - DAY,
    publicKey: "A".repeat(43),
    runtime: "production",
    ...overrides,
  } satisfies RelayAssertionKey;
}

describe("relay assertion key table", () => {
  it("accepts a valid table and rejects invalid ones", () => {
    expect(() =>
      validateRelayAssertionKeyTable([key("a"), key("b")], NOW),
    ).not.toThrow();
    expect(() =>
      validateRelayAssertionKeyTable([key("a"), key("a")], NOW),
    ).toThrow();
    expect(() =>
      validateRelayAssertionKeyTable([key("a"), key("b"), key("c")], NOW),
    ).toThrow();
    expect(() =>
      validateRelayAssertionKeyTable(
        [key("a", { notAfter: NOW + 500 * DAY })],
        NOW,
      ),
    ).toThrow();
    expect(() =>
      validateRelayAssertionKeyTable(
        [key("a", { issuer: "https://evil.example" })],
        NOW,
      ),
    ).toThrow();
    expect(() =>
      validateRelayAssertionKeyTable(
        [
          key("old1", { notAfter: NOW - DAY, notBefore: NOW - 300 * DAY }),
          key("old2", { notAfter: NOW - DAY, notBefore: NOW - 300 * DAY }),
          key("a"),
          key("b"),
        ],
        NOW,
      ),
    ).not.toThrow();
  });
});

describe("host-scoped internal relay target routes", () => {
  it("lists only the calling host's targets without titles", async () => {
    await withTestHarness(async (harness) => {
      const a = seedThreadFixture(harness, { session: { id: "host_a" } });
      const b = seedThreadFixture(harness, { session: { id: "host_b" } });
      insertRelayTarget(harness.deps.db, {
        createdByUserId: "u",
        hostId: a.host.id,
        threadId: a.thread.id,
      });
      insertRelayTarget(harness.deps.db, {
        createdByUserId: "u",
        hostId: b.host.id,
        threadId: b.thread.id,
      });
      const response = await harness.app.request("/internal/relay/targets", {
        headers: internalAuthHeaders(harness, { hostId: a.host.id }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        targets: Record<string, unknown>[];
      };
      expect(body.targets.map((t) => t.threadId)).toEqual([a.thread.id]);
      expect(Object.keys(body.targets[0] ?? {}).sort()).toEqual([
        "createdAt",
        "threadId",
      ]);
    });
  });

  it("removes only own targets and gives no existence oracle", async () => {
    await withTestHarness(async (harness) => {
      const a = seedThreadFixture(harness, { session: { id: "host_a" } });
      const b = seedThreadFixture(harness, { session: { id: "host_b" } });
      insertRelayTarget(harness.deps.db, {
        createdByUserId: "u",
        hostId: b.host.id,
        threadId: b.thread.id,
      });
      const headers = {
        ...internalAuthHeaders(harness, { hostId: a.host.id }),
        "content-type": "application/json",
      };
      const foreign = await harness.app.request(
        "/internal/relay/targets/remove",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ threadId: b.thread.id }),
        },
      );
      expect(foreign.status).toBe(200);
      expect(await foreign.json()).toMatchObject({ removed: 0 });
      expect(
        getRelayTarget(harness.deps.db, b.host.id, b.thread.id),
      ).not.toBeNull();

      insertRelayTarget(harness.deps.db, {
        createdByUserId: "u",
        hostId: a.host.id,
        threadId: a.thread.id,
      });
      const own = await harness.app.request("/internal/relay/targets/remove", {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(await own.json()).toMatchObject({ removed: 1 });
      expect(
        getRelayTarget(harness.deps.db, a.host.id, a.thread.id),
      ).toBeNull();
    });
  });

  it("rejects unauthenticated callers", async () => {
    await withTestHarness(async (harness) => {
      const list = await harness.app.request("/internal/relay/targets");
      expect(list.status).toBe(401);
      const remove = await harness.app.request(
        "/internal/relay/targets/remove",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      );
      expect(remove.status).toBe(401);
    });
  });
});

describe("connect_binding write surface", () => {
  it("is written only by db data helpers and never from routes", () => {
    const routeDirs = ["../../src/routes", "../../src/internal"].map((dir) =>
      path.join(import.meta.dirname, dir),
    );
    const offenders: string[] = [];
    for (const dir of routeDirs) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".ts")) continue;
        const text = readFileSync(path.join(dir, file), "utf8");
        if (
          /replaceConnectBinding|clearConnectBinding|connectBinding\b/u.test(
            text,
          )
        ) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
