import { createServer, request, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  GATE_ASSERTION_HEADER,
  GATE_KEYS_PATH,
  importGateKeySet,
  parseGateKeySet,
  verifyGateAssertion,
} from "@bb/tunnel-contract/next";

type Headers = [string, string][];
export interface ShareVerification {
  audience: string;
  port: number;
  keys(): Promise<ReadonlyMap<string, CryptoKey>>;
  registered(): boolean;
  nowSeconds?(): number;
}
export interface ShareIngress {
  baseUrl: string;
  close(): Promise<void>;
}
export interface ShareMeta {
  method: string;
  path: string;
  target: string;
  headers: Headers;
}
export interface ShareAnnotations {
  intercept(
    meta: ShareMeta,
    body: Buffer | undefined,
  ): Promise<{ status: number; headers: Headers; body: Buffer } | null>;
  transform(
    meta: ShareMeta,
    response: IncomingMessage,
  ): Promise<{ headers: Headers; body: AsyncIterable<Uint8Array> }>;
}
export interface ShareIngressOptions extends ShareVerification {
  publicOrigin: string;
  annotations: ShareAnnotations;
}

export async function verifyShareRequest(
  options: ShareVerification,
  method: string,
  path: string,
  headers: Headers,
) {
  if (
    !options.registered() ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  )
    return null;
  const tokens = headers.filter(
    ([name]) => name.toLowerCase() === GATE_ASSERTION_HEADER,
  );
  if (tokens.length !== 1) return null;
  const result = await verifyGateAssertion(tokens[0]![1], {
    keys: await options.keys(),
    audience: options.audience,
    method,
    pathAndQuery: path,
    nowSeconds: options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
  });
  return result.ok &&
    result.claims.target === String(options.port) &&
    options.registered()
    ? result.claims
    : null;
}

