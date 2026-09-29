import {
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";
import {
  getConnectBinding,
  getRelayTarget,
  insertRelayTarget,
  replaceConnectBinding,
  setConnectBindingReconciled,
} from "@bb/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorToResponse } from "../../src/errors.js";
import { registerRelayTargetRoutesWithKeys } from "../../src/routes/relay-targets.js";
import {
  RELAY_ASSERTION_ISSUERS,
  type RelayAssertionKey,
} from "../../src/services/relay-management/assertion-keys.js";
import {
  addRelayTargetForHuman,
  listRelayTargetsForHuman,
} from "../../src/services/relay-management/targets.js";
import { bindConnectRelayIdentity } from "../../src/services/relay-management/connect-binding.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const SERVER_ID = "srv_test";
const OWNER = "user_owner";
const KID = "kid-1";
const DAY = 24 * 60 * 60 * 1000;

interface Claims {
  aud: string;
  exp: number;
  iat: number;
  iss: string;
  jti: string;
  kind: string;
  method: string;
  path: string;
  sub: string;
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function rawPublicKey(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" });
  return der.subarray(der.length - 32).toString("base64url");
}

function makeKeys() {
  const pair = generateKeyPairSync("ed25519");
  const key: RelayAssertionKey = {
    issuer: RELAY_ASSERTION_ISSUERS.production,
    kid: KID,
    notAfter: NOW + 100 * DAY,
    notBefore: NOW - DAY,
    publicKey: rawPublicKey(pair.publicKey),
    runtime: "production",
  };
  return { key, privateKey: pair.privateKey };
}

function baseClaims(method: string, path: string): Claims {
  return {
    aud: SERVER_ID,
    exp: NOW / 1000 + 30,
    iat: NOW / 1000,
    iss: RELAY_ASSERTION_ISSUERS.production,
    jti: randomBytes(16).toString("base64url"),
    kind: "human-session",
    method,
    path,
    sub: OWNER,
  };
}

function mint(
  privateKey: KeyObject,
  claims: Claims,
  header: Record<string, unknown> = { alg: "EdDSA", kid: KID },
): string {
  const signingInput = `${b64(header)}.${b64(claims)}`;
  return `${signingInput}.${sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

type Harness = TestAppHarness;

function buildApp(harness: Harness, keys: readonly RelayAssertionKey[]) {
  const app = new Hono();
  const publicApi = new Hono();
  registerRelayTargetRoutesWithKeys(publicApi, harness.deps, keys, () => NOW);
  app.route("/api/v1", publicApi);
  app.onError((error) => errorToResponse(error, harness.deps.logger));
  return app;
}

function replaceReconciled(
  db: Harness["deps"]["db"],
  input: Parameters<typeof replaceConnectBinding>[1],
) {
  const result = replaceConnectBinding(db, input);
  setConnectBindingReconciled(db, true);
  return result;
}

function bind(harness: Harness) {
  return replaceReconciled(harness.deps.db, {
    issuer: RELAY_ASSERTION_ISSUERS.production,
    ownerUserId: OWNER,
    runtime: "production",
    serverId: SERVER_ID,
  });
}

async function call(
  app: Hono,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
) {
  return app.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function listPath(hostId: string) {
  return `/api/v1/hosts/${hostId}/relay-targets`;
}

describe("relay target human assertion", () => {
  it("lists, adds and removes with a valid assertion and sets no-store", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const app = buildApp(harness, [key]);
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const hostId = fixture.host.id;
      const threadId = fixture.thread.id;
      const put = `${listPath(hostId)}/${threadId}`;

      const added = await call(app, "PUT", put, {
        "x-bb-gate-assertion": mint(privateKey, baseClaims("PUT", put)),
      });
      expect(added.status).toBe(200);
      expect(getRelayTarget(harness.deps.db, hostId, threadId)).not.toBeNull();

      const listed = await call(app, "GET", listPath(hostId), {
        "x-bb-gate-assertion": mint(
          privateKey,
          baseClaims("GET", listPath(hostId)),
        ),
      });
      expect(listed.status).toBe(200);
      expect(listed.headers.get("cache-control")).toBe("no-store");
      const listBody = (await listed.json()) as {
        targets: { threadId: string; threadTitle: string | null }[];
      };
      expect(listBody.targets.map((t) => t.threadId)).toEqual([threadId]);

      const removed = await call(app, "DELETE", put, {
        "x-bb-gate-assertion": mint(privateKey, baseClaims("DELETE", put)),
      });
      expect(removed.status).toBe(200);
      expect(getRelayTarget(harness.deps.db, hostId, threadId)).toBeNull();
    });
  });

  it("rejects each invalid assertion with 403 human_session_required and writes nothing", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const other = generateKeyPairSync("ed25519");
      const app = buildApp(harness, [key]);
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const hostId = fixture.host.id;
      const path = `${listPath(hostId)}/${fixture.thread.id}`;
      const good = () => baseClaims("PUT", path);
      const cases: Record<
        string,
        {
          headers?: Record<string, string>;
          token: string;
          body?: string;
          url?: string;
        }
      > = {
        wrongKid: {
          token: mint(privateKey, good(), { alg: "EdDSA", kid: "nope" }),
        },
        wrongKey: { token: mint(other.privateKey, good()) },
        algNone: {
          token: mint(privateKey, good(), { alg: "none", kid: KID }),
        },
        wrongIssuer: {
          token: mint(privateKey, { ...good(), iss: "https://evil.example" }),
        },
        wrongAud: { token: mint(privateKey, { ...good(), aud: "srv_other" }) },
        wrongSub: { token: mint(privateKey, { ...good(), sub: "user_other" }) },
        wrongKind: { token: mint(privateKey, { ...good(), kind: "machine" }) },
        wrongMethod: {
          token: mint(privateKey, { ...good(), method: "DELETE" }),
        },
        wrongPath: { token: mint(privateKey, { ...good(), path: `${path}x` }) },
        expired: {
          token: mint(privateKey, {
            ...good(),
            exp: NOW / 1000 - 1,
            iat: NOW / 1000 - 30,
          }),
        },
        futureIat: {
          token: mint(privateKey, {
            ...good(),
            exp: NOW / 1000 + 100,
            iat: NOW / 1000 + 60,
          }),
        },
        longLifetime: {
          token: mint(privateKey, { ...good(), exp: NOW / 1000 + 120 }),
        },
        nonEmptyBody: { token: mint(privateKey, good()), body: "x" },
        machineKind: {
          token: mint(privateKey, good()),
          headers: { "x-bb-gate-auth": "machine" },
        },
        malformed: { token: "a.b" },
      };
      for (const [name, c] of Object.entries(cases)) {
        const response = await call(
          app,
          "PUT",
          path,
          { "x-bb-gate-assertion": c.token, ...c.headers },
          c.body,
        );
        expect(response.status, name).toBe(403);
        expect(((await response.json()) as { code?: string }).code, name).toBe(
          "human_session_required",
        );
      }
      const missing = await call(app, "PUT", path, {});
      expect(missing.status).toBe(403);
      const query = await call(app, "PUT", `${path}?x=1`, {
        "x-bb-gate-assertion": mint(privateKey, good()),
      });
      expect(query.status).toBe(403);
      expect(
        getRelayTarget(harness.deps.db, hostId, fixture.thread.id),
      ).toBeNull();
    });
  });

  it("rejects when no binding exists", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const app = buildApp(harness, [key]);
      const fixture = seedThreadFixture(harness);
      const path = listPath(fixture.host.id);
      const response = await call(app, "GET", path, {
        "x-bb-gate-assertion": mint(privateKey, baseClaims("GET", path)),
      });
      expect(response.status).toBe(403);
    });
  });

  it("rejects a key outside its window and a key bound to another runtime", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const path = listPath(fixture.host.id);
      const token = mint(privateKey, baseClaims("GET", path));
      for (const variant of [
        { ...key, notAfter: NOW - 1 },
        { ...key, notBefore: NOW + 1 },
        {
          ...key,
          runtime: "staging" as const,
          issuer: RELAY_ASSERTION_ISSUERS.staging,
        },
      ]) {
        const app = buildApp(harness, [variant]);
        const response = await call(app, "GET", path, {
          "x-bb-gate-assertion": token,
        });
        expect(response.status).toBe(403);
      }
    });
  });

  it("rejects a replayed jti for GET, PUT and DELETE, and replay writes nothing", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const app = buildApp(harness, [key]);
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const hostId = fixture.host.id;
      const threadId = fixture.thread.id;
      const item = `${listPath(hostId)}/${threadId}`;

      const list = mint(privateKey, baseClaims("GET", listPath(hostId)));
      expect(
        (
          await call(app, "GET", listPath(hostId), {
            "x-bb-gate-assertion": list,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await call(app, "GET", listPath(hostId), {
            "x-bb-gate-assertion": list,
          })
        ).status,
      ).toBe(403);

      const put = mint(privateKey, baseClaims("PUT", item));
      expect(
        (await call(app, "PUT", item, { "x-bb-gate-assertion": put })).status,
      ).toBe(200);
      expect(
        (await call(app, "PUT", item, { "x-bb-gate-assertion": put })).status,
      ).toBe(403);

      const del = mint(privateKey, baseClaims("DELETE", item));
      expect(
        (await call(app, "DELETE", item, { "x-bb-gate-assertion": del }))
          .status,
      ).toBe(200);
      insertRelayTarget(harness.deps.db, {
        createdByUserId: OWNER,
        hostId,
        threadId,
      });
      expect(
        (await call(app, "DELETE", item, { "x-bb-gate-assertion": del }))
          .status,
      ).toBe(403);
      expect(getRelayTarget(harness.deps.db, hostId, threadId)).not.toBeNull();
    });
  });

  it("returns 404 for an unknown host or thread only after a valid assertion", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const app = buildApp(harness, [key]);
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const missingHost = `${listPath("host_missing")}/${fixture.thread.id}`;
      const r1 = await call(app, "PUT", missingHost, {
        "x-bb-gate-assertion": mint(privateKey, baseClaims("PUT", missingHost)),
      });
      expect(r1.status).toBe(404);
      const missingThread = `${listPath(fixture.host.id)}/thr_missing`;
      const r2 = await call(app, "PUT", missingThread, {
        "x-bb-gate-assertion": mint(
          privateKey,
          baseClaims("PUT", missingThread),
        ),
      });
      expect(r2.status).toBe(404);
      const r3 = await call(app, "PUT", missingThread, {});
      expect(r3.status).toBe(403);
    });
  });
});

describe("connect binding", () => {
  it("cancels targets only when the binding differs", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const deps = { db: harness.deps.db, hub: harness.deps.hub };
      const input = {
        baseUrl: "https://getbb.app",
        ownerUserId: OWNER,
        serverId: SERVER_ID,
      };
      expect(bindConnectRelayIdentity(deps, input).status).toBe("bound");
      insertRelayTarget(harness.deps.db, {
        createdByUserId: OWNER,
        hostId: fixture.host.id,
        threadId: fixture.thread.id,
      });
      expect(bindConnectRelayIdentity(deps, input).status).toBe("unchanged");
      expect(
        getRelayTarget(harness.deps.db, fixture.host.id, fixture.thread.id),
      ).not.toBeNull();

      expect(
        bindConnectRelayIdentity(deps, { ...input, ownerUserId: "user_new" })
          .status,
      ).toBe("bound");
      expect(
        getRelayTarget(harness.deps.db, fixture.host.id, fixture.thread.id),
      ).toBeNull();
      expect(getConnectBinding(harness.deps.db)?.ownerUserId).toBe("user_new");
    });
  });

  it("clears the binding and targets for an unsupported runtime or missing identity", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedThreadFixture(harness);
      const deps = { db: harness.deps.db, hub: harness.deps.hub };
      bindConnectRelayIdentity(deps, {
        baseUrl: "https://getbb.app",
        ownerUserId: OWNER,
        serverId: SERVER_ID,
      });
      insertRelayTarget(harness.deps.db, {
        createdByUserId: OWNER,
        hostId: fixture.host.id,
        threadId: fixture.thread.id,
      });
      expect(
        bindConnectRelayIdentity(deps, {
          baseUrl: "http://bb.localhost:3000",
          ownerUserId: OWNER,
          serverId: SERVER_ID,
        }).status,
      ).toBe("unsupported_runtime");
      expect(getConnectBinding(harness.deps.db)).toBeNull();
      expect(
        getRelayTarget(harness.deps.db, fixture.host.id, fixture.thread.id),
      ).toBeNull();
    });
  });
});

function delayedContext(
  method: string,
  path: string,
  token: string,
  gate: Promise<void>,
) {
  const headers: Record<string, string> = { "x-bb-gate-assertion": token };
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      method,
      url: `http://localhost${path}`,
      arrayBuffer: async () => {
        await gate;
        return new ArrayBuffer(0);
      },
    },
  };
}

