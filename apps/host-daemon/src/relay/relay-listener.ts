import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { RELAY_PROTOCOL_VERSION } from "@bb/host-daemon-contract/relay";
import type { HostDaemonLogger } from "../logger.js";

const SOCKET_PATH_MAX_BYTES = 100;
const DIRECTORY_MODE = 0o700;
const SOCKET_MODE = 0o600;
const DISCOVERY_FILE_NAME = "relay.json";
const SOCKET_UMASK = 0o177;
const SERVER_REQUEST_TIMEOUT_MS = 60_000;
const SERVER_HEADERS_TIMEOUT_MS = 10_000;
const SERVER_MAX_CONNECTIONS = 64;

export interface RelayStat {
  uid: number;
  mode: number;
  dev: bigint;
  ino: bigint;
  isDirectory(): boolean;
  isSocket(): boolean;
}

export interface RelayFsOps {
  lstat(path: string): Promise<RelayStat | null>;
  mkdir(path: string): Promise<"created" | "exists">;
  unlink(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  writeExclusive(path: string, data: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
  readText(path: string): Promise<string | null>;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

export const defaultRelayFsOps: RelayFsOps = {
  async lstat(path) {
    try {
      const stats = await lstat(path, { bigint: true });
      return {
        uid: Number(stats.uid),
        mode: Number(stats.mode),
        dev: stats.dev,
        ino: stats.ino,
        isDirectory: () => stats.isDirectory(),
        isSocket: () => stats.isSocket(),
      };
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  },
  async mkdir(path) {
    try {
      await mkdir(path, { mode: DIRECTORY_MODE });
      return "created";
    } catch (error) {
      if (isErrnoCode(error, "EEXIST")) {
        return "exists";
      }
      throw error;
    }
  },
  unlink: (path) => unlink(path),
  chmod: (path, mode) => chmod(path, mode),
  rename: (from, to) => rename(from, to),
  writeExclusive: (path, data, mode) =>
    writeFile(path, data, { mode, flag: "wx" }),
  remove: (path) => rm(path, { force: true }),
  async readText(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  },
};

const SOCKET_PROBE_TIMEOUT_MS = 1000;

export type RelaySocketProbe = (
  socketPath: string,
) => Promise<"live" | "stale">;

export const probeRelaySocket: RelaySocketProbe = (socketPath) =>
  new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new RelayRefusal("relay socket did not answer the liveness probe"),
      );
    }, SOCKET_PROBE_TIMEOUT_MS);
    const finish = (result: "live" | "stale" | Error) => {
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) {
        reject(result);
      } else {
        resolve(result);
      }
    };
    socket.once("connect", () => finish("live"));
    socket.once("error", (error) => {
      if (isErrnoCode(error, "ECONNREFUSED") || isErrnoCode(error, "ENOENT")) {
        finish("stale");
        return;
      }
      finish(new RelayRefusal("relay socket liveness could not be determined"));
    });
  });

export interface RelaySocketLocation {
  directory: string;
  socketPath: string;
}

export function resolveRelaySocketLocation(args: {
  dataDir: string;
  uid: number;
  xdgRuntimeDir: string | undefined;
}): RelaySocketLocation {
  const primaryDirectory = join(args.dataDir, "run");
  const primarySocket = join(primaryDirectory, "relay.sock");
  if (Buffer.byteLength(primarySocket) <= SOCKET_PATH_MAX_BYTES) {
    return { directory: primaryDirectory, socketPath: primarySocket };
  }
  const base =
    args.xdgRuntimeDir !== undefined && args.xdgRuntimeDir !== ""
      ? args.xdgRuntimeDir
      : "/tmp";
  const digest = createHash("sha256")
    .update(args.dataDir)
    .digest("hex")
    .slice(0, 16);
  const directory = join(base, `bb-relay-${args.uid}`);
  return { directory, socketPath: join(directory, `${digest}.sock`) };
}

export interface StartRelaySocketOptions {
  dataDir: string;
  hostId: string;
  logger: HostDaemonLogger;
  handler: (request: IncomingMessage, response: ServerResponse) => void;
  platform?: NodeJS.Platform;
  uid?: number;
  xdgRuntimeDir?: string;
  fs?: RelayFsOps;
  probeSocket?: RelaySocketProbe;
  afterDirectoryChecked?: () => Promise<void>;
}

export type StartRelaySocketResult =
  | { started: true; socketPath: string; close(): Promise<void> }
  | { started: false; reason: string };

class RelayRefusal extends Error {}

function refuse(reason: string): never {
  throw new RelayRefusal(reason);
}

function verifyDirectory(stats: RelayStat | null, uid: number): RelayStat {
  if (stats === null) {
    return refuse("relay directory is missing");
  }
  if (!stats.isDirectory()) {
    return refuse("relay directory is not a real directory");
  }
  if (stats.uid !== uid) {
    return refuse("relay directory is not owned by the daemon user");
  }
  if ((stats.mode & 0o077) !== 0) {
    return refuse("relay directory is accessible to other users");
  }
  return stats;
}

