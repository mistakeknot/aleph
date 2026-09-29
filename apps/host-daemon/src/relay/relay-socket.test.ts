import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsPromises, {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RELAY_ATTACHMENT_MAX_BYTES,
  RELAY_REQUEST_BODY_MAX_BYTES,
} from "@bb/host-daemon-contract/relay";
import { createServerClient, type FetchFn } from "../server-client.js";
import {
  createRelayRequestHandler,
  RELAY_BUSY_RETRY_AFTER_MS,
} from "./relay-handler.js";
import {
  defaultRelayFsOps,
  startRelaySocket,
  type RelayFsOps,
  type RelaySocketProbe,
  type StartRelaySocketResult,
} from "./relay-listener.js";

const HOST_KEY = "hk_fixture_0123456789abcdef";
const HOST_ID = "host-1";
const ULID = "01J8Z3Q4V5W6X7Y8Z9A0B1C2D3";
const THREAD_ID = "thr_target1";
const SOCKET_UID = process.getuid?.() ?? 0;

interface ReplyResult {
  status: number;
  body: unknown;
}

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
}

type TestLogger = ReturnType<typeof createLogger>;

function serializeLogs(logger: TestLogger): string {
  return JSON.stringify([
    logger.debug.mock.calls,
    logger.error.mock.calls,
    logger.info.mock.calls,
    logger.warn.mock.calls,
  ]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function attachmentFor(bytes: Buffer, filename = "note.txt") {
  return {
    filename,
    mimeType: "text/plain",
    contentBase64: bytes.toString("base64"),
    sha256: sha256(bytes),
  };
}

function tellBody(overrides: Record<string, unknown> = {}) {
  return {
    clientMessageId: ULID,
    threadId: THREAD_ID,
    text: "hello",
    ...overrides,
  };
}

const OK_TELL = {
  status: "accepted",
  clientMessageId: ULID,
  threadId: THREAD_ID,
  queuedMessageId: "qm_1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function requestSocket(
  socketPath: string,
  args: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  },
): Promise<ReplyResult> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        method: args.method ?? "GET",
        path: args.path,
        headers: { host: "bb-relay", ...args.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: text === "" ? null : JSON.parse(text),
          });
        });
      },
    );
    request.on("error", reject);
    request.on("socket", (socket) => {
      socket.on("error", () => undefined);
    });
    request.end(args.body);
  });
}

