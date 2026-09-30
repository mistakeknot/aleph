import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CHROME_CANDIDATES = [
  process.env.BB_PERF_CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((candidate) => typeof candidate === "string" && candidate !== "");

function findPlaywrightChromium() {
  const root = join(homedir(), ".cache", "ms-playwright");
  if (!existsSync(root)) return null;
  const dir = readdirSync(root)
    .filter((name) => name.startsWith("chromium-"))
    .sort()
    .at(-1);
  if (dir === undefined) return null;
  const candidate = join(root, dir, "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : null;
}

export function resolveChromePath() {
  const found =
    CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ??
    findPlaywrightChromium();
  if (found === null || found === undefined) {
    throw new Error(
      "No Chrome/Chromium found. Set BB_PERF_CHROME to a Chrome executable.",
    );
  }
  return found;
}

export class CdpSession {
  constructor(socket, sessionId = undefined) {
    this.socket = socket;
    this.sessionId = sessionId;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    const session = new CdpSession(socket);
    socket.addEventListener("message", (event) => session.handle(event.data));
    return session;
  }

  handle(raw) {
    const message = JSON.parse(String(raw));
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (entry === undefined) return;
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    const handlers = this.listeners.get(message.method);
    if (handlers !== undefined) {
      for (const handler of [...handlers]) handler(message.params ?? {});
    }
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) ?? new Set();
    handlers.add(handler);
    this.listeners.set(method, handlers);
    return () => handlers.delete(handler);
  }

  async evaluate(expression, { awaitPromise = true } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (result.exceptionDetails !== undefined) {
      throw new Error(
        `evaluate failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

export async function launchChrome({ width = 1440, height = 900, extraArgs = [] } = {}) {
  const profileDir = mkdtempSync(join(process.env.BB_PERF_TMP ?? tmpdir(), "bb-perf-chrome-"));
  const child = spawn(
    resolveChromePath(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      `--window-size=${width},${height}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-component-update",
      "--disable-features=Translate,MediaRouter",
      "--no-sandbox",
      ...extraArgs,
      "about:blank",
    ],
    { stdio: "ignore", detached: true },
  );
  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (!existsSync(portFile)) {
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error("Chrome did not expose a DevTools port within 20s");
    }
    await delay(50);
  }
  await delay(50);
  const [port] = readFileSync(portFile, "utf8").split("\n");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((target) => target.type === "page");
  const session = await CdpSession.connect(page.webSocketDebuggerUrl);
  return {
    session,
    async close() {
      session.close();
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      await exited;
      await delay(300);
      rmSync(profileDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    },
  };
}
