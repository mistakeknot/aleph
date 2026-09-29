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
});
