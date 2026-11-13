import { EventEmitter } from "node:events";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { TunnelSession } from "@bb/tunnel-client";
import { ConnectTunnelClient } from "./index.js";

const captured = vi.hoisted(() => ({
  sessions: [] as ConstructorParameters<typeof TunnelSession>[0][],
}));
vi.mock("@bb/tunnel-client", async (original) => ({
  ...(await original<typeof import("@bb/tunnel-client")>()),
  TunnelSession: class {
    constructor(options: ConstructorParameters<typeof TunnelSession>[0]) {
      captured.sessions.push(options);
    }
    start() {}
    dispose() {}
  },
}));

it("wires owner-only intercept and HTML transform on the authenticated legacy session", async () => {
  const socket = new EventEmitter();
  Object.assign(socket, { terminate() {} });
  const list = vi.fn(async () => []);
  const client = new ConnectTunnelClient({
    serverUrl: "https://server.example.test",
    hostName: "machine",
    machineCredential: "machine-credential",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    annotations: { list, change: async () => [] },
    fetchFn: async () => Response.json({ label: "machine" }),
    createWebSocket: (_url, options) => {
      expect(options.headers.authorization).toBe("Bearer machine-credential");
      return socket as WebSocket;
    },
  });
  try {
    client.replaceShareSet({ generation: 1, ports: [3000] });
    await vi.waitFor(() => expect(socket.listenerCount("open")).toBe(1));
    socket.emit("open");
    const session = captured.sessions.at(-1)!;
    const origin = "https://machine--3000.example.test";
    const meta = {
      type: "open-http" as const,
      streamId: 1,
      method: "GET",
      target: "3000",
      path: `/__bb_annotations?url=${encodeURIComponent(origin + "/page")}`,
      headers: [["x-bb-gate-auth", "session"]] as [string, string][],
      hasBody: false,
    };
    expect((await session.interceptHttp!(meta, undefined))?.status).toBe(200);
    expect(list).toHaveBeenCalledWith({ port: 3000, url: origin + "/page" });
    for (const invalid of [
      { ...meta, headers: [] },
      { ...meta, target: "3001" },
      { ...meta, path: "/__bb_annotations?url=https://other.example/page" },
    ])
      expect((await session.interceptHttp!(invalid, undefined))?.status).toBe(
        403,
      );
    expect(list).toHaveBeenCalledTimes(1);
    const html = Buffer.from("<html><body>Preview</body></html>");
    const incoming = new IncomingMessage(new Socket());
    incoming.statusCode = 200;
    incoming.rawHeaders = [
      "content-type",
      "text/html",
      "content-length",
      String(html.length),
    ];
    incoming.push(html);
    incoming.push(null);
    const transformed = await session.transformResponse!(
      { ...meta, path: "/page" },
      incoming,
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of transformed.body) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toContain("/__bb_annotations");
    client.replaceShareSet({ generation: 2, ports: [] });
    expect((await session.interceptHttp!(meta, undefined))?.status).toBe(403);
  } finally {
    client.shutdown();
  }
});

it("never opens annotation sessions for connect-next or unenrolled hosts", async () => {
  for (const options of [
    {
      serverUrl: "https://server.next.example.test",
      machineCredential: "credential",
    },
    { serverUrl: "https://server.example.test" },
  ]) {
    const createWebSocket = vi.fn();
    const client = new ConnectTunnelClient({
      ...options,
      hostName: "machine",
      createWebSocket,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      annotations: { list: async () => [], change: async () => [] },
    });
    client.replaceShareSet({ generation: 1, ports: [3000] });
    await Promise.resolve();
    expect(createWebSocket).not.toHaveBeenCalled();
    client.shutdown();
  }
});