export function trustedShareKeys(
  origin: string,
  fetchFn: typeof fetch = fetch,
) {
  let keys: ReadonlyMap<string, CryptoKey> = new Map();
  let loaded = 0;
  let pending: Promise<ReadonlyMap<string, CryptoKey>> | null = null;
  return (): Promise<ReadonlyMap<string, CryptoKey>> => {
    if (Date.now() - loaded < 60000) return Promise.resolve(keys);
    return (pending ??= (async () => {
      const response = await fetchFn(new URL(GATE_KEYS_PATH, origin), {
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("Gate keys unavailable");
      const parsed = parseGateKeySet(await response.json());
      if (!parsed) throw new Error("Invalid gate keys");
      keys = await importGateKeySet(parsed);
      loaded = Date.now();
      return keys;
    })().finally(() => {
      pending = null;
    }));
  };
}

export async function openShareIngress(
  options: ShareIngressOptions,
): Promise<ShareIngress> {
  let closed = false;
  const sockets = new Set<Duplex>();
  const upstreams = new Set<ReturnType<typeof request>>();
  const raw = (incoming: IncomingMessage): Headers => {
    const entries: Headers = [];
    for (let i = 0; i < incoming.rawHeaders.length; i += 2)
      entries.push([incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!]);
    return entries;
  };
  const verified = async (incoming: IncomingMessage) => {
    if (closed) return null;
    const headers = raw(incoming);
    const method = incoming.method ?? "GET";
    const path = incoming.url ?? "/";
    const claims = await verifyShareRequest(options, method, path, headers);
    if (!claims || closed) return null;
    const preview = headers.filter(
      ([name]) =>
        !name.toLowerCase().startsWith("x-bb-gate-") &&
        !["proxy-authorization", "host"].includes(name.toLowerCase()),
    );
    const meta: ShareMeta = {
      method,
      path,
      target: String(options.port),
      headers: [
        ...preview.map(([name, value]): [string, string] => [
          name,
          name.toLowerCase() === "origin" &&
          value === `http://127.0.0.1:${options.port}`
            ? options.publicOrigin
            : value,
        ]),
        ["x-bb-gate-auth", claims.kind],
      ],
    };
    return {
      meta,
      headers: [
        ...preview,
        ["host", `127.0.0.1:${options.port}`],
      ] satisfies Headers,
    };
  };
  const proxy = (meta: ShareMeta, headers: Headers) => {
    const upstream = request({
      hostname: "127.0.0.1",
      port: options.port,
      method: meta.method,
      path: meta.path,
      headers: headers.flat(),
    });
    upstreams.add(upstream);
    upstream.once("close", () => upstreams.delete(upstream));
    return upstream;
  };
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const verifiedRequest = await verified(incoming);
      if (!verifiedRequest) {
        outgoing.writeHead(401);
        outgoing.end();
        return;
      }
      const { meta, headers } = verifiedRequest;
      if (meta.path.split("?", 1)[0] === "/__bb_annotations") {
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of incoming) {
          length += chunk.length;
          if (length > 32768) {
            outgoing.writeHead(413);
            outgoing.end();
            return;
          }
          chunks.push(Buffer.from(chunk));
        }
        if (closed || !options.registered()) {
          outgoing.writeHead(401);
          outgoing.end();
          return;
        }
        const result = await options.annotations.intercept(
          meta,
          Buffer.concat(chunks),
        );
        if (!result) {
          outgoing.writeHead(404);
          outgoing.end();
          return;
        }
        outgoing.writeHead(result.status, result.headers.flat());
        outgoing.end(result.body);
        return;
      }
      const upstream = proxy(meta, headers);
      outgoing.once("close", () => upstream.destroy());
      upstream.on("error", () => {
        if (!outgoing.headersSent) outgoing.writeHead(502);
        outgoing.end();
      });
      upstream.on("response", (response) => {
        void (async () => {
          const transformed = await options.annotations.transform(
            meta,
            response,
          );
          outgoing.writeHead(
            response.statusCode ?? 502,
            transformed.headers.flat(),
          );
          await pipeline(Readable.from(transformed.body), outgoing);
        })().catch(() => outgoing.destroy());
      });
      incoming.pipe(upstream);
    })().catch(() => {
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (incoming, socket, head) => {
    socket.on("error", () => socket.destroy());
    void (async () => {
      const result = await verified(incoming);
      if (
        !result ||
        result.meta.path.split("?", 1)[0] === "/__bb_annotations"
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const upstream = proxy(result.meta, result.headers);
      socket.once("close", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
      upstream.on("response", () => socket.destroy());
      upstream.on("upgrade", (response, target, targetHead) => {
        sockets.add(target);
        target.once("close", () => sockets.delete(target));
        target.on("error", () => socket.destroy());
        socket.once("close", () => target.destroy());
        target.once("close", () => socket.destroy());
        if (closed || !options.registered()) {
          target.destroy();
          socket.destroy();
          return;
        }
        socket.write(
          `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n${raw(
            response,
          )
            .map(([k, v]) => `${k}: ${v}\r\n`)
            .join("")}\r\n`,
        );
        if (targetHead.length) socket.write(targetHead);
        if (head.length) target.write(head);
        target.pipe(socket);
        socket.pipe(target);
      });
      upstream.end();
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Share ingress did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export class ShareIngressSet {
  private entries = new Map<number, ShareIngress>();
  private closed = false;
  private work: Promise<void> = Promise.resolve();
  constructor(private readonly open: (port: number) => Promise<ShareIngress>) {}
  get(port: number): ShareIngress | undefined {
    return this.entries.get(port);
  }
  sync(ports: readonly number[]): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.work = this.work
      .catch(() => {})
      .then(async () => {
        for (const [port, ingress] of this.entries)
          if (!ports.includes(port)) {
            this.entries.delete(port);
            await ingress.close();
          }
        for (const port of ports)
          if (!this.entries.has(port))
            this.entries.set(port, await this.open(port));
      });
    return this.work;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.work.catch(() => {});
    await Promise.all([...this.entries.values()].map((entry) => entry.close()));
    this.entries.clear();
  }
}