function postJson(socketPath: string, path: string, body: unknown) {
  return requestSocket(socketPath, {
    method: "POST",
    path,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function errorOf(result: ReplyResult) {
  return (
    result.body as {
      error: { code: string; retryable: boolean; retryAfterMs?: number };
    }
  ).error;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function makeDataDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "bbr-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

interface FixtureOptions {
  fetchFn?: FetchFn;
  connected?: boolean;
  maxConcurrent?: number;
  forwardTimeoutMs?: number;
  dataDir?: string;
  logger?: TestLogger;
}

async function startFixture(options: FixtureOptions = {}) {
  const dataDir = options.dataDir ?? (await makeDataDir());
  const logger = options.logger ?? createLogger();
  const fetchFn =
    options.fetchFn ?? vi.fn<FetchFn>(async () => jsonResponse(OK_TELL));
  const client = createServerClient({
    fetchFn,
    getSessionId: () => "session-1",
    hostKey: HOST_KEY,
    logger,
    serverUrl: "http://server.test",
  });
  const result = await startRelaySocket({
    dataDir,
    hostId: HOST_ID,
    logger,
    handler: createRelayRequestHandler({
      hostId: HOST_ID,
      logger,
      isConnected: () => options.connected ?? true,
      client,
      ...(options.maxConcurrent === undefined
        ? {}
        : { maxConcurrent: options.maxConcurrent }),
      ...(options.forwardTimeoutMs === undefined
        ? {}
        : { forwardTimeoutMs: options.forwardTimeoutMs }),
    }),
  });
  if (!result.started) {
    throw new Error(`relay did not start: ${result.reason}`);
  }
  cleanups.push(() => result.close());
  return { dataDir, socketPath: result.socketPath, fetchFn, logger };
}

async function startRefusing(args: {
  dataDir: string;
  fs?: RelayFsOps;
  probeSocket?: RelaySocketProbe;
  uid?: number;
  xdgRuntimeDir?: string;
  afterDirectoryChecked?: () => Promise<void>;
}): Promise<Extract<StartRelaySocketResult, { started: false }>> {
  const result = await startRelaySocket({
    dataDir: args.dataDir,
    hostId: HOST_ID,
    logger: createLogger(),
    handler: () => undefined,
    ...(args.fs === undefined ? {} : { fs: args.fs }),
    ...(args.probeSocket === undefined
      ? {}
      : { probeSocket: args.probeSocket }),
    ...(args.uid === undefined ? {} : { uid: args.uid }),
    ...(args.xdgRuntimeDir === undefined
      ? {}
      : { xdgRuntimeDir: args.xdgRuntimeDir }),
    ...(args.afterDirectoryChecked === undefined
      ? {}
      : { afterDirectoryChecked: args.afterDirectoryChecked }),
  });
  if (result.started) {
    cleanups.push(() => result.close());
    throw new Error("expected relay to refuse");
  }
  return result;
}

async function modeOf(target: string): Promise<number> {
  return (await lstat(target)).mode & 0o777;
}

describe("T-SOCK-1 socket and directory permissions", () => {
  it("creates the socket 0600 in a 0700 directory and writes discovery", async () => {
    const { dataDir, socketPath } = await startFixture();

    expect(await modeOf(path.dirname(socketPath))).toBe(0o700);
    expect(await modeOf(socketPath)).toBe(0o600);
    expect((await lstat(socketPath)).isSocket()).toBe(true);
    const discoveryPath = path.join(dataDir, "relay.json");
    expect(await modeOf(discoveryPath)).toBe(0o600);
    expect(JSON.parse(await readFile(discoveryPath, "utf8"))).toEqual({
      relayProtocol: 1,
      socketPath,
      hostId: HOST_ID,
      instanceId: expect.any(String),
      pid: process.pid,
    });
    const status = await requestSocket(socketPath, { path: "/v1/status" });
    expect(status).toEqual({
      status: 200,
      body: { relayProtocol: 1, hostId: HOST_ID, connected: true },
    });
  });

  it("removes the socket and discovery file on close", async () => {
    const dataDir = await makeDataDir();
    const logger = createLogger();
    const result = await startRelaySocket({
      dataDir,
      hostId: HOST_ID,
      logger,
      handler: () => undefined,
    });
    if (!result.started) {
      throw new Error("expected start");
    }
    await result.close();
    expect(await lstat(result.socketPath).catch(() => null)).toBeNull();
    expect(
      await lstat(path.join(dataDir, "relay.json")).catch(() => null),
    ).toBeNull();
  });

  it("refuses a pre-created directory that other users can access", async () => {
    const dataDir = await makeDataDir();
    await mkdir(path.join(dataDir, "run"), { mode: 0o755 });
    await chmod(path.join(dataDir, "run"), 0o755);

    const result = await startRefusing({ dataDir });

    expect(result.reason).toMatch(/accessible to other users/);
    expect(
      await lstat(path.join(dataDir, "relay.json")).catch(() => null),
    ).toBeNull();
  });

  it("refuses a directory owned by another user", async () => {
    const dataDir = await makeDataDir();
    await mkdir(path.join(dataDir, "run"), { mode: 0o700 });
    const foreignOwner: RelayFsOps = {
      ...defaultRelayFsOps,
      async lstat(target) {
        const stats = await defaultRelayFsOps.lstat(target);
        return stats === null
          ? null
          : {
              ...stats,
              uid: stats.uid + 1,
              isDirectory: () => stats.isDirectory(),
              isSocket: () => stats.isSocket(),
            };
      },
    };

    const result = await startRefusing({ dataDir, fs: foreignOwner });

    expect(result.reason).toMatch(/not owned by the daemon user/);
  });

  it("refuses a directory that is a symlink", async () => {
    const dataDir = await makeDataDir();
    const elsewhere = path.join(dataDir, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await symlink(elsewhere, path.join(dataDir, "run"));

    const result = await startRefusing({ dataDir });

    expect(result.reason).toMatch(/not a real directory/);
  });
});

describe("T-SOCK-2 and T-SOCK-4 path replacement", () => {
  async function runDir(): Promise<{ dataDir: string; socket: string }> {
    const dataDir = await makeDataDir();
    await mkdir(path.join(dataDir, "run"), { mode: 0o700 });
    return { dataDir, socket: path.join(dataDir, "run", "relay.sock") };
  }

  it("does not unlink a regular file at the socket path", async () => {
    const { dataDir, socket } = await runDir();
    await writeFile(socket, "keep");

    const result = await startRefusing({ dataDir });

    expect(result.reason).toMatch(/occupied/);
    expect(await readFile(socket, "utf8")).toBe("keep");
  });

  it("does not unlink a symlink to another socket", async () => {
    const { dataDir, socket } = await runDir();
    const other = await startFixture();
    await symlink(other.socketPath, socket);

    const result = await startRefusing({ dataDir });

    expect(result.reason).toMatch(/occupied/);
    expect((await lstat(socket)).isSymbolicLink()).toBe(true);
    const status = await requestSocket(other.socketPath, {
      path: "/v1/status",
    });
    expect(status.status).toBe(200);
  });

  it("does not unlink a FIFO", async () => {
    const { dataDir, socket } = await runDir();
    execFileSync("mkfifo", [socket]);

    const result = await startRefusing({ dataDir });

    expect(result.reason).toMatch(/occupied/);
    expect((await lstat(socket)).isFIFO()).toBe(true);
  });

  it("does not unlink a socket owned by another uid", async () => {
    const { dataDir, socket } = await runDir();
    execFileSync("python3", [
      "-c",
      "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])",
      socket,
    ]);
    const foreignSocket: RelayFsOps = {
      ...defaultRelayFsOps,
      async lstat(target) {
        const stats = await defaultRelayFsOps.lstat(target);
        return stats !== null && target === socket
          ? {
              ...stats,
              uid: SOCKET_UID + 1,
              isDirectory: () => false,
              isSocket: () => true,
            }
          : stats;
      },
    };

    const result = await startRefusing({ dataDir, fs: foreignSocket });

    expect(result.reason).toMatch(/occupied/);
    expect((await lstat(socket)).isSocket()).toBe(true);
  });

  it("replaces a stale socket owned by this user", async () => {
    const { dataDir, socket } = await runDir();
    execFileSync("python3", [
      "-c",
      "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])",
      socket,
    ]);

    const { socketPath } = await startFixture({ dataDir });

    expect(socketPath).toBe(socket);
    const status = await requestSocket(socketPath, { path: "/v1/status" });
    expect(status.status).toBe(200);
  });

  it("detects the directory swapped for a symlink between the check and listen", async () => {
    const dataDir = await makeDataDir();
    const elsewhere = path.join(dataDir, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    const directory = path.join(dataDir, "run");

    const result = await startRefusing({
      dataDir,
      afterDirectoryChecked: async () => {
        await rename(directory, path.join(dataDir, "run-original"));
        await symlink(elsewhere, directory);
      },
    });

    expect(result.reason).toMatch(/not a real directory/);
    expect(
      await lstat(path.join(dataDir, "relay.json")).catch(() => null),
    ).toBeNull();
    const connection = await requestSocket(path.join(elsewhere, "relay.sock"), {
      path: "/v1/status",
    }).catch(() => "closed");
    expect(connection).toBe("closed");
  });

  it("detects the directory replaced by another real directory", async () => {
    const dataDir = await makeDataDir();
    const directory = path.join(dataDir, "run");

    const result = await startRefusing({
      dataDir,
      afterDirectoryChecked: async () => {
        await rename(directory, path.join(dataDir, "run-original"));
        await mkdir(directory, { mode: 0o700 });
      },
    });

    expect(result.reason).toMatch(/replaced while binding/);
  });
});

describe("T-SOCK-3 long data dir", () => {
  it("falls back to the runtime directory and points discovery at it", async () => {
    const base = await makeDataDir();
    const dataDir = path.join(base, "d".repeat(60), "e".repeat(60));
    await mkdir(dataDir, { recursive: true });
    const runtimeDir = await makeDataDir();
    const logger = createLogger();
    const result = await startRelaySocket({
      dataDir,
      hostId: HOST_ID,
      logger,
      handler: () => undefined,
      xdgRuntimeDir: runtimeDir,
    });
    if (!result.started) {
      throw new Error(`relay did not start: ${result.reason}`);
    }
    cleanups.push(() => result.close());

    const digest = createHash("sha256")
      .update(dataDir)
      .digest("hex")
      .slice(0, 16);
    expect(result.socketPath).toBe(
      path.join(runtimeDir, `bb-relay-${SOCKET_UID}`, `${digest}.sock`),
    );
    expect(Buffer.byteLength(result.socketPath)).toBeLessThanOrEqual(100);
    const discovery = JSON.parse(
      await readFile(path.join(dataDir, "relay.json"), "utf8"),
    );
    expect(discovery.socketPath).toBe(result.socketPath);
  });
});

describe("T-BRW-1 browser and rebinding rejection", () => {
  it.each([
    ["Origin", { origin: "https://evil.example" }],
    ["Sec-Fetch-Site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Mode", { "sec-fetch-mode": "cors" }],
    ["Referer", { referer: "https://evil.example/" }],
    ["Cookie", { cookie: "a=b" }],
  ])("rejects %s before routing", async (_name, headers) => {
    const { socketPath, fetchFn } = await startFixture();

    const result = await requestSocket(socketPath, {
      method: "POST",
      path: "/v1/tell",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(tellBody()),
    });

    expect(result.status).toBe(403);
    expect(errorOf(result).code).toBe("browser_request_forbidden");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a wrong Host header, even for an unknown path", async () => {
    const { socketPath } = await startFixture();

    const known = await requestSocket(socketPath, {
      path: "/v1/status",
      headers: { host: "localhost:3000" },
    });
    const unknown = await requestSocket(socketPath, {
      path: "/nope",
      headers: { host: "evil.example" },
    });

    expect(known.status).toBe(403);
    expect(unknown.status).toBe(403);
  });

  it("rejects non-JSON POSTs with 415 and does not forward", async () => {
    const { socketPath, fetchFn } = await startFixture();

    const missing = await requestSocket(socketPath, {
      method: "POST",
      path: "/v1/tell",
      body: JSON.stringify(tellBody()),
    });
    const text = await requestSocket(socketPath, {
      method: "POST",
      path: "/v1/tell",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify(tellBody()),
    });
    const form = await requestSocket(socketPath, {
      method: "POST",
      path: "/v1/targets/remove",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "threadId=x",
    });

    expect([missing.status, text.status, form.status]).toEqual([415, 415, 415]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns 404 for unknown paths and 405 for wrong methods", async () => {
    const { socketPath } = await startFixture();

    expect((await requestSocket(socketPath, { path: "/relay" })).status).toBe(
      404,
    );
    expect((await requestSocket(socketPath, { path: "/v1/tell" })).status).toBe(
      405,
    );
    expect(
      (
        await requestSocket(socketPath, {
          path: "/v1/__proto__",
        })
      ).status,
    ).toBe(404);
  });
});

describe("tell forwarding and error mapping", () => {
  it("forwards the validated request to /internal/relay/tell with the host key", async () => {
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(OK_TELL));
    const { socketPath } = await startFixture({ fetchFn });
    const body = tellBody({
      label: "after-them-feedback",
      attachments: [attachmentFor(Buffer.from("payload"))],
    });

    const result = await postJson(socketPath, "/v1/tell", body);

    expect(result).toEqual({ status: 200, body: OK_TELL });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://server.test/internal/relay/tell");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect((init?.headers as Record<string, string>).authorization).toBe(
      `Bearer ${HOST_KEY}`,
    );
  });

  it("rejects unknown and forbidden fields without forwarding", async () => {
    const { socketPath, fetchFn } = await startFixture();

    for (const extra of [
      { senderThreadId: "thr_x" },
      { model: "x" },
      { hostId: "host-2" },
      { path: "/etc/passwd" },
    ]) {
      const result = await postJson(socketPath, "/v1/tell", tellBody(extra));
      expect(result.status).toBe(400);
      expect(errorOf(result).code).toBe("invalid_request");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON", async () => {
    const { socketPath, fetchFn } = await startFixture();

    const result = await postJson(socketPath, "/v1/tell", "{not json");

    expect(result.status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports daemon_disconnected without forwarding when the session is closed", async () => {
    const { socketPath, fetchFn } = await startFixture({ connected: false });

    const tell = await postJson(socketPath, "/v1/tell", tellBody());
    const status = await requestSocket(socketPath, { path: "/v1/status" });

    expect(tell.status).toBe(503);
    expect(errorOf(tell)).toMatchObject({
      code: "daemon_disconnected",
      retryable: true,
    });
    expect(status.body).toMatchObject({ connected: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("passes relay error codes, status and retryAfterMs through", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(
        {
          error: {
            code: "rate_limited",
            message: "slow down",
            retryable: true,
            retryAfterMs: 4000,
          },
        },
        429,
      ),
    );
    const { socketPath } = await startFixture({ fetchFn });

    const result = await postJson(socketPath, "/v1/tell", tellBody());

    expect(result.status).toBe(429);
    expect(errorOf(result)).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 4000,
    });
  });

  it.each([
    ["target_not_allowed", 403, false],
    ["idempotency_conflict", 409, false],
    ["message_expired", 400, false],
    ["relay_in_progress", 409, true],
  ])("maps server %s to status %i", async (code, status, retryable) => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse({ error: { code, message: "m", retryable } }, status),
    );
    const { socketPath } = await startFixture({ fetchFn });

    const result = await postJson(socketPath, "/v1/tell", tellBody());

    expect(result.status).toBe(status);
    expect(errorOf(result)).toMatchObject({ code, retryable });
  });

  it("maps a network error and a timeout to server_unreachable", async () => {
    const network = vi.fn<FetchFn>(async () => {
      throw new TypeError("fetch failed");
    });
    const first = await startFixture({ fetchFn: network });
    const networkResult = await postJson(
      first.socketPath,
      "/v1/tell",
      tellBody(),
    );

    const hanging = vi.fn<FetchFn>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
    const second = await startFixture({
      fetchFn: hanging,
      forwardTimeoutMs: 30,
    });
    const timeoutResult = await postJson(
      second.socketPath,
      "/v1/tell",
      tellBody(),
    );

    for (const result of [networkResult, timeoutResult]) {
      expect(result.status).toBe(503);
      expect(errorOf(result)).toMatchObject({
        code: "server_unreachable",
        retryable: true,
      });
    }
  });

  it("maps other server failures", async () => {
    const cases: Array<[Response, number, string, boolean]> = [
      [
        jsonResponse({ code: "boom", message: "x" }, 500),
        500,
        "internal_error",
        true,
      ],
      [new Response("gateway", { status: 502 }), 502, "internal_error", true],
      [
        new Response("missing", { status: 404 }),
        503,
        "server_unreachable",
        true,
      ],
      [
        jsonResponse({ code: "weird", message: "x" }, 400),
        502,
        "internal_error",
        false,
      ],
      [jsonResponse({ nonsense: true }, 200), 502, "internal_error", true],
    ];
    for (const [response, status, code, retryable] of cases) {
      const fetchFn = vi.fn<FetchFn>(async () => response);
      const { socketPath } = await startFixture({ fetchFn });

      const result = await postJson(socketPath, "/v1/tell", tellBody());

      expect(result.status).toBe(status);
      expect(errorOf(result)).toMatchObject({ code, retryable });
    }
  });
});

describe("T-REV-1 revoked host key (daemon half)", () => {
  it("maps 401 to host_revoked, retryable, on every attempt and does not cache it", async () => {
    let revoked = true;
    const fetchFn = vi.fn<FetchFn>(async () =>
      revoked
        ? jsonResponse({ code: "unauthorized", message: "bad key" }, 401)
        : jsonResponse(OK_TELL),
    );
    const { socketPath } = await startFixture({ fetchFn });

    const first = await postJson(socketPath, "/v1/tell", tellBody());
    const second = await postJson(socketPath, "/v1/tell", tellBody());
    revoked = false;
    const third = await postJson(socketPath, "/v1/tell", tellBody());

    for (const result of [first, second]) {
      expect(result.status).toBe(401);
      expect(errorOf(result)).toMatchObject({
        code: "host_revoked",
        retryable: true,
      });
    }
    expect(third.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });
});

describe("T-EMR-1 host-scoped targets forwarding (daemon half)", () => {
  it("lists targets through GET /internal/relay/targets", async () => {
    const targets = {
      targets: [{ threadId: THREAD_ID, createdAt: "2026-09-29T00:00:00.000Z" }],
    };
    const fetchFn = vi.fn<FetchFn>(async () => jsonResponse(targets));
    const { socketPath } = await startFixture({ fetchFn });

    const result = await requestSocket(socketPath, { path: "/v1/targets" });

    expect(result).toEqual({ status: 200, body: targets });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://server.test/internal/relay/targets");
    expect(init?.method).toBe("GET");
  });

  it("forwards removal of one target and of all targets", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse({ removed: 1, cancelled: 3 }),
    );
    const { socketPath } = await startFixture({ fetchFn });

    const one = await postJson(socketPath, "/v1/targets/remove", {
      threadId: THREAD_ID,
    });
    const all = await postJson(socketPath, "/v1/targets/remove", {});

    expect(one).toEqual({ status: 200, body: { removed: 1, cancelled: 3 } });
    expect(all.status).toBe(200);
    const bodies = fetchFn.mock.calls.map(([, init]) =>
      JSON.parse(String(init?.body)),
    );
    expect(bodies).toEqual([{ threadId: THREAD_ID }, {}]);
    expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
      "http://server.test/internal/relay/targets/remove",
    );
  });

  it("rejects hostId and any other field on removal, and never adds", async () => {
    const { socketPath, fetchFn } = await startFixture();

    for (const body of [
      { hostId: "host-2" },
      { threadId: THREAD_ID, add: true },
      { threadId: "" },
      { threadId: 5 },
    ]) {
      const result = await postJson(socketPath, "/v1/targets/remove", body);
      expect(result.status).toBe(400);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps a revoked key on the targets routes to host_revoked", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse({ code: "unauthorized", message: "no" }, 401),
    );
    const { socketPath } = await startFixture({ fetchFn });

    const list = await requestSocket(socketPath, { path: "/v1/targets" });
    const remove = await postJson(socketPath, "/v1/targets/remove", {});

    expect(errorOf(list).code).toBe("host_revoked");
    expect(errorOf(remove).code).toBe("host_revoked");
  });

  it("drops an unexpected server payload shape instead of relaying it", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse({
        targets: [{ threadId: "t", createdAt: "x", title: "secret" }],
      }),
    );
    const { socketPath } = await startFixture({ fetchFn });

    const result = await requestSocket(socketPath, { path: "/v1/targets" });

    expect(result.status).toBe(502);
    expect(JSON.stringify(result.body)).not.toContain("secret");
  });
});

describe("POST bodies must be non-empty JSON objects", () => {
  it.each([["/v1/tell"], ["/v1/targets/remove"]])(
    "rejects empty, whitespace and null bodies on %s",
    async (route) => {
      const { socketPath, fetchFn } = await startFixture();

      for (const body of ["", " ", "\n\t ", "null", "[]", "0", '""']) {
        const result = await requestSocket(socketPath, {
          method: "POST",
          path: route,
          headers: { "content-type": "application/json" },
          body,
        });
        expect(result.status, JSON.stringify(body)).toBe(400);
        expect(errorOf(result).code).toBe("invalid_request");
      }
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  it("accepts only an explicit empty object as remove-all", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse({ removed: 2, cancelled: 0 }),
    );
    const { socketPath } = await startFixture({ fetchFn });

    const result = await postJson(socketPath, "/v1/targets/remove", {});

    expect(result.status).toBe(200);
    expect(JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body))).toEqual({});
  });
});

