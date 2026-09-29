import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectBindingConflictError,
  createConnection,
  getConnectBinding,
  getRelayTarget,
  insertRelayTarget,
} from "@bb/db";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { initDb } from "../../src/db.js";
import {
  bindConnectRelayIdentity,
  hasConnectRelayIdentity,
  markConnectRelayIdentityReconciled,
} from "../../src/services/relay-management/connect-binding.js";
import { seedThreadFixture } from "../helpers/seed.js";

interface FakeWebSocketOptions {
  handshakeTimeout?: number;
}

interface FakeTunnelSocket {
  readyState: number;
  emit(eventName: string, ...args: unknown[]): boolean;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

const fakeWebSockets = vi.hoisted(() => ({
  instances: [] as FakeTunnelSocket[],
  options: [] as FakeWebSocketOptions[],
}));

vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  const { EventEmitter } = await import("node:events");

  class FakeWebSocket extends EventEmitter {
    static readonly OPEN = 1;
    readyState = 0;

    constructor(_url: unknown, options: FakeWebSocketOptions) {
      super();
      fakeWebSockets.instances.push(this);
      fakeWebSockets.options.push(options);
    }

    close(): void {
      this.readyState = 2;
    }

    terminate(): void {
      this.readyState = 3;
    }
  }

  return { ...actual, WebSocket: FakeWebSocket };
});

interface TunnelStatus {
  relayBinding: boolean;
  relayConflict: boolean;
}

interface Tunnel {
  start(): Promise<void>;
  status(): TunnelStatus;
  stop(): void;
}

function loadConnectModule(name: string): Promise<Record<string, any>> {
  const specifier = new URL(
    `../../../../plugins/connect/src/${name}.ts`,
    import.meta.url,
  ).pathname;
  return import(/* @vite-ignore */ specifier);
}

async function createTunnelFixture(extra: Record<string, unknown> = {}) {
  const { ShareHostResolver } = await loadConnectModule("hosts");
  const { ShareRegistry } = await loadConnectModule("shares");
  const { ConnectTunnel } = await loadConnectModule("tunnel");
  const { DEFAULT_CONNECT_BASE_URL } = await loadConnectModule("redeem");
  const fakeHost = createFakePluginHost({
    pluginId: "connect",
    sdk: {
      system: {
        config: async () => ({ primaryHostId: "host-server" }) as never,
      },
    },
  });
  const pluginBb = fakeHost.bb;
  const credential = {
    serverUrl: "https://sawyer.getbb.app",
    handle: "sawyer",
    credential: "bbcred_x",
  };
  const clearCredential = vi.fn(async () => {});
  const onStatusChange = vi.fn();
  const shares = new ShareRegistry({
    kv: {
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    },
    hosts: pluginBb.hosts,
    hostResolver: new ShareHostResolver(() => pluginBb.sdk),
    getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
    getCredential: () => credential,
    log: pluginBb.log,
  });
  const tunnel: Tunnel = new ConnectTunnel({
    store: {
      read: async () => credential,
      write: async () => {},
      clear: clearCredential,
    },
    shares,
    defaultBaseUrl: DEFAULT_CONNECT_BASE_URL,
    getLoopbackBaseUrl: () => "http://127.0.0.1:38886",
    log: pluginBb.log,
    onStatusChange,
    ...extra,
  });
  return {
    clearCredential,
    credential,
    fakeHost,
    onStatusChange,
    tunnel,
  };
}