describe("relay target assertion consumption races", () => {
  it("refuses an assertion verified for one account after a different account re-pairs", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const hostId = fixture.host.id;
      const path = listPath(hostId);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = listRelayTargetsForHuman(
        harness.deps,
        delayedContext(
          "GET",
          path,
          mint(privateKey, baseClaims("GET", path)),
          gate,
        ),
        { db: harness.deps.db, keys: [key], now: () => NOW },
        hostId,
      );
      replaceReconciled(harness.deps.db, {
        issuer: RELAY_ASSERTION_ISSUERS.production,
        ownerUserId: "user_other",
        runtime: "production",
        serverId: SERVER_ID,
      });
      release();
      await expect(pending).rejects.toMatchObject({
        status: 403,
        body: { code: "human_session_required" },
      });
    });
  });

  it("refuses an add when the binding was replaced and restored during verification", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const hostId = fixture.host.id;
      const threadId = fixture.thread.id;
      const path = `${listPath(hostId)}/${threadId}`;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = addRelayTargetForHuman(
        harness.deps,
        delayedContext(
          "PUT",
          path,
          mint(privateKey, baseClaims("PUT", path)),
          gate,
        ),
        { db: harness.deps.db, keys: [key], now: () => NOW },
        { hostId, threadId },
      );
      replaceReconciled(harness.deps.db, {
        issuer: RELAY_ASSERTION_ISSUERS.production,
        ownerUserId: "user_other",
        runtime: "production",
        serverId: SERVER_ID,
      });
      bind(harness);
      release();
      await expect(pending).rejects.toMatchObject({
        status: 403,
        body: { code: "human_session_required" },
      });
      expect(getRelayTarget(harness.deps.db, hostId, threadId)).toBeNull();
    });
  });

  it("refuses two requests delayed across assertion expiry and does not free the jti", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const hostId = fixture.host.id;
      const path = listPath(hostId);
      const claims = baseClaims("GET", path);
      const token = mint(privateKey, claims);
      let clock = NOW;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const deps = {
        db: harness.deps.db,
        keys: [key],
        now: () => clock,
      };
      const first = listRelayTargetsForHuman(
        harness.deps,
        delayedContext("GET", path, token, gate),
        deps,
        hostId,
      );
      const second = listRelayTargetsForHuman(
        harness.deps,
        delayedContext("GET", path, token, gate),
        deps,
        hostId,
      );
      clock = claims.exp * 1000;
      release();
      const settled = await Promise.allSettled([first, second]);
      for (const result of settled) {
        expect(result.status).toBe("rejected");
        expect((result as PromiseRejectedResult).reason).toMatchObject({
          status: 403,
          body: { code: "human_session_required" },
        });
      }
    });
  });

  it("refuses when the signing key expires between verification and consumption", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const shortKey = { ...key, notAfter: NOW + 10_000 };
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const hostId = fixture.host.id;
      const path = listPath(hostId);
      let clock = NOW;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = listRelayTargetsForHuman(
        harness.deps,
        delayedContext(
          "GET",
          path,
          mint(privateKey, {
            ...baseClaims("GET", path),
            exp: NOW / 1000 + 60,
          }),
          gate,
        ),
        { db: harness.deps.db, keys: [shortKey], now: () => clock },
        hostId,
      );
      clock = NOW + 20_000;
      release();
      await expect(pending).rejects.toMatchObject({
        status: 403,
        body: { code: "human_session_required" },
      });
    });
  });
});