describe("live socket and instance ownership", () => {
  it("refuses to take over a socket served by a live relay and leaves it intact", async () => {
    const first = await startFixture();
    const before = await lstat(first.socketPath, { bigint: true });

    const second = await startRefusing({ dataDir: first.dataDir });

    expect(second.reason).toMatch(/already served/);
    const after = await lstat(first.socketPath, { bigint: true });
    expect(after.ino).toBe(before.ino);
    const status = await requestSocket(first.socketPath, {
      path: "/v1/status",
    });
    expect(status.status).toBe(200);
    expect(
      JSON.parse(await readFile(path.join(first.dataDir, "relay.json"), "utf8"))
        .pid,
    ).toBe(process.pid);
  });

  it("refuses when liveness cannot be determined", async () => {
    const dataDir = await makeDataDir();
    const first = await startFixture({ dataDir });
    const probeSocket = vi.fn(async () => {
      throw new Error("boom");
    });

    const result = await startRefusing({ dataDir, probeSocket });

    expect(result.reason).toBe("relay socket failed to start");
    expect(probeSocket).toHaveBeenCalledTimes(1);
    expect((await lstat(first.socketPath)).isSocket()).toBe(true);
  });

  it("a refused starter does not delete the running instance's discovery file", async () => {
    const first = await startFixture();
    const discoveryPath = path.join(first.dataDir, "relay.json");
    const original = await readFile(discoveryPath, "utf8");

    await startRefusing({ dataDir: first.dataDir });

    expect(await readFile(discoveryPath, "utf8")).toBe(original);
  });

  it("close does not delete a discovery file written by another instance", async () => {
    const dataDir = await makeDataDir();
    const logger = createLogger();
    const first = await startRelaySocket({
      dataDir,
      hostId: HOST_ID,
      logger,
      handler: () => undefined,
    });
    if (!first.started) {
      throw new Error("expected start");
    }
    const discoveryPath = path.join(dataDir, "relay.json");
    const foreign = `${JSON.stringify({
      relayProtocol: 1,
      socketPath: "/elsewhere.sock",
      hostId: HOST_ID,
      instanceId: "someone-else",
      pid: 1,
    })}\n`;
    await writeFile(discoveryPath, foreign, { mode: 0o600 });

    await first.close();

    expect(await readFile(discoveryPath, "utf8")).toBe(foreign);
  });

  it("close does not delete an unparsable or foreign-owned discovery file", async () => {
    const dataDir = await makeDataDir();
    const first = await startRelaySocket({
      dataDir,
      hostId: HOST_ID,
      logger: createLogger(),
      handler: () => undefined,
    });
    if (!first.started) {
      throw new Error("expected start");
    }
    const discoveryPath = path.join(dataDir, "relay.json");
    await writeFile(discoveryPath, "not json", { mode: 0o600 });

    await first.close();

    expect(await readFile(discoveryPath, "utf8")).toBe("not json");
  });
});

