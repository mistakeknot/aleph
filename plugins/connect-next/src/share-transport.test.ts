import { expect, it, vi } from "vitest";
import { createServer, request } from "node:http";
import { gzipSync } from "node:zlib";
import type { FrpcSupervisorOptions } from "@bb/frp-client";
import {
  generateGateKeyPair,
  signGateAssertion,
} from "@bb/tunnel-contract/next";
import { AnnotationTunnel } from "../../../packages/connect-client/src/annotations/annotation-tunnel.js";
import { AnnotationStore } from "../../../packages/connect-client/src/annotations/annotation-store.js";
import { NextTunnel } from "./tunnel.js";
import { MachineNextTunnel } from "../../../apps/host-daemon/src/connect-next/index.js";
import type { ShareIngressOptions } from "@bb/frp-client/share-ingress";

async function setup(
  kind: "server" | "machine",
  port: number,
  open?: (
    options: ShareIngressOptions,
  ) => Promise<{ baseUrl: string; close(): Promise<void> }>,
  availability = { keys: true, machineId: true },
  trustedBaseDomain = "example.test",
) {
  const pair = await generateGateKeyPair("test");
  const values = new Map<string, unknown>();
  const store = new AnnotationStore({
    get: async <T>(key: string) => values.get(key) as T | undefined,
    set: async (key, value) => {
      values.set(key, value);
    },
  });
  const origin = `https://preview--${port}.next.example.test`;
  let supervisor!: FrpcSupervisorOptions;
  const createSupervisor = (options: FrpcSupervisorOptions) => {
    supervisor = options;
    return {
      start() {},
      stop: async () => {},
      childPid: () => null,
      proxiesChanged: async () => {},
      status: () => ({
        state: "connected" as const,
        lastError: null,
        nextRetryAt: null,
        since: 0,
        proxies: [],
      }),
    };
  };
  const keyUrls: string[] = [];
  const fetchFn: typeof fetch = async (input) => {
    if (!String(input).includes("machine-label")) keyUrls.push(String(input));
    if (!String(input).includes("machine-label") && !availability.keys)
      throw new Error("Keys offline");
    return String(input).includes("machine-label")
      ? Response.json({
          label: "preview",
          ...(availability.machineId ? { machineId: "test" } : {}),
        })
      : Response.json({ keys: [pair.publicKey] });
  };
  const common = {
    frpDir: "/unused",
    resolveBinary: async () => "/unused",
    trustedCertificates: async () => [],
    createSupervisor,
    fetchFn,
    ...(open ? { openShareIngress: open } : {}),
  };
  const server = new NextTunnel({
    ...common,
    annotations: new AnnotationTunnel(store, () => origin),
    serverOverride: null,
    enabled: true,
    readCredential: async () => ({ serverId: "test", credential: "test" }),
    openIngress: async () => ({
      baseUrl: "http://127.0.0.1:1",
      close: async () => {},
    }),
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  const machine = new MachineNextTunnel({
    ...common,
    annotations: store,
    machineCredential: "test",
    trustedBaseDomain: () => trustedBaseDomain,
    ensureIdentity: async () => ({
      label: "preview",
      baseDomain: "example.test",
    }),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    lastShareLingerMs: 0,
  });
  const ports = (ports: number[]) =>
    kind === "server" ? server.setSharePorts(ports) : machine.setPorts(ports);
  await ports([port]);
  if (kind === "server") {
    await server.setIdentity({
      serverId: "test",
      label: "preview",
      baseUrl: "https://example.test",
    });
    await server.start();
  } else {
    machine.replaceAuthoritative({
      generation: 1,
      config: {
        domain: trustedBaseDomain.startsWith("next.")
          ? trustedBaseDomain
          : `next.${trustedBaseDomain}`,
        server: {
          protocol: "wss",
          host: `tunnel.${trustedBaseDomain.startsWith("next.") ? trustedBaseDomain.split(":")[0] : `next.${trustedBaseDomain.split(":")[0]}`}`,
          port: 443,
        },
      },
    });
    await machine.idle();
  }
  await supervisor.prepare();
  const token = (path: string, overrides = {}) =>
    signGateAssertion(pair.signingKey, {
      audience: `${kind}:test`,
      subject: "owner",
      kind: "session",
      method: "GET",
      pathAndQuery: path,
      target: String(port),
      oauth: null,
      nowSeconds: Math.floor(Date.now() / 1000),
      ...overrides,
    });
  return {
    keyUrls,
    get supervisor() {
      return supervisor;
    },
    ports,
    token,
    origin,
    stop: () => (kind === "server" ? server.stop() : machine.shutdown()),
  };
}

it.each([
  ["next.example.test", "https://example.test"],
  ["next.example.test:8443", "https://example.test:8443"],
  ["next.example.localhost:8443", "http://example.localhost:8443"],
  ["next.next.example.test", "https://next.example.test"],
])(
  "machine next enrollment %s selects account apex keys",
  async (domain, apex) => {
    vi.stubEnv("BB_CONNECT_GATE_KEYS_URL", "");
    const captured: ShareIngressOptions[] = [];
    const fixture = await setup(
      "machine",
      3000,
      async (options) => {
        captured.push(options);
        return { baseUrl: "http://127.0.0.1:41000", close: async () => {} };
      },
      undefined,
      domain,
    );
    try {
      await captured[0]!.keys();
      expect(fixture.keyUrls).toEqual([
        `${apex}/.well-known/bb-connect-gate-keys.json`,
      ]);
      expect(captured[0]!.audience).toBe("machine:test");
      expect(captured[0]!.publicOrigin).toContain(domain);
    } finally {
      await fixture.stop();
      vi.unstubAllEnvs();
    }
  },
);

for (const kind of ["server", "machine"] as const) {
  it(`${kind} production caller honors the configured key resource`, async () => {
    vi.stubEnv(
      "BB_CONNECT_GATE_KEYS_URL",
      "https://keys.example.test/custom.json",
    );
    const captured: ShareIngressOptions[] = [];
    const fixture = await setup(
      kind,
      3000,
      async (options) => {
        captured.push(options);
        return { baseUrl: "http://127.0.0.1:41000", close: async () => {} };
      },
      undefined,
      "next.example.test",
    );
    try {
      await captured[0]!.keys();
      expect(fixture.keyUrls).toEqual([
        "https://keys.example.test/custom.json",
      ]);
    } finally {
      await fixture.stop();
      vi.unstubAllEnvs();
    }
  });
  it(`${kind} production FRP registration uses an ingress and revokes it`, async () => {
    const captured: ShareIngressOptions[] = [];
    const close = vi.fn(async () => {});
    const fixture = await setup(kind, 3000, async (options) => {
      captured.push(options);
      return { baseUrl: "http://127.0.0.1:41000", close };
    });
    try {
      expect(
        fixture.supervisor
          .proxies()
          .find((proxy) => proxy.name === "share-3000"),
      ).toMatchObject({ localPort: 41000, hostHeaderRewrite: null });
      expect(captured[0]?.audience).toBe(`${kind}:test`);
      await captured[0]!.keys();
      expect(fixture.keyUrls).toEqual([
        "https://example.test/.well-known/bb-connect-gate-keys.json",
      ]);
      expect(captured[0]?.registered()).toBe(true);
      await fixture.ports([]);
      expect(captured[0]?.registered()).toBe(false);
      expect(close).toHaveBeenCalledOnce();
      expect(
        fixture.supervisor
          .proxies()
          .some((proxy) => proxy.name === "share-3000"),
      ).toBe(false);
      await fixture.ports([3000]);
      await fixture.supervisor.prepare();
      await fixture.stop();
      expect(captured.at(-1)?.registered()).toBe(false);
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      await fixture.stop();
    }
  });

  it(`${kind} production socket ingress authenticates HTML and notes and closes on revocation`, async () => {
    const html = '<html><body><button id="save">Save</button></body></html>';
    const preview = createServer((req, res) => {
      if (req.url === "/compressed") {
        const body = gzipSync(html);
        res.writeHead(200, {
          "content-type": "text/html",
          "content-encoding": "gzip",
          "content-length": body.length,
        });
        res.end(body);
        return;
      }
      if (req.url === "/stream") {
        res.writeHead(200, { "content-type": "text/html" });
        res.write(html.slice(0, 12));
        res.end(html.slice(12));
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html",
        "content-length": Buffer.byteLength(html),
        "content-security-policy": "script-src 'nonce-test'",
      });
      res.end(html);
    });
    preview.on("upgrade", (_req, socket, head) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
      if (head.length) socket.write(head);
      socket.pipe(socket);
    });
    await new Promise<void>((resolve) =>
      preview.listen(0, "127.0.0.1", resolve),
    );
    const address = preview.address();
    if (!address || typeof address === "string") throw new Error("No preview");
    const availability = { keys: false, machineId: kind !== "machine" };
    const fixture = await setup(kind, address.port, undefined, availability);
    const proxy = fixture.supervisor
      .proxies()
      .find((proxy) => proxy.name === `share-${address.port}`)!;
    const base = `http://127.0.0.1:${proxy.localPort}`;
    const get = async (path: string, overrides = {}) =>
      fetch(base + path, {
        headers: {
          "x-bb-gate-assertion": await fixture.token(path, overrides),
          "x-bb-gate-auth": "session",
        },
      });
    try {
      expect(proxy.localPort).not.toBe(address.port);
      const plain = await get("/");
      expect(plain.status).toBe(200);
      expect(await plain.text()).toBe(html);
      expect(
        (
          await get(
            "/__bb_annotations?url=" + encodeURIComponent(fixture.origin),
          )
        ).status,
      ).toBe(403);
      availability.machineId = true;
      await fixture.supervisor.prepare();
      expect(await (await get("/")).text()).toBe(html);
      availability.keys = true;
      const now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now + 6000);
      const owner = await get("/");
      expect(owner.headers.get("content-security-policy")).toBe(
        "script-src 'nonce-test'",
      );
      expect(await owner.text()).toContain("__bb_annotations");
      vi.restoreAllMocks();
      for (const auth of ["public", "machine", "oauth"]) {
        const response = await get("/", {
          kind: auth,
          ...(auth === "oauth"
            ? {
                oauth: {
                  scope: "read",
                  grantId: "grant",
                  clientName: "client",
                },
              }
            : {}),
        });
        expect(await response.text()).toBe(html);
      }
      for (const path of ["/compressed", "/stream"])
        expect(await (await get(path)).text()).toBe(html);
      const websocketToken = await fixture.token("/socket?q=1");
      await new Promise<void>((resolve, reject) => {
        const upgrade = request(base + "/socket?q=1", {
          headers: {
            connection: "Upgrade",
            upgrade: "websocket",
            "x-bb-gate-assertion": websocketToken,
          },
        });
        upgrade.on("error", reject);
        upgrade.on("response", () => reject(new Error("Upgrade refused")));
        upgrade.on("upgrade", (_response, socket) => {
          socket.on("error", reject);
          socket.once("data", (data) => {
            try {
              expect(data.toString()).toBe("echo");
              socket.destroy();
              resolve();
            } catch (error) {
              reject(error);
            }
          });
          socket.write("echo");
        });
        upgrade.end();
      });
      const notes = `/__bb_annotations?url=${encodeURIComponent(fixture.origin + "/")}`;
      expect((await get(notes)).status).toBe(200);
      const page = fixture.origin + "/";
      const annotation = {
        id: "note",
        number: 1,
        url: page,
        title: "Preview",
        comment: "Move this",
        viewport: { width: 800, height: 600 },
        element: {
          tagName: "button",
          name: "Save",
          selector: "#save",
          text: "Save",
          attributes: {},
          styles: {},
          rect: { x: 0, y: 0, width: 10, height: 10 },
        },
      };
      const mutation = await fetch(base + notes, {
        method: "POST",
        headers: {
          "x-bb-gate-assertion": await fixture.token(notes, { method: "POST" }),
          origin: `http://127.0.0.1:${address.port}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "annotation", annotation }),
      });
      expect(mutation.status).toBe(200);
      expect(await (await get(notes)).json()).toMatchObject([
        { id: "note", comment: "Move this" },
      ]);
      expect((await get(notes, { kind: "public" })).status).toBe(403);
      for (const mismatch of [
        { audience: "server:other" },
        { target: String(address.port + 1) },
        { method: "POST" },
        { pathAndQuery: "/?other=1" },
        { nowSeconds: 1 },
      ])
        expect((await get("/", mismatch)).status).toBe(401);
      expect(
        (await fetch(base, { headers: { "x-bb-gate-auth": "session" } }))
          .status,
      ).toBe(401);
      await fixture.ports([]);
      await expect(fetch(base)).rejects.toThrow();
    } finally {
      await fixture.stop();
      preview.closeAllConnections();
      vi.restoreAllMocks();
      await new Promise<void>((resolve) => preview.close(() => resolve()));
    }
  });
}