describe("ConnectTunnel reconcile against a shared relay binding", () => {
  afterEach(() => {
    fakeWebSockets.instances.length = 0;
    fakeWebSockets.options.length = 0;
    vi.useRealTimers();
  });

  const identityB = {
    baseUrl: "https://getbb.app",
    ownerUserId: "user_b",
    serverId: "srv_b",
  };
  const credentialA = {
    serverUrl: "https://sawyer.getbb.app",
    handle: "sawyer",
    credential: "bbcred_a",
  };

  function boundByB() {
    const file = join(mkdtempSync(join(tmpdir(), "relay-reconcile-")), "bb.db");
    initDb(file).$client.close();
    const dbA = createConnection(file);
    const dbB = createConnection(file);
    const hub = new Proxy({}, { get: () => () => {} }) as never;
    markConnectRelayIdentityReconciled({ db: dbB }, false);
    bindConnectRelayIdentity({ db: dbB, hub }, identityB);
    markConnectRelayIdentityReconciled({ db: dbB }, true);
    const fixture = seedThreadFixture({ deps: { db: dbB, hub } });
    insertRelayTarget(dbB, {
      createdByUserId: "user_b",
      hostId: fixture.host.id,
      threadId: fixture.thread.id,
    });
    return { dbA, dbB, fixture, hub };
  }

  async function tunnelForA(
    dbA: ReturnType<typeof createConnection>,
    hub: never,
    snapshot: {
      credential: typeof credentialA | null;
      relayIdentity: typeof identityB | null;
    },
  ) {
    return createTunnelFixture({
      bindRelayIdentity: (binding: never, options: never) => {
        bindConnectRelayIdentity({ db: dbA, hub }, binding, options);
      },
      markRelayIdentityReconciled: (reconciled: boolean) =>
        markConnectRelayIdentityReconciled({ db: dbA }, reconciled),
      hasRelayIdentity: () => hasConnectRelayIdentity({ db: dbA }),
      store: {
        read: async () => snapshot.credential,
        readSnapshot: async () => snapshot,
        write: async () => {},
        clear: async () => {},
      },
    });
  }

  it.each([
    [
      "holds a different stored identity",
      {
        credential: credentialA,
        relayIdentity: {
          baseUrl: "https://getbb.app",
          ownerUserId: "user_a",
          serverId: "srv_a",
        },
      },
    ],
    ["holds no credential", { credential: null, relayIdentity: null }],
  ])(
    "leaves B's binding and targets intact when A %s",
    async (_name, snapshot) => {
      const { dbA, dbB, fixture, hub } = boundByB();
      const before = getConnectBinding(dbB)!;
      const { fakeHost, tunnel } = await tunnelForA(dbA, hub, snapshot);
      try {
        await tunnel.start();
        expect(getConnectBinding(dbB)).toEqual(before);
        expect(
          getRelayTarget(dbB, fixture.host.id, fixture.thread.id),
        ).not.toBeNull();
        expect(tunnel.status().relayBinding).toBe(false);
        expect(tunnel.status().relayConflict).toBe(true);
        expect(() =>
          markConnectRelayIdentityReconciled({ db: dbA }, true),
        ).toThrow("not observed");
        expect(getConnectBinding(dbB)).toEqual(before);
      } finally {
        tunnel.stop();
        await fakeHost.harness.dispose();
      }
    },
  );

  it("keeps A fenced across retries without touching B's binding", async () => {
    vi.useFakeTimers();
    const { dbA, dbB, hub } = boundByB();
    const before = getConnectBinding(dbB)!;
    const { fakeHost, tunnel } = await tunnelForA(dbA, hub, {
      credential: null,
      relayIdentity: null,
    });
    try {
      await tunnel.start();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(getConnectBinding(dbB)).toEqual(before);
      expect(tunnel.status().relayConflict).toBe(true);
      expect(tunnel.status().relayBinding).toBe(false);
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  it("recovers when a restarted process holds the row's own identity", async () => {
    const { dbA, dbB, fixture, hub } = boundByB();
    const before = getConnectBinding(dbB)!;
    const { fakeHost, tunnel } = await tunnelForA(dbA, hub, {
      credential: credentialA,
      relayIdentity: identityB,
    });
    try {
      await tunnel.start();
      expect(tunnel.status().relayBinding).toBe(true);
      expect(fakeWebSockets.instances.length).toBeGreaterThan(0);
      expect(tunnel.status().relayConflict).toBe(false);
      expect(getConnectBinding(dbB)).toEqual({ ...before, reconciled: true });
      expect(
        getRelayTarget(dbB, fixture.host.id, fixture.thread.id),
      ).not.toBeNull();
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  it("stays fenced with a conflict when a stale mark(true) is refused", async () => {
    const { fakeHost, tunnel } = await createTunnelFixture({
      bindRelayIdentity: () => {},
      markRelayIdentityReconciled: (reconciled: boolean) => {
        if (reconciled) throw new ConnectBindingConflictError();
        return true;
      },
      hasRelayIdentity: () => true,
      store: {
        read: async () => credentialA,
        readSnapshot: async () => ({
          credential: credentialA,
          relayIdentity: identityB,
        }),
        write: async () => {},
        clear: async () => {},
      },
    });
    try {
      await tunnel.start();
      expect(tunnel.status().relayBinding).toBe(false);
      expect(tunnel.status().relayConflict).toBe(true);
    } finally {
      tunnel.stop();
      await fakeHost.harness.dispose();
    }
  });

  describe("explicit pair rollback and disconnect", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    const redeemedA = {
      credential: "bbcred_a",
      handle: "sawyer",
      ownerUserId: "user_a",
      serverId: "srv_a",
    };

    function stubRedeem() {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(redeemedA)),
      );
    }

    function sharedDbs() {
      const file = join(
        mkdtempSync(join(tmpdir(), "relay-explicit-")),
        "bb.db",
      );
      initDb(file).$client.close();
      const hub = new Proxy({}, { get: () => () => {} }) as never;
      return {
        dbA: createConnection(file),
        dbB: createConnection(file),
        hub,
      };
    }

    function tunnelWithWrite(
      dbA: ReturnType<typeof createConnection>,
      hub: never,
      write: () => Promise<void>,
    ) {
      return createTunnelFixture({
        bindRelayIdentity: (binding: never, options: never) => {
          bindConnectRelayIdentity({ db: dbA, hub }, binding, options);
        },
        markRelayIdentityReconciled: (reconciled: boolean) =>
          markConnectRelayIdentityReconciled({ db: dbA }, reconciled),
        hasRelayIdentity: () => hasConnectRelayIdentity({ db: dbA }),
        store: {
          read: async () => null,
          readSnapshot: async () => ({ credential: null, relayIdentity: null }),
          write,
          clear: async () => {},
        },
      });
    }

    function bindB(dbB: ReturnType<typeof createConnection>, hub: never) {
      markConnectRelayIdentityReconciled({ db: dbB }, false);
      bindConnectRelayIdentity({ db: dbB, hub }, identityB, {
        replaceExisting: true,
      });
      markConnectRelayIdentityReconciled({ db: dbB }, true);
      const fixture = seedThreadFixture({ deps: { db: dbB, hub } });
      insertRelayTarget(dbB, {
        createdByUserId: "user_b",
        hostId: fixture.host.id,
        threadId: fixture.thread.id,
      });
      return fixture;
    }

    it("does not let A's failed pair write roll back B's newer binding", async () => {
      stubRedeem();
      const { dbA, dbB, hub } = sharedDbs();
      let failWrite: () => void = () => {};
      let fixture: ReturnType<typeof bindB> | undefined;
      let inWrite: () => void = () => {};
      const writing = new Promise<void>((resolve) => {
        inWrite = resolve;
      });
      const { fakeHost, tunnel } = await tunnelWithWrite(
        dbA,
        hub,
        () =>
          new Promise<void>((_resolve, reject) => {
            failWrite = () => reject(new Error("write failed"));
            inWrite();
          }),
      );
      try {
        const pairing = (
          tunnel as never as {
            pair(args: { code: string }): Promise<unknown>;
          }
        ).pair({ code: "code" });
        await writing;
        fixture = bindB(dbB, hub);
        const before = getConnectBinding(dbB)!;
        failWrite();
        await expect(pairing).rejects.toThrow("write failed");
        expect(getConnectBinding(dbB)).toEqual(before);
        expect(
          getRelayTarget(dbB, fixture.host.id, fixture.thread.id),
        ).not.toBeNull();
      } finally {
        tunnel.stop();
        await fakeHost.harness.dispose();
      }
    });

    it("does not let a stale A disconnect clear B's live binding", async () => {
      stubRedeem();
      const { dbA, dbB, hub } = sharedDbs();
      const { fakeHost, tunnel } = await tunnelWithWrite(
        dbA,
        hub,
        async () => {},
      );
      try {
        await (
          tunnel as never as {
            pair(args: { code: string }): Promise<unknown>;
          }
        ).pair({ code: "code" });
        expect(getConnectBinding(dbA)?.serverId).toBe("srv_a");
        const fixture = bindB(dbB, hub);
        const before = getConnectBinding(dbB)!;
        await (
          tunnel as never as { disconnect(): Promise<unknown> }
        ).disconnect();
        expect(getConnectBinding(dbB)).toEqual(before);
        expect(
          getRelayTarget(dbB, fixture.host.id, fixture.thread.id),
        ).not.toBeNull();
      } finally {
        tunnel.stop();
        await fakeHost.harness.dispose();
      }
    });

    async function kvTunnel(
      db: ReturnType<typeof createConnection>,
      hub: never,
      kv: Map<string, unknown>,
      failClear: { on: boolean },
    ) {
      const { createKvCredentialStore } = await loadConnectModule("credential");
      const store = createKvCredentialStore({
        get: async (key: string) => kv.get(key),
        set: async (key: string, value: unknown) => {
          kv.set(key, value);
        },
        delete: async (key: string) => {
          kv.delete(key);
        },
      });
      return createTunnelFixture({
        bindRelayIdentity: (binding: { serverId: string }, options: never) => {
          if (failClear.on && binding.serverId === "") {
            throw new Error("database is locked");
          }
          bindConnectRelayIdentity({ db, hub }, binding as never, options);
        },
        markRelayIdentityReconciled: (reconciled: boolean) =>
          markConnectRelayIdentityReconciled({ db }, reconciled),
        hasRelayIdentity: () => hasConnectRelayIdentity({ db }),
        store,
      });
    }

    interface FullTunnel {
      pair(args: { code: string }): Promise<unknown>;
      disconnect(): Promise<{
        relayRevocationPending: boolean;
        relayConflict: boolean;
        paired: boolean;
      }>;
      start(): Promise<void>;
      status(): {
        relayRevocationPending: boolean;
        relayConflict: boolean;
        relayBinding: boolean;
      };
      stop(): void;
    }

    it("reports incomplete revocation, persists retry state, and clears the own binding on the next cycle", async () => {
      vi.useFakeTimers();
      stubRedeem();
      const { dbA, hub } = sharedDbs();
      const kv = new Map<string, unknown>();
      const failClear = { on: false };
      const { fakeHost, tunnel } = await kvTunnel(dbA, hub, kv, failClear);
      const api = tunnel as never as FullTunnel;
      try {
        await api.pair({ code: "code" });
        expect(getConnectBinding(dbA)?.serverId).toBe("srv_a");
        failClear.on = true;
        const status = await api.disconnect();
        expect(status.relayRevocationPending).toBe(true);
        expect(status.paired).toBe(false);
        expect(getConnectBinding(dbA)?.serverId).toBe("srv_a");
        expect(kv.has("credential")).toBe(false);
        expect(kv.get("relay-revocation")).toEqual({
          relayIdentity: {
            baseUrl: expect.any(String),
            ownerUserId: "user_a",
            serverId: "srv_a",
          },
        });
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getConnectBinding(dbA)?.serverId).toBe("srv_a");
        expect(api.status().relayRevocationPending).toBe(true);
        failClear.on = false;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(getConnectBinding(dbA)).toBeNull();
        expect(api.status().relayRevocationPending).toBe(false);
        expect(kv.has("relay-revocation")).toBe(false);
      } finally {
        tunnel.stop();
        await fakeHost.harness.dispose();
      }
    });

    it("retries the pending revocation after a restart with no credential", async () => {
      stubRedeem();
      const { dbA, dbB, hub } = sharedDbs();
      const kv = new Map<string, unknown>();
      const failClear = { on: false };
      const first = await kvTunnel(dbA, hub, kv, failClear);
      const firstApi = first.tunnel as never as FullTunnel;
      try {
        await firstApi.pair({ code: "code" });
        const fixture = seedThreadFixture({ deps: { db: dbA, hub } });
        insertRelayTarget(dbA, {
          createdByUserId: "user_a",
          hostId: fixture.host.id,
          threadId: fixture.thread.id,
        });
        failClear.on = true;
        expect((await firstApi.disconnect()).relayRevocationPending).toBe(true);
        first.tunnel.stop();
        const restarted = await kvTunnel(dbB, hub, kv, { on: false });
        const restartedApi = restarted.tunnel as never as FullTunnel;
        try {
          await restartedApi.start();
          expect(getConnectBinding(dbB)).toBeNull();
          expect(
            getRelayTarget(dbB, fixture.host.id, fixture.thread.id),
          ).toBeNull();
          expect(restartedApi.status().relayRevocationPending).toBe(false);
          expect(kv.has("relay-revocation")).toBe(false);
        } finally {
          restarted.tunnel.stop();
          await restarted.fakeHost.harness.dispose();
        }
      } finally {
        first.tunnel.stop();
        await first.fakeHost.harness.dispose();
      }
    });

    it("registers no relay-reset RPC and an unpaired A cannot clear B's binding", async () => {
      const { connectRpcContract } = await loadConnectModule("rpc");
      expect(Object.keys(connectRpcContract)).not.toContain("relayReset");
      stubRedeem();
      const { dbA, dbB, hub } = sharedDbs();
      const fixture = bindB(dbB, hub);
      const before = getConnectBinding(dbB)!;
      const { fakeHost, tunnel } = await kvTunnel(dbA, hub, new Map(), {
        on: false,
      });
      const api = tunnel as never as FullTunnel;
      try {
        await api.start();
        await api.disconnect();
        expect(getConnectBinding(dbB)).toEqual(before);
        expect(
          getRelayTarget(dbB, fixture.host.id, fixture.thread.id),
        ).not.toBeNull();
      } finally {
        tunnel.stop();
        await fakeHost.harness.dispose();
      }
    });

    it("does not let A's pending revocation clear a same-identity binding B re-paired", async () => {
      vi.useFakeTimers();
      stubRedeem();
      const { dbA, dbB, hub } = sharedDbs();
      const kv = new Map<string, unknown>();
      const failClear = { on: false };
      const a = await kvTunnel(dbA, hub, kv, failClear);
      const b = await kvTunnel(dbB, hub, kv, { on: false });
      const aApi = a.tunnel as never as FullTunnel;
      const bApi = b.tunnel as never as FullTunnel;
      try {
        await aApi.pair({ code: "code" });
        failClear.on = true;
        expect((await aApi.disconnect()).relayRevocationPending).toBe(true);
        await bApi.pair({ code: "code" });
        expect(kv.has("relay-revocation")).toBe(false);
        const fixture = seedThreadFixture({ deps: { db: dbB, hub } });
        insertRelayTarget(dbB, {
          createdByUserId: "user_a",
          hostId: fixture.host.id,
          threadId: fixture.thread.id,
        });
        failClear.on = false;
        await vi.advanceTimersByTimeAsync(90_000);
        expect(getConnectBinding(dbB)?.serverId).toBe("srv_a");
        expect(
          getRelayTarget(dbB, fixture.host.id, fixture.thread.id),
        ).not.toBeNull();
        expect(aApi.status().relayRevocationPending).toBe(false);
      } finally {
        a.tunnel.stop();
        b.tunnel.stop();
        await a.fakeHost.harness.dispose();
        await b.fakeHost.harness.dispose();
      }
    });

    it("fails pair when the superseded record cannot be forgotten, so it cannot later clear the new binding", async () => {
      vi.useFakeTimers();
      stubRedeem();
      const { dbA, hub } = sharedDbs();
      class FlakyKv extends Map<string, unknown> {
        failDelete = false;
        override delete(key: string): boolean {
          if (this.failDelete && key === "relay-revocation") {
            throw new Error("kv unavailable");
          }
          return super.delete(key);
        }
      }
      const kv = new FlakyKv();
      const failClear = { on: false };
      const { fakeHost, tunnel } = await kvTunnel(dbA, hub, kv, failClear);
      const api = tunnel as never as FullTunnel;
      try {
        await api.pair({ code: "code" });
        failClear.on = true;
        expect((await api.disconnect()).relayRevocationPending).toBe(true);
        failClear.on = false;
        kv.failDelete = true;
        await expect(api.pair({ code: "code" })).rejects.toThrow(
          "kv unavailable",
        );
        expect(kv.has("credential")).toBe(false);
        kv.failDelete = false;
        await api.pair({ code: "code" });
        expect(kv.has("relay-revocation")).toBe(false);
        const fixture = seedThreadFixture({ deps: { db: dbA, hub } });
        insertRelayTarget(dbA, {
          createdByUserId: "user_a",
          hostId: fixture.host.id,
          threadId: fixture.thread.id,
        });
        await vi.advanceTimersByTimeAsync(90_000);
        expect(getConnectBinding(dbA)?.serverId).toBe("srv_a");
        expect(
          getRelayTarget(dbA, fixture.host.id, fixture.thread.id),
        ).not.toBeNull();
      } finally {
        tunnel.stop();
        await fakeHost.harness.dispose();
      }
    });

    it("reports a conflict, not a pending revocation, when disconnect meets a foreign binding", async () => {
      stubRedeem();
      const { dbA, dbB, hub } = sharedDbs();
      const kv = new Map<string, unknown>();
      const { fakeHost, tunnel } = await kvTunnel(dbA, hub, kv, {
        on: false,
      });
      const api = tunnel as never as FullTunnel;
      try {
        await api.pair({ code: "code" });
        const fixture = bindB(dbB, hub);
        const before = getConnectBinding(dbB)!;
        const status = await api.disconnect();
        expect(status.relayConflict).toBe(true);
        expect(status.relayRevocationPending).toBe(false);
        expect(kv.has("relay-revocation")).toBe(false);
        expect(getConnectBinding(dbB)).toEqual(before);
        expect(
          getRelayTarget(dbB, fixture.host.id, fixture.thread.id),
        ).not.toBeNull();
      } finally {
        tunnel.stop();
        await fakeHost.harness.dispose();
      }
    });

    it("still clears A's own binding on its own pair-write failure and disconnect", async () => {
      stubRedeem();
      const { dbA, hub } = sharedDbs();
      let failing = true;
      const { fakeHost, tunnel } = await tunnelWithWrite(dbA, hub, async () => {
        if (failing) throw new Error("write failed");
      });
      const api = tunnel as never as {
        pair(args: { code: string }): Promise<unknown>;
        disconnect(): Promise<unknown>;
      };
      try {
        await expect(api.pair({ code: "code" })).rejects.toThrow(
          "write failed",
        );
        expect(getConnectBinding(dbA)).toBeNull();
        failing = false;
        await api.pair({ code: "code" });
        expect(getConnectBinding(dbA)?.serverId).toBe("srv_a");
        await api.disconnect();
        expect(getConnectBinding(dbA)).toBeNull();
      } finally {
        tunnel.stop();
        await fakeHost.harness.dispose();
      }
    });
  });
});