describe("T-SZ-1 size limits (daemon half)", () => {
  it.each([
    ["oversize text", () => tellBody({ text: "a".repeat(32 * 1024 + 1) })],
    [
      "multibyte text over the byte cap",
      () => tellBody({ text: "é".repeat(20 * 1024) }),
    ],
    [
      "a 6 MiB attachment",
      () =>
        tellBody({
          attachments: [attachmentFor(Buffer.alloc(6 * 1024 * 1024, 1))],
        }),
    ],
    [
      "11 MiB total",
      () =>
        tellBody({
          attachments: [
            attachmentFor(Buffer.alloc(RELAY_ATTACHMENT_MAX_BYTES, 1), "a.bin"),
            attachmentFor(Buffer.alloc(RELAY_ATTACHMENT_MAX_BYTES, 2), "b.bin"),
            attachmentFor(Buffer.alloc(1024 * 1024 + 1, 3), "c.bin"),
          ],
        }),
    ],
    [
      "five attachments",
      () =>
        tellBody({
          attachments: Array.from({ length: 5 }, (_, index) =>
            attachmentFor(Buffer.from(`n${index}`), `f${index}.txt`),
          ),
        }),
    ],
  ])("rejects %s with 413 without forwarding", async (_name, build) => {
    const { socketPath, fetchFn } = await startFixture();

    const result = await postJson(socketPath, "/v1/tell", build());

    expect(result.status).toBe(413);
    expect(errorOf(result).code).toBe("payload_too_large");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a sha256 mismatch with 400", async () => {
    const { socketPath, fetchFn } = await startFixture();
    const attachment = attachmentFor(Buffer.from("real"));

    const result = await postJson(
      socketPath,
      "/v1/tell",
      tellBody({ attachments: [{ ...attachment, sha256: "0".repeat(64) }] }),
    );

    expect(result.status).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("accepts a 5 MiB attachment at the cap", async () => {
    const { socketPath, fetchFn } = await startFixture();

    const result = await postJson(
      socketPath,
      "/v1/tell",
      tellBody({
        attachments: [
          attachmentFor(Buffer.alloc(RELAY_ATTACHMENT_MAX_BYTES, 7)),
        ],
      }),
    );

    expect(result.status).toBe(200);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("rejects a request body over 16 MiB with 413", async () => {
    const { socketPath, fetchFn } = await startFixture();

    const outcome = await postJson(
      socketPath,
      "/v1/tell",
      "x".repeat(RELAY_REQUEST_BODY_MAX_BYTES + 1024),
    ).catch(() => "reset" as const);

    if (outcome !== "reset") {
      expect(outcome.status).toBe(413);
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("T-B64-1 malformed base64 (daemon half)", () => {
  const good = Buffer.from("hello world!");
  const goodB64 = good.toString("base64");
  const cases: Array<[string, string]> = [
    ["embedded newline", `${goodB64.slice(0, 4)}\n${goodB64.slice(4)}`],
    ["embedded space", `${goodB64.slice(0, 4)} ${goodB64.slice(4)}`],
    ["trailing newline", `${goodB64}\n`],
    ["url-safe dash", "ab-d"],
    ["url-safe underscore", "ab_d"],
    ["missing padding", "QQ"],
    ["length not a multiple of 4", "QUJDR"],
    ["equals in the middle", "QU=JDRA="],
    ["characters outside the alphabet", "QUJD*A=="],
    ["non-zero padding bits", "QR=="],
    ["non-zero padding bits, single pad", "QUJ="],
    ["non-ASCII", "QUJDé==="],
  ];

  it.each(cases)(
    "rejects %s with 400 before forwarding",
    async (_name, value) => {
      const { socketPath, fetchFn } = await startFixture();
      const attachment = {
        filename: "x.txt",
        mimeType: "text/plain",
        contentBase64: value,
        sha256: sha256(good),
      };

      const result = await postJson(
        socketPath,
        "/v1/tell",
        tellBody({ attachments: [attachment] }),
      );

      expect(result.status).toBe(400);
      expect(errorOf(result).code).toBe("invalid_request");
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
});

describe("concurrency cap", () => {
  it("returns 429 relay_busy for the fifth in-flight forward and recovers", async () => {
    const releases: Array<() => void> = [];
    const fetchFn = vi.fn<FetchFn>(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(jsonResponse(OK_TELL)));
        }),
    );
    const { socketPath } = await startFixture({ fetchFn });

    const inFlight = Array.from({ length: 4 }, () =>
      postJson(socketPath, "/v1/tell", tellBody()),
    );
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(4));
    const busy = await postJson(socketPath, "/v1/tell", tellBody());
    const busyTargets = await requestSocket(socketPath, {
      path: "/v1/targets",
    });
    const status = await requestSocket(socketPath, { path: "/v1/status" });

    expect(busy.status).toBe(429);
    expect(errorOf(busy)).toMatchObject({
      code: "relay_busy",
      retryable: true,
      retryAfterMs: RELAY_BUSY_RETRY_AFTER_MS,
    });
    expect(busyTargets.status).toBe(429);
    expect(status.status).toBe(200);
    for (const release of releases) {
      release();
    }
    expect(
      (await Promise.all(inFlight)).map((result) => result.status),
    ).toEqual([200, 200, 200, 200]);
    const after = postJson(socketPath, "/v1/tell", tellBody());
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(5));
    releases.at(-1)?.();
    expect((await after).status).toBe(200);
  });
});

describe("T-LOG-1 host key and authorization never logged", () => {
  it("keeps the host key and request init out of every log line", async () => {
    const logger = createLogger();
    const responses: Array<() => Promise<Response>> = [
      async () => jsonResponse(OK_TELL),
      async () =>
        jsonResponse({ code: "unauthorized", message: `bad ${HOST_KEY}` }, 401),
      async () =>
        jsonResponse({ code: "boom", message: `Bearer ${HOST_KEY}` }, 500),
      async () => {
        throw Object.assign(
          new TypeError(`fetch failed authorization: Bearer ${HOST_KEY}`),
          { cause: { headers: { authorization: `Bearer ${HOST_KEY}` } } },
        );
      },
      async () => {
        throw Object.assign(new Error(`timed out Bearer ${HOST_KEY}`), {
          name: "TimeoutError",
        });
      },
    ];
    let next = 0;
    const fetchFn = vi.fn<FetchFn>(async () => {
      const respond = responses[next];
      next += 1;
      if (respond === undefined) {
        throw new Error("unexpected extra call");
      }
      return respond();
    });
    const { socketPath } = await startFixture({ fetchFn, logger });

    const statuses: number[] = [];
    for (let index = 0; index < responses.length; index += 1) {
      statuses.push(
        (await postJson(socketPath, "/v1/tell", tellBody())).status,
      );
    }
    await requestSocket(socketPath, { path: "/v1/targets" }).catch(() => null);

    expect(statuses).toEqual([200, 401, 500, 503, 503]);
    const logged = serializeLogs(logger);
    expect(logged).not.toContain(HOST_KEY);
    expect(logged.toLowerCase()).not.toContain("authorization");
    expect(logged.toLowerCase()).not.toContain("bearer");
    expect(logged).toContain(ULID);
    expect(logged).toContain(THREAD_ID);
    expect(logger.info.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it("does not log message text or attachment bytes", async () => {
    const logger = createLogger();
    const { socketPath } = await startFixture({ logger });
    const secret = "very-secret-body-text";

    await postJson(
      socketPath,
      "/v1/tell",
      tellBody({
        text: secret,
        attachments: [attachmentFor(Buffer.from("attachment-secret"))],
      }),
    );

    const logged = serializeLogs(logger);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(
      Buffer.from("attachment-secret").toString("base64"),
    );
  });
});

describe("T-ATT-1 no filesystem read on relay input", () => {
  it("never reads files while handling a tell whose filename or text looks like a path", async () => {
    const spies = [
      vi.spyOn(fsPromises, "readFile"),
      vi.spyOn(fsPromises, "open"),
      vi.spyOn(fsPromises, "readdir"),
      vi.spyOn(fsPromises, "stat"),
      vi.spyOn(fsPromises, "lstat"),
      vi.spyOn(fsPromises, "realpath"),
    ];
    const { socketPath } = await startFixture();
    for (const spy of spies) {
      spy.mockClear();
    }

    const result = await postJson(
      socketPath,
      "/v1/tell",
      tellBody({
        text: "/etc/passwd",
        attachments: [attachmentFor(Buffer.from("x"), "..passwd")],
      }),
    );

    expect(result.status).toBe(200);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });

  it("keeps the request handler free of any fs import", async () => {
    const source = await readFile(
      path.join(import.meta.dirname, "relay-handler.ts"),
      "utf8",
    );

    expect(source).not.toMatch(/from "node:fs/);
    expect(source).not.toMatch(/from "fs/);
    expect(source).not.toMatch(/readFile|createReadStream|readdir/);
  });
});
