import { describe, expect, it } from "vitest";
import type {
  SystemAlephUpdateRun,
  SystemAlephUpdateStatus,
} from "@bb/server-contract";
import type {
  AlephUpdateOperation,
  AlephUpdateService,
} from "../../src/services/system/aleph-update.js";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

const API = "/api/v1/system/aleph-update";
const NONCE = "0123456789abcdef0123456789abcdef";
const DIGEST = "a".repeat(64);
const APP_ORIGIN = "http://localhost";

const STATUS: SystemAlephUpdateStatus = {
  activeThreadCount: 0,
  capability: "startable",
  detail: null,
  floor: null,
  installed: { aleph: "0.5.3", version: "0.44.0+aleph.0.5.3" },
  predecessor: null,
  selection: "up-to-date",
  target: null,
};

function fakeService(): AlephUpdateService & {
  started: AlephUpdateOperation[];
} {
  const started: AlephUpdateOperation[] = [];
  return {
    started,
    async getRun(nonce) {
      return { detail: null, nonce, state: "not-found" };
    },
    async getStatus() {
      return STATUS;
    },
    async start(operation) {
      started.push(operation);
      return { detail: null, nonce: operation.nonce, state: "queued" };
    },
  };
}

const UPDATE_BODY = {
  confirm: "update",
  interrupt: false,
  manifestDigest: DIGEST,
  nonce: NONCE,
  target: "0.5.4",
};

function post(
  harness: {
    app: {
      request: (
        path: string,
        init: RequestInit,
      ) => Response | Promise<Response>;
    };
  },
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return Promise.resolve(
    harness.app.request(`${API}/${path}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", ...headers },
      method: "POST",
    }),
  );
}

const OWNER = {
  origin: APP_ORIGIN,
  "x-aleph-update": "1",
  "x-bb-gate-auth": "session",
};

describe("aleph update routes", () => {
  it("answers 404 on a build without the Aleph channel", () =>
    withTestHarness(async (harness) => {
      expect((await harness.app.request(API)).status).toBe(404);
      const response = await post(harness, "update", UPDATE_BODY, OWNER);
      expect(response.status).toBe(404);
    }));

  it("serves status and run lookups", () => {
    const service = fakeService();
    return withTestHarness({ alephUpdateService: service }, async (harness) => {
      const status = await harness.app.request(API);
      expect(status.status).toBe(200);
      expect(await readJson(status)).toEqual(STATUS);
      const run = await harness.app.request(`${API}/runs/${NONCE}`);
      expect(run.status).toBe(200);
      expect((await readJson(run)) as SystemAlephUpdateRun).toEqual({
        detail: null,
        nonce: NONCE,
        state: "not-found",
      });
    });
  });

  it("starts an update for a session on the app origin", () => {
    const service = fakeService();
    return withTestHarness({ alephUpdateService: service }, async (harness) => {
      const response = await post(harness, "update", UPDATE_BODY, OWNER);
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({
        detail: null,
        nonce: NONCE,
        state: "queued",
      });
      expect(service.started).toEqual([
        {
          interrupt: false,
          manifestDigest: DIGEST,
          nonce: NONCE,
          operation: "update",
          target: "0.5.4",
        },
      ]);
    });
  });

  it("starts rollback and recover for the owner session", () => {
    const service = fakeService();
    return withTestHarness({ alephUpdateService: service }, async (harness) => {
      const rollback = await post(
        harness,
        "rollback",
        {
          confirm: "rollback",
          from: "0.5.4",
          interrupt: true,
          nonce: NONCE,
          to: "0.5.3",
        },
        OWNER,
      );
      const recover = await post(
        harness,
        "recover",
        { confirm: "recover", nonce: NONCE },
        OWNER,
      );
      expect(rollback.status).toBe(200);
      expect(recover.status).toBe(200);
      expect(service.started.map((entry) => entry.operation)).toEqual([
        "rollback",
        "recover",
      ]);
    });
  });

  it.each([
    ["machine credentials", { ...OWNER, "x-bb-gate-auth": "machine" }],
    ["a request without gate auth", withoutKey(OWNER, "x-bb-gate-auth")],
    ["a foreign origin", { ...OWNER, origin: "https://elsewhere.example" }],
    ["a missing origin", withoutKey(OWNER, "origin")],
    ["a missing update header", withoutKey(OWNER, "x-aleph-update")],
    ["a wrong update header", { ...OWNER, "x-aleph-update": "0" }],
  ])("refuses %s", (_label, headers) => {
    const service = fakeService();
    return withTestHarness({ alephUpdateService: service }, async (harness) => {
      for (const [path, body] of [
        ["update", UPDATE_BODY],
        [
          "rollback",
          {
            confirm: "rollback",
            from: "0.5.4",
            interrupt: false,
            nonce: NONCE,
            to: "0.5.3",
          },
        ],
        ["recover", { confirm: "recover", nonce: NONCE }],
      ] as const) {
        const response = await post(harness, path, body, headers);
        expect(response.status).toBe(403);
      }
      expect(service.started).toEqual([]);
    });
  });

  it("refuses a confirm value that does not match the operation", () => {
    const service = fakeService();
    return withTestHarness({ alephUpdateService: service }, async (harness) => {
      const wrongConfirm = await post(
        harness,
        "update",
        { ...UPDATE_BODY, confirm: "rollback" },
        OWNER,
      );
      const noConfirm = await post(harness, "recover", { nonce: NONCE }, OWNER);
      expect(wrongConfirm.status).toBe(400);
      expect(noConfirm.status).toBe(400);
      expect(service.started).toEqual([]);
    });
  });

  it("accepts a request that forges the relayed session header directly", () => {
    const service = fakeService();
    return withTestHarness({ alephUpdateService: service }, async (harness) => {
      const response = await post(harness, "update", UPDATE_BODY, {
        origin: APP_ORIGIN,
        "x-aleph-update": "1",
        "x-bb-gate-auth": "session",
      });
      expect(response.status).toBe(200);
      expect(service.started).toHaveLength(1);
    });
  });
});

function withoutKey(
  headers: Record<string, string>,
  key: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== key),
  );
}