describe("relay assertion key table load", () => {
  it("rejects every assertion when the key table is invalid", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const app = buildApp(harness, [
        { ...key, notAfter: key.notBefore + 500 * DAY },
      ]);
      const path = listPath(fixture.host.id);
      const response = await call(app, "GET", path, {
        "x-bb-gate-assertion": mint(privateKey, baseClaims("GET", path)),
      });
      expect(response.status).toBe(403);
    });
  });
});

describe("relay binding reconciliation fence", () => {
  it("rejects signed GET, PUT and DELETE while fenced and accepts after reconcile", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const app = buildApp(harness, [key]);
      const fixture = seedThreadFixture(harness);
      const hostId = fixture.host.id;
      const threadId = fixture.thread.id;
      const item = `${listPath(hostId)}/${threadId}`;
      bind(harness);
      const requests = [
        ["PUT", item],
        ["GET", listPath(hostId)],
        ["DELETE", item],
      ] as const;

      setConnectBindingReconciled(harness.deps.db, false);
      for (const [method, path] of requests) {
        const response = await call(app, method, path, {
          "x-bb-gate-assertion": mint(privateKey, baseClaims(method, path)),
        });
        expect(response.status).toBe(403);
      }
      expect(getRelayTarget(harness.deps.db, hostId, threadId)).toBeNull();

      setConnectBindingReconciled(harness.deps.db, true);
      for (const [method, path] of requests) {
        const response = await call(app, method, path, {
          "x-bb-gate-assertion": mint(privateKey, baseClaims(method, path)),
        });
        expect(response.status).toBe(200);
      }
    });
  });

  it("starts a new or changed binding fenced, and clearing removes it", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const app = buildApp(harness, [key]);
      const fixture = seedThreadFixture(harness);
      const path = listPath(fixture.host.id);
      const deps = {
        db: harness.deps.db,
        hub: { notifyThread: () => {} },
      };
      bindConnectRelayIdentity(deps, {
        baseUrl: RELAY_ASSERTION_ISSUERS.production,
        ownerUserId: OWNER,
        serverId: SERVER_ID,
      });
      const fenced = await call(app, "GET", path, {
        "x-bb-gate-assertion": mint(privateKey, baseClaims("GET", path)),
      });
      expect(fenced.status).toBe(403);
      setConnectBindingReconciled(harness.deps.db, true);
      const open = await call(app, "GET", path, {
        "x-bb-gate-assertion": mint(privateKey, baseClaims("GET", path)),
      });
      expect(open.status).toBe(200);
      expect(setConnectBindingReconciled(harness.deps.db, false)).toBe(true);
      bindConnectRelayIdentity(deps, {
        baseUrl: RELAY_ASSERTION_ISSUERS.production,
        ownerUserId: "",
        serverId: "",
      });
      expect(setConnectBindingReconciled(harness.deps.db, true)).toBe(false);
    });
  });

  it("refuses an assertion verified before a fence lands during body read", async () => {
    await withTestHarness(async (harness) => {
      const { key, privateKey } = makeKeys();
      const fixture = seedThreadFixture(harness);
      bind(harness);
      const hostId = fixture.host.id;
      const path = listPath(hostId);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = listRelayTargetsForHuman(
        harness.deps,
        delayedContext(
          "GET",
          path,
          mint(privateKey, baseClaims("GET", path)),
          gate,
        ),
        { db: harness.deps.db, keys: [key], now: () => NOW },
        hostId,
      );
      setConnectBindingReconciled(harness.deps.db, false);
      release();
      await expect(pending).rejects.toMatchObject({
        status: 403,
        body: { code: "human_session_required" },
      });
    });
  });
});
