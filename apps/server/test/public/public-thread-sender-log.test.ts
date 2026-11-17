import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { handleDaemonSocketClosed } from "../../src/internal/session-owner-side-effects.js";
import { markTunnelIngressRequest } from "../../src/request-context.js";
import {
  SENDER_LOG_FILE_NAME,
  readSenderRecord,
} from "../../src/services/threads/sender-record.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const noPluginCaller = () => ({ ok: false as const });

function readLog(harness: TestAppHarness): Record<string, unknown>[] {
  const file = join(harness.config.dataDir, "sender-log", SENDER_LOG_FILE_NAME);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function seedOfflineThread(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps, {
    id: "host-sender-log",
    name: "M5",
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/sender-log",
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: "provider-sender-log",
  });
  handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
  harness.hub.cancelPendingDaemonDisconnect(session.id);
  return thread;
}

function sendBody(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    input: [{ type: "text", text, mentions: [] }],
    mode: "steer-if-active",
    model: "gpt-5",
    permissionMode: "full",
    reasoningLevel: "medium",
    serviceTier: "default",
    ...extra,
  });
}

async function classify(
  headers: Record<string, string>,
  options: { tunnel?: boolean; claimed?: string } = {},
) {
  const app = new Hono();
  app.all("*", (context) =>
    context.json(
      readSenderRecord(context, {
        claimedSenderThreadId: options.claimed,
        resolvePluginCaller: noPluginCaller,
      }),
    ),
  );
  const incoming = { socket: { remoteAddress: "127.0.0.1" } };
  if (options.tunnel) markTunnelIngressRequest(incoming);
  const response = await app.fetch(
    new Request("http://example.test/api/v1/threads/t/send", { headers }),
    { incoming },
  );
  return response.json() as Promise<Record<string, unknown>>;
}

describe("sender record classification", () => {
  it("treats a tunnelled session as a verified operator session", async () => {
    expect(
      await classify(
        { "x-bb-gate-auth": "session", "x-bb-app-surface": "web" },
        { tunnel: true },
      ),
    ).toMatchObject({
      kind: "app",
      verified: true,
      operatorSession: true,
      accessRoute: "connect",
      gateAuth: "session",
      surface: "web",
    });
  });

  it("does not trust a client-set session header on a local request", async () => {
    expect(
      await classify({
        "x-bb-gate-auth": "session",
        "x-bb-app-surface": "web",
      }),
    ).toMatchObject({
      kind: "app",
      verified: false,
      operatorSession: false,
      accessRoute: "loopback",
    });
  });

  it("keeps a claimed thread asserted, never verified", async () => {
    expect(
      await classify(
        { "x-bb-cli": "1", "x-bb-caller-thread": "thr_claimed" },
        { claimed: "thr_claimed" },
      ),
    ).toMatchObject({
      kind: "cli",
      verified: false,
      claimedSenderThreadId: "thr_claimed",
      callerThreadHeader: "thr_claimed",
    });
  });

  it("does not let a machine gate header raise trust", async () => {
    expect(
      await classify(
        { "x-bb-gate-auth": "machine", "x-bb-gate-machine-id": "m1" },
        { tunnel: true },
      ),
    ).toMatchObject({
      kind: "api",
      verified: false,
      operatorSession: false,
      accessRoute: null,
      machineId: "m1",
    });
  });

  it("records a plain request as unverified api", async () => {
    expect(await classify({})).toMatchObject({
      kind: "api",
      verified: false,
      claimedSenderThreadId: null,
      callerThreadHeader: null,
      pluginId: null,
    });
  });
});

describe("sender log on thread messages", () => {
  it("logs a direct send with a hash of the text and not the text", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedOfflineThread(harness);
      const text = "steer text that must not be logged";
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-bb-cli": "1",
            "x-bb-caller-thread": "thr_asserted",
          },
          body: sendBody(text),
        },
      );
      expect(response.status).toBe(200);
      const lines = readLog(harness);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        route: "send",
        threadId: thread.id,
        textSha256: createHash("sha256").update(text).digest("hex"),
        textLength: text.length,
        sender: {
          kind: "cli",
          verified: false,
          callerThreadHeader: "thr_asserted",
        },
      });
      const raw = readFileSync(
        join(harness.config.dataDir, "sender-log", SENDER_LOG_FILE_NAME),
        "utf8",
      );
      expect(raw).not.toContain(text);
    });
  });

  it("logs a queued message with its queued message id", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedOfflineThread(harness);
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "queued text", mentions: [] }],
          }),
        },
      );
      expect(response.status).toBe(201);
      const queued = (await readJson(response)) as { id: string };
      const lines = readLog(harness);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        route: "queue",
        threadId: thread.id,
        queuedMessageId: queued.id,
        messageSequence: null,
        sender: { kind: "api", verified: false, claimedSenderThreadId: null },
      });
    });
  });

  it("still accepts the message when the log cannot be written", async () => {
    await withTestHarness(async (harness) => {
      const thread = seedOfflineThread(harness);
      const dir = join(harness.config.dataDir, "sender-log");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, SENDER_LOG_FILE_NAME), "");
      chmodSync(join(dir, SENDER_LOG_FILE_NAME), 0o000);
      chmodSync(dir, 0o500);
      try {
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: sendBody("still sent"),
          },
        );
        expect(response.status).toBe(200);
      } finally {
        chmodSync(dir, 0o700);
        chmodSync(join(dir, SENDER_LOG_FILE_NAME), 0o600);
      }
    });
  });
});