function sameInode(left: RelayStat, right: RelayStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function prepareDirectory(
  fs: RelayFsOps,
  directory: string,
  uid: number,
): Promise<RelayStat> {
  await fs.mkdir(directory);
  return verifyDirectory(await fs.lstat(directory), uid);
}

async function clearStaleSocket(
  fs: RelayFsOps,
  socketPath: string,
  uid: number,
  probe: RelaySocketProbe,
): Promise<void> {
  const existing = await fs.lstat(socketPath);
  if (existing === null) {
    return;
  }
  if (!existing.isSocket() || existing.uid !== uid) {
    refuse("relay socket path is occupied by something other than our socket");
  }
  if ((await probe(socketPath)) === "live") {
    refuse("relay socket is already served by a running daemon");
  }
  await fs.unlink(socketPath);
}

function listenOnSocket(
  server: http.Server,
  socketPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    let previousUmask: number | null = null;
    try {
      previousUmask = process.umask(SOCKET_UMASK);
    } catch {
      previousUmask = null;
    }
    try {
      server.listen(socketPath, () => {
        server.off("error", onError);
        resolve();
      });
    } finally {
      if (previousUmask !== null) {
        process.umask(previousUmask);
      }
    }
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

async function verifyBoundSocket(args: {
  fs: RelayFsOps;
  directory: string;
  directoryBefore: RelayStat;
  socketPath: string;
  uid: number;
}): Promise<void> {
  const { fs } = args;
  const directoryAfter = verifyDirectory(
    await fs.lstat(args.directory),
    args.uid,
  );
  if (!sameInode(args.directoryBefore, directoryAfter)) {
    refuse("relay directory was replaced while binding");
  }
  const bound = await fs.lstat(args.socketPath);
  if (bound === null || !bound.isSocket() || bound.uid !== args.uid) {
    refuse("relay socket is not the socket this daemon created");
  }
  await fs.chmod(args.socketPath, SOCKET_MODE);
  const final = await fs.lstat(args.socketPath);
  if (
    final === null ||
    !final.isSocket() ||
    final.uid !== args.uid ||
    !sameInode(bound, final) ||
    (final.mode & 0o777) !== SOCKET_MODE
  ) {
    refuse("relay socket has unexpected ownership or mode after binding");
  }
  const directoryFinal = verifyDirectory(
    await fs.lstat(args.directory),
    args.uid,
  );
  if (!sameInode(args.directoryBefore, directoryFinal)) {
    refuse("relay directory was replaced while binding");
  }
}

async function removeOwnDiscoveryFile(
  fs: RelayFsOps,
  dataDir: string,
  instanceId: string,
): Promise<void> {
  const finalPath = join(dataDir, DISCOVERY_FILE_NAME);
  const text = await fs.readText(finalPath).catch(() => null);
  if (text === null) {
    return;
  }
  let recorded: unknown;
  try {
    recorded = JSON.parse(text);
  } catch {
    return;
  }
  if (
    typeof recorded === "object" &&
    recorded !== null &&
    "instanceId" in recorded &&
    recorded.instanceId === instanceId
  ) {
    await fs.remove(finalPath).catch(() => undefined);
  }
}

async function writeDiscoveryFile(args: {
  fs: RelayFsOps;
  dataDir: string;
  socketPath: string;
  hostId: string;
  instanceId: string;
}): Promise<string> {
  const finalPath = join(args.dataDir, DISCOVERY_FILE_NAME);
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  await args.fs.remove(tempPath);
  await args.fs.writeExclusive(
    tempPath,
    `${JSON.stringify({
      relayProtocol: RELAY_PROTOCOL_VERSION,
      socketPath: args.socketPath,
      hostId: args.hostId,
      instanceId: args.instanceId,
      pid: process.pid,
    })}\n`,
    SOCKET_MODE,
  );
  await args.fs.rename(tempPath, finalPath);
  return finalPath;
}

export async function startRelaySocket(
  options: StartRelaySocketOptions,
): Promise<StartRelaySocketResult> {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    options.logger.info(
      { code: "relay_unsupported_platform" },
      "Relay socket is not supported on this platform",
    );
    return { started: false, reason: "relay_unsupported_platform" };
  }
  const fs = options.fs ?? defaultRelayFsOps;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) {
    return { started: false, reason: "relay_unsupported_platform" };
  }
  const location = resolveRelaySocketLocation({
    dataDir: options.dataDir,
    uid,
    xdgRuntimeDir: options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR,
  });
  const instanceId = randomUUID();
  const server = http.createServer(options.handler);
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.maxConnections = SERVER_MAX_CONNECTIONS;
  server.on("connection", (socket) => {
    socket.on("error", () => socket.destroy());
  });

  try {
    const directoryBefore = await prepareDirectory(fs, location.directory, uid);
    await clearStaleSocket(
      fs,
      location.socketPath,
      uid,
      options.probeSocket ?? probeRelaySocket,
    );
    await options.afterDirectoryChecked?.();
    await listenOnSocket(server, location.socketPath);
    await verifyBoundSocket({
      fs,
      directory: location.directory,
      directoryBefore,
      socketPath: location.socketPath,
      uid,
    });
    await writeDiscoveryFile({
      fs,
      dataDir: options.dataDir,
      socketPath: location.socketPath,
      hostId: options.hostId,
      instanceId,
    });
    options.logger.info(
      { socketPath: location.socketPath },
      "Relay socket listening",
    );
    return {
      started: true,
      socketPath: location.socketPath,
      async close() {
        await closeServer(server);
        await removeOwnDiscoveryFile(fs, options.dataDir, instanceId);
      },
    };
  } catch (error) {
    await closeServer(server);
    await removeOwnDiscoveryFile(fs, options.dataDir, instanceId);
    const reason =
      error instanceof RelayRefusal
        ? error.message
        : "relay socket failed to start";
    options.logger.warn(
      { reason },
      "Relay socket refused to start; the rest of the daemon keeps running",
    );
    return { started: false, reason };
  }
}
