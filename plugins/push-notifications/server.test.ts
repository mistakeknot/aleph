import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { EnvHttpProxyAgent } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  listPushSubscriptionsOutputSchema,
} from "./contract.js";
import {
  parseStoredNotificationLevel,
  type NotificationLevel,
} from "./preferences.js";
import { createPushNotificationsPlugin } from "./server.js";
import type {
  ExpoAlertPushMessage,
  ExpoPushMessage,
  PushSenderFetch,
} from "./sender.js";

type ThreadResponse = PluginThreadEventPayloads["thread.idle"]["thread"];
type PendingInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];

const COALESCE_MS = 10;
const EXPO_URL = "http://expo.test/push";

interface FakeExpo {
  fetch: PushSenderFetch;
  requests: ExpoPushMessage[][];
  ticketErrors: Map<string, string>;
  urls: string[];
}

function createFakeExpo(): FakeExpo {
  const requests: ExpoPushMessage[][] = [];
  const ticketErrors = new Map<string, string>();
  const urls: string[] = [];
  const fetch: PushSenderFetch = async (url, init) => {
    urls.push(url);
    expect(init.dispatcher).toBeInstanceOf(EnvHttpProxyAgent);
    const messages = JSON.parse(init.body) as ExpoPushMessage[];
    requests.push(messages);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: messages.map((message) => {
            const error = ticketErrors.get(message.to);
            return error === undefined
              ? { status: "ok", id: `ticket-${message.to}` }
              : { status: "error", details: { error } };
          }),
        }),
    };
  };
  return { fetch, requests, ticketErrors, urls };
}

function alertMessage(
  message: ExpoPushMessage | undefined,
): ExpoAlertPushMessage {
  if (message === undefined || !("title" in message)) {
    throw new Error("Expected an alert push message");
  }
  return message;
}

function pendingQuestion(threadId: string, prompt: string): PendingInteraction {
  return {
    id: `interaction-${threadId}`,
    threadId,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    expiresAt: null,
    resolvedAt: null,
    turnId: `turn-${threadId}`,
    providerId: "codex",
    providerThreadId: `provider-${threadId}`,
    providerRequestId: `request-${threadId}`,
    origin: {
      kind: "provider",
      providerId: "codex",
      providerThreadId: `provider-${threadId}`,
      providerRequestId: `request-${threadId}`,
    },
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "question-1",
          prompt,
          multiSelect: false,
          allowFreeText: true,
          required: true,
        },
      ],
    },
    resolution: null,
  };
}

interface SetupOptions {
  appUrl?: string | null;
  dismissReadNotifications?: boolean;
  expo?: FakeExpo;
  fetch?: PushSenderFetch;
  now?: () => number;
}

async function setup(options: SetupOptions = {}) {
  const expo = options.expo ?? createFakeExpo();
  const threads = new Map<string, ThreadResponse>();
  const interactions = new Map<string, PendingInteraction[]>();
  const metadata = new Map<string, Record<string, unknown>>();
  let nextId = 1;
  const listAncestors = vi.fn(
    async ({ threadIds }: { threadIds: readonly string[] }) => ({
      threads: [...new Set(threadIds)].flatMap((threadId) => {
        if (!threads.has(threadId)) return [];
        const ancestorIds: string[] = [];
        let parentId = threads.get(threadId)?.parentThreadId ?? null;
        while (parentId !== null && threads.has(parentId)) {
          ancestorIds.push(parentId);
          parentId = threads.get(parentId)?.parentThreadId ?? null;
        }
        return [{ threadId, ancestorIds }];
      }),
    }),
  );
  const fake = createFakePluginHost({
    pluginId: "push-notifications",
    ...(options.appUrl === undefined ? {} : { appUrl: options.appUrl }),
    settings: { expoPushUrl: EXPO_URL },
    sdk: {
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);
          if (!thread) throw new Error("Thread not found");
          return thread;
        },
        experimental_listAncestors: listAncestors,
        experimental_listDescendants: async ({
          threadIds,
          includeArchived = false,
          includeHidden = false,
        }) => ({
          threads: [...new Set(threadIds)].flatMap((threadId) => {
            if (!threads.has(threadId)) return [];
            const walked: ThreadResponse[] = [];
            for (let index = -1; index < walked.length; index += 1) {
              const parentId = index < 0 ? threadId : walked[index]?.id;
              for (const thread of threads.values()) {
                if (thread.parentThreadId === parentId) walked.push(thread);
              }
            }
            const descendantIds = walked
              .filter(
                (thread) =>
                  (includeArchived || thread.archivedAt === null) &&
                  (includeHidden || thread.visibility === "visible"),
              )
              .map((thread) => thread.id);
            return [{ threadId, descendantIds }];
          }),
        }),
        getPluginMetadata: async ({ threadId }) => {
          if (!threads.has(threadId)) throw new Error("Thread not found");
          return metadata.get(threadId) ?? {};
        },
        updatePluginMetadata: async ({ threadId, set, remove }) => {
          if (!threads.has(threadId)) throw new Error("Thread not found");
          const next = { ...(metadata.get(threadId) ?? {}), ...set };
          for (const key of remove ?? []) delete next[key];
          if (Object.keys(next).length === 0) metadata.delete(threadId);
          else metadata.set(threadId, next);
          return next;
        },
        experimental_listPluginMetadata: async ({ threadIds }) => ({
          threads: threadIds.flatMap((threadId) => {
            const value = metadata.get(threadId);
            return value === undefined ? [] : [{ threadId, metadata: value }];
          }),
        }),
        interactions: {
          list: async ({ threadId }) => interactions.get(threadId) ?? [],
        },
      },
    },
  });
  if (options.dismissReadNotifications !== undefined) {
    const dismissReadNotifications = options.dismissReadNotifications;
    fake.harness.sdk.stub("system.config", () => ({
      experiments: { dismissReadNotifications },
    }));
  }
  await createPushNotificationsPlugin({
    coalesceMs: COALESCE_MS,
    createId: () => `subscription-${nextId++}`,
    fetch: options.fetch ?? expo.fetch,
    ...(options.now === undefined ? {} : { now: options.now }),
  })(fake.bb);

  async function addSubscription(
    expoPushToken = "ExponentPushToken[phone]",
    deviceLabel = "Phone",
    platform: "ios" | "android" = "ios",
  ) {
    return fake.harness.behavior.callRpc("pushSubscriptions.add", {
      expoPushToken,
      platform,
      deviceLabel,
    });
  }

  function setThread(overrides: Partial<ThreadResponse> = {}) {
    const thread = makeThreadResponse({
      id: `thread-${threads.size + 1}`,
      projectId: "project-1",
      status: "idle",
      title: "Fix the flaky test",
      latestAttentionAt: 100,
      ...overrides,
    });
    threads.set(thread.id, thread);
    return thread;
  }

  const service = fake.harness.behavior.runService("push-sender");

  async function stopService() {
    service.controller.abort();
    await service.done;
  }

  async function cleanup() {
    await stopService();
    await fake.harness.lifecycle.dispose();
  }

  function storedLevel(threadId: string): NotificationLevel | null {
    return parseStoredNotificationLevel(metadata.get(threadId) ?? {});
  }

  function moveThread(threadId: string, parentThreadId: string | null) {
    const thread = threads.get(threadId);
    if (!thread) throw new Error("Thread not found");
    threads.set(threadId, { ...thread, parentThreadId });
  }

  async function setLevel(threadId: string, level: string) {
    return fake.harness.behavior.callRpc("threadNotifications.set", {
      threadId,
      level,
    });
  }

  async function getLevel(threadId: string) {
    const result = await fake.harness.behavior.runCli([
      "thread",
      threadId,
      "--json",
    ]);
    const { threadId: _threadId, ...row } = JSON.parse(result.stdout);
    if (result.exitCode !== 0) throw new Error(row.error.message);
    return row;
  }

  async function listLevels(threadIds: readonly string[]) {
    return fake.harness.behavior.callRpc("threadNotifications.list", {
      threadIds,
    });
  }

  function signals(channel: string) {
    return fake.harness.realtimeSignals.filter(
      (signal) => signal.channel === channel,
    );
  }

  return {
    ...fake,
    addSubscription,
    cleanup,
    clientSignals: () => signals(CLIENT_NOTIFICATION_CHANNEL),
    expo,
    getLevel,
    interactions,
    listAncestors,
    listLevels,
    setLevel,
    setThread,
    stopService,
    storedLevel,
    moveThread,
    threads,
  };
}

async function waitForCoalesce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, COALESCE_MS * 4));
}

describe("push subscription RPC and CLI", () => {
  it("upserts by token, redacts lists, and reports stable RPC errors", async () => {
    const host = await setup();
    try {
      await expect(host.addSubscription()).resolves.toEqual({
        id: "subscription-1",
        created: true,
      });
      await expect(
        host.addSubscription("ExponentPushToken[phone]", "New phone name"),
      ).resolves.toEqual({ id: "subscription-1", created: false });

      const listed = await host.harness.behavior.callRpc(
        "pushSubscriptions.list",
        {},
      );
      expect(listed).toEqual({
        subscriptions: [
          expect.objectContaining({
            id: "subscription-1",
            deviceLabel: "New phone name",
            tokenSuffix: "phone]",
          }),
        ],
      });
      expect(JSON.stringify(listed)).not.toContain("ExponentPushToken");

      await expect(
        host.harness.behavior.callRpc("pushSubscriptions.add", {
          expoPushToken: "token",
          platform: "windows",
          deviceLabel: "PC",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        host.harness.behavior.callRpc("pushSubscriptions.remove", {
          id: "missing",
        }),
      ).rejects.toMatchObject({
        code: "handler_error",
        message: "Push subscription not found: missing",
      });
      await expect(
        host.harness.behavior.callRpc("pushSubscriptions.remove", {
          id: "subscription-1",
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      await host.cleanup();
    }
  });

  it("provides list, add, remove, and status commands", async () => {
    const host = await setup();
    try {
      await expect(
        host.harness.behavior.runCli([
          "add",
          "--platform",
          "ios",
          "--label",
          "Phone",
          "--token",
          "ExponentPushToken[phone]",
        ]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Registered push device subscription-1",
      });
      const list = await host.harness.behavior.runCli(["list", "--json"]);
      expect(JSON.parse(list.stdout)).toEqual({
        subscriptions: [
          expect.objectContaining({
            id: "subscription-1",
            tokenSuffix: "phone]",
          }),
        ],
      });
      expect(list.stdout).not.toContain("ExponentPushToken");
      const status = await host.harness.behavior.runCli(["status", "--json"]);
      expect(JSON.parse(status.stdout)).toEqual({
        enabled: true,
        mobileEnabled: true,
        webEnabled: true,
        desktopEnabled: true,
        defaultLevel: "all",
        childLevel: "input-only",
        subscriptionCount: 1,
        relayUrl: EXPO_URL,
        lastSendOutcome: { status: "never" },
        blockerPush: expect.objectContaining({
          timeZone: "America/Los_Angeles",
          cap: 3,
        }),
      });
      await expect(
        host.harness.behavior.runCli(["remove", "subscription-1"]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Removed push device subscription-1",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("documents limits in help, validates options, and reports errors as JSON", async () => {
    const host = await setup();
    try {
      const help = (await host.harness.behavior.runCli(["add", "--help"]))
        .stdout;
      expect(help).toContain("bb push-notifications add");
      expect(help).toContain("at most 512 characters");

      const badPlatform = await host.harness.behavior.runCli([
        "add",
        "--token",
        "ExponentPushToken[watch]",
        "--platform",
        "watchos",
        "--label",
        "Watch",
      ]);
      expect(badPlatform.exitCode).toBe(1);
      expect(badPlatform.stderr).toContain(
        "invalid value 'watchos' for --platform. Expected one of: ios, android",
      );

      const guessed = await host.harness.behavior.runCli([
        "add",
        "--expo-token",
        "ExponentPushToken[tablet]",
        "--os",
        "android",
        "--device",
        "Tablet",
        "--json",
      ]);
      expect(guessed.exitCode, guessed.stderr).toBe(0);
      expect(JSON.parse(guessed.stdout)).toEqual({
        id: "subscription-1",
        created: true,
      });

      const envelope = await host.harness.behavior.runCli([
        "remove",
        "missing",
        "--json",
      ]);
      expect(envelope.exitCode).toBe(1);
      expect(JSON.parse(envelope.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "subscription_not_found",
          message: "Push subscription not found: missing",
        },
      });
      expect(envelope.stderr).toContain("Push subscription not found: missing");

      const badChannel = await host.harness.behavior.runCli(["test", "sms"]);
      expect(badChannel.exitCode).toBe(1);
      expect(badChannel.stderr).toContain("Use web or desktop");
    } finally {
      await host.cleanup();
    }
  });
});

describe("push sender", () => {
  it("counts one selected alert across devices and exposes the same RPC and CLI totals", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.addSubscription("ExponentPushToken[tablet]", "Tablet");
      const thread = host.setThread();
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Private preview",
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Private preview",
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      const counts = await host.harness.behavior.callRpc(
        "notifications.counts",
        { threadId: thread.id },
      );
      expect(counts).toMatchObject({ question: 0, "turn-end": 1, error: 0 });
      const cli = await host.harness.behavior.runCli([
        "counts",
        "--thread",
        thread.id,
        "--json",
      ]);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toEqual(counts);
      expect(JSON.stringify(counts)).not.toContain("Private preview");
      await host.harness.behavior.callRpc("notifications.send", {
        title: "Manual",
        threadId: thread.id,
      });
      expect(
        await host.harness.behavior.callRpc("notifications.counts", {
          threadId: thread.id,
        }),
      ).toEqual(counts);
    } finally {
      await host.cleanup();
    }
  });

  it("delivers even when counter storage fails", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      const thread = host.setThread();
      await host.bb.storage.kv.set(`push-count:${thread.id}`, {
        invalid: true,
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done",
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(await host.bb.storage.kv.get(`push-count:${thread.id}`)).toEqual({
        invalid: true,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("sends a root idle preview to each device and reads the relay setting at flush", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.addSubscription("ExponentPushToken[tablet]", "Tablet");
      const thread = host.setThread();

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done: the timer race is fixed.\nMore details.",
      });
      await host.harness.behavior.setSettings({
        expoPushUrl: "http://expo.test/changed",
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.urls).toEqual(["http://expo.test/changed"]);
      expect(host.expo.requests[0]).toHaveLength(2);
      expect(host.expo.requests[0]?.[0]).toMatchObject({
        title: "Fix the flaky test",
        body: "Done: the timer race is fixed. More details.",
        data: {
          kind: "turn-finished",
          projectId: "project-1",
          threadId: thread.id,
        },
        sound: "default",
        channelId: "threads",
        priority: "high",
      });
      expect(host.expo.requests[0]?.[0]?.data).not.toHaveProperty("serverUrl");
      expect(
        host.expo.requests[0]?.map((message) => message.data.subscriptionId),
      ).toEqual(["subscription-1", "subscription-2"]);
      await vi.waitFor(async () => {
        const result = await host.harness.behavior.runCli(["status", "--json"]);
        expect(JSON.parse(result.stdout).lastSendOutcome).toMatchObject({
          status: "sent",
          sentCount: 2,
        });
      });
    } finally {
      await host.cleanup();
    }
  });

  it("sends the first paragraph as plain text with thread references named", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      host.setThread({ id: "thr_aedn9u3q8i", title: "Fix scroll jumps" });
      host.setThread({
        id: "thr_23456789ab",
        title:
          "Compare bb in-app terminal against Moshi, Termius, and Blink Shell",
      });
      const thread = host.setThread({ title: "Discord Dude" });

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: [
          "## Summary",
          "",
          "@thread:thr_aedn9u3q8i fixed **[#4793](https://github.com/get-bb/bb/issues/4793)**",
          "as `9579549809`; thr_8quy6y32b5 and snake_case_name remain.",
          "Then see @thread:thr_23456789ab.",
          "",
          "Second paragraph.",
        ].join("\n"),
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]?.[0]).toMatchObject({
        title: "Discord Dude",
        body: "“Fix scroll jumps” fixed #4793 as 9579549809; thr_8quy6y32b5 and snake_case_name remain. Then see “Compare bb in-app terminal against Mosh…”.",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("skips directives, tables, and raw JSON in the preview", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      const previews = {
        Directive: [
          '::page{id="2d98aecf" version="e4d24dd2" display="inline"}',
          "",
          "Pick one icon and press Ship.",
        ],
        Table: [
          "## Result",
          "",
          "| Step | Before | After |",
          "|---|---|---|",
          "| Template | Unset | Set |",
          "The deployment did not change.",
        ],
        Json: [
          "{",
          '  "ok": true,',
          '  "enrolled": 9',
          "}",
          "",
          "All nine people are enrolled.",
        ],
        "Directive only": ['::page{id="2d98aecf" version="e4d24dd2"}'],
      };
      for (const [title, lines] of Object.entries(previews)) {
        await host.harness.behavior.emitThreadEvent("thread.idle", {
          thread: host.setThread({ title }),
          lastAssistantText: lines.join("\n"),
        });
      }

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(4));
      const bodies = Object.fromEntries(
        host.expo.requests.map((request) => [
          alertMessage(request[0]).title,
          alertMessage(request[0]).body,
        ]),
      );
      expect(bodies).toEqual({
        Directive: "Pick one icon and press Ship.",
        Table: "The deployment did not change.",
        Json: "All nine people are enrolled.",
        "Directive only": "Finished and waiting for you",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("includes the configured public server URL", async () => {
    const host = await setup({ appUrl: "https://bb.example.test" });
    try {
      await host.addSubscription();
      const thread = host.setThread();

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done",
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]?.[0]?.data).toEqual({
        subscriptionId: "subscription-1",
        kind: "turn-finished",
        projectId: "project-1",
        serverUrl: "https://bb.example.test",
        threadId: thread.id,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("drops child, read, hidden, archived, and stale-status events", async () => {
    let now = 1_000;
    const host = await setup({ now: () => now });
    try {
      await host.addSubscription();
      const child = host.setThread({ parentThreadId: "parent-1" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: child,
        lastAssistantText: "Child done",
      });

      const read = host.setThread({ id: "thread-read" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: read,
        lastAssistantText: "Read done",
      });
      host.threads.set(read.id, {
        ...read,
        latestAttentionAt: now + 1,
        lastReadAt: now + 1,
      });

      const stale = host.setThread({ id: "thread-stale" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: stale,
        lastAssistantText: "Stale done",
      });
      host.threads.set(stale.id, { ...stale, status: "active" });

      const hidden = host.setThread({ id: "thread-hidden" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: hidden,
        error: "Failed",
      });
      host.threads.set(hidden.id, {
        ...hidden,
        status: "error",
        visibility: "hidden",
      });

      const archived = host.setThread({ id: "thread-archived" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: archived,
        error: "Failed",
      });
      host.threads.set(archived.id, {
        ...archived,
        status: "error",
        archivedAt: now,
      });
      now += 2;
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.clientSignals()).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("coalesces interaction and idle events, prefers the interaction, and checks it again", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      const thread = host.setThread({ status: "active", title: "Release" });
      const interaction = pendingQuestion(
        thread.id,
        "Ship to staging or production?",
      );
      host.interactions.set(thread.id, [interaction]);

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: { ...thread, status: "idle" },
        lastAssistantText: "Done",
      });
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread,
        interaction,
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]).toEqual([
        expect.objectContaining({
          title: "Release",
          body: "Ship to staging or production?",
          data: expect.objectContaining({ kind: "pending-interaction" }),
        }),
      ]);

      const answered = host.setThread({ id: "thread-answered" });
      const answeredInteraction = pendingQuestion(answered.id, "Continue?");
      host.interactions.set(answered.id, [answeredInteraction]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: answered,
        interaction: answeredInteraction,
      });
      host.interactions.set(answered.id, []);
      await waitForCoalesce();
      expect(host.expo.requests).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("tells every device and client to remove a notified thread's notifications once it is read", async () => {
    const host = await setup({
      appUrl: "https://bb.example.com",
      dismissReadNotifications: true,
    });
    try {
      await host.addSubscription();
      await host.addSubscription(
        "ExponentPushToken[pixel]",
        "Pixel",
        "android",
      );
      const notified = host.setThread();
      const quiet = host.setThread();
      const dismissals = () =>
        host.harness.realtimeSignals.filter(
          (signal) => signal.channel === "notification-dismiss",
        );

      await host.harness.behavior.emitThreadEvent("experimental_thread.read", {
        thread: notified,
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: notified,
        lastAssistantText: "Done",
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));

      const read = { ...notified, lastReadAt: 200 };
      await host.harness.behavior.emitThreadEvent("experimental_thread.read", {
        thread: read,
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(2));
      expect(host.expo.requests[1]).toEqual(
        [
          ["ExponentPushToken[phone]", "subscription-1"],
          ["ExponentPushToken[pixel]", "subscription-2"],
        ].map(([to, subscriptionId]) => ({
          to,
          data: {
            kind: "dismiss",
            threadId: notified.id,
            subscriptionId,
            serverUrl: "https://bb.example.com",
          },
          _contentAvailable: true,
          priority: "normal",
        })),
      );
      expect(dismissals().map((signal) => signal.payload)).toEqual([
        { threadId: notified.id },
      ]);

      await host.harness.behavior.emitThreadEvent("experimental_thread.read", {
        thread: read,
      });
      await host.harness.behavior.emitThreadEvent("experimental_thread.read", {
        thread: { ...quiet, lastReadAt: 200 },
      });
      await waitForCoalesce();
      expect(host.expo.requests).toHaveLength(2);
      expect(dismissals()).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("dismisses a thread notified only on web and desktop", async () => {
    const host = await setup({ dismissReadNotifications: true });
    try {
      const thread = host.setThread();
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done",
      });
      await vi.waitFor(() => expect(host.clientSignals()).toHaveLength(1));

      await host.harness.behavior.emitThreadEvent("experimental_thread.read", {
        thread: { ...thread, lastReadAt: 200 },
      });
      await vi.waitFor(() =>
        expect(
          host.harness.realtimeSignals
            .filter((signal) => signal.channel === "notification-dismiss")
            .map((signal) => signal.payload),
        ).toEqual([{ threadId: thread.id }]),
      );
      expect(host.expo.requests).toHaveLength(0);
    } finally {
      await host.cleanup();
    }
  });

  it("sends no dismissal while the dismissReadNotifications experiment is off", async () => {
    const host = await setup({ dismissReadNotifications: false });
    try {
      await host.addSubscription();
      const thread = host.setThread();
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done",
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));

      await host.harness.behavior.emitThreadEvent("experimental_thread.read", {
        thread: { ...thread, lastReadAt: 200 },
      });
      await waitForCoalesce();
      expect(host.expo.requests).toHaveLength(1);
      expect(
        host.harness.realtimeSignals.filter(
          (signal) => signal.channel === "notification-dismiss",
        ),
      ).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("batches devices and removes rows that Expo rejects as unregistered", async () => {
    const host = await setup();
    try {
      for (let index = 0; index < 101; index += 1) {
        await host.addSubscription(
          `ExponentPushToken[device-${index}]`,
          `Device ${index}`,
        );
      }
      host.expo.ticketErrors.set(
        "ExponentPushToken[device-100]",
        "DeviceNotRegistered",
      );
      const thread = host.setThread({ status: "error" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread,
        error: "Provider exited with code 1\nStack",
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(2));
      expect(host.expo.requests.map((batch) => batch.length)).toEqual([100, 1]);
      await vi.waitFor(async () => {
        const listed = listPushSubscriptionsOutputSchema.parse(
          await host.harness.behavior.callRpc("pushSubscriptions.list", {}),
        );
        expect(listed.subscriptions).toHaveLength(100);
      });
      expect(JSON.stringify(host.harness.logEntries)).not.toContain(
        "ExponentPushToken",
      );
    } finally {
      await host.cleanup();
    }
  });

  it("warns once per hour for network failures and logs only row ids", async () => {
    let now = 10_000;
    const host = await setup({
      now: () => now,
      fetch: async () => {
        throw new Error("ECONNREFUSED with ExponentPushToken[secret]");
      },
    });
    try {
      await host.addSubscription();
      const trigger = async (id: string) => {
        const thread = host.setThread({ id, status: "error" });
        await host.harness.behavior.emitThreadEvent("thread.failed", {
          thread,
          error: "Provider failed",
        });
        await waitForCoalesce();
      };

      await trigger("thread-first");
      now += 3_599_999;
      await trigger("thread-second");
      now += 1;
      await trigger("thread-third");

      const warnings = host.harness.logEntries.filter(
        (entry) =>
          entry.level === "warn" &&
          entry.message.startsWith("Expo push request failed"),
      );
      expect(warnings).toHaveLength(2);
      expect(warnings[0]?.message).toContain("subscription-1");
      expect(JSON.stringify(host.harness.logEntries)).not.toContain(
        "ExponentPushToken",
      );
    } finally {
      await host.cleanup();
    }
  });
});

describe("web and desktop delivery", () => {
  it("delivers without mobile subscriptions and applies channel changes immediately", async () => {
    const host = await setup();
    try {
      const thread = host.setThread();
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toEqual([
        {
          channel: "notification",
          payload: expect.objectContaining({
            title: thread.title,
            body: "Done",
            threadId: thread.id,
            channels: ["web", "desktop"],
          }),
        },
      ]);
      await host.addSubscription();
      await host.harness.behavior.setSettings({
        mobileEnabled: false,
        webEnabled: false,
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Desktop only",
      });
      await waitForCoalesce();
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        channels: ["desktop"],
      });
      expect(host.expo.requests).toHaveLength(0);
      await host.harness.behavior.setSettings({ desktopEnabled: false });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Disabled",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });

  it("routes CLI and RPC tests only to the selected enabled channel", async () => {
    const host = await setup();
    try {
      expect(await host.harness.behavior.runCli(["test", "web"])).toMatchObject(
        { exitCode: 0 },
      );
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        channels: ["web"],
        threadId: null,
      });
      await host.harness.behavior.callRpc("notifications.test", {
        channel: "desktop",
      });
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        channels: ["desktop"],
      });
      await host.harness.behavior.setSettings({ desktopEnabled: false });
      expect(
        await host.harness.behavior.runCli(["test", "desktop"]),
      ).toMatchObject({ exitCode: 1 });
      await expect(
        host.harness.behavior.callRpc("notifications.test", {
          channel: "desktop",
        }),
      ).rejects.toThrow("disabled");
      await expect(
        host.harness.behavior.callRpc("notifications.test", { channel: "ios" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(host.clientSignals()).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });
});

describe("sending notifications", () => {
  it("publishes only notifications.send for other plugins to discover", async () => {
    const host = await setup();
    try {
      const published =
        host.harness.registrations.experimental_publishedRpcMethods;
      expect(published.map((entry) => entry.method)).toEqual([
        "notifications.send",
      ]);
      expect(published[0]?.inputSchema).toMatchObject({
        required: ["title"],
        additionalProperties: false,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("delivers a threadless message from another plugin to every channel", async () => {
    const host = await setup({ appUrl: "https://bb.example.test" });
    try {
      await host.addSubscription();
      const result = await host.harness.behavior.callRpc(
        "notifications.send",
        { title: `  ${"Urgent ".repeat(20)}`, body: "Production is down" },
        { experimental_caller: { kind: "plugin", pluginId: "attention" } },
      );

      expect(result).toEqual({
        ok: true,
        channels: ["web", "desktop", "mobile"],
      });
      expect(host.clientSignals()).toEqual([
        {
          channel: "notification",
          payload: expect.objectContaining({
            title: expect.stringMatching(/^Urgent .*…$/u),
            body: "Production is down",
            threadId: null,
            channels: ["web", "desktop"],
          }),
        },
      ]);
      expect(host.expo.requests).toHaveLength(1);
      const message = alertMessage(host.expo.requests[0]?.[0]);
      expect(message.title).toHaveLength(80);
      expect(message).toMatchObject({
        to: "ExponentPushToken[phone]",
        body: "Production is down",
        channelId: "threads",
      });
      expect(message?.data).toEqual({
        subscriptionId: "subscription-1",
        kind: "message",
        serverUrl: "https://bb.example.test",
      });
      expect(
        host.harness.logEntries.some((entry) =>
          entry.message.includes("from plugin attention"),
        ),
      ).toBe(true);
      const status = await host.harness.behavior.runCli(["status", "--json"]);
      expect(JSON.parse(status.stdout).lastSendOutcome).toMatchObject({
        status: "sent",
        sentCount: 1,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("reports only the channels that are on and the relay accepted", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ webEnabled: false });
      host.expo.ticketErrors.set(
        "ExponentPushToken[phone]",
        "MessageRateExceeded",
      );
      await expect(
        host.harness.behavior.callRpc("notifications.send", { title: "One" }),
      ).resolves.toEqual({ ok: true, channels: ["desktop"] });
      expect(host.expo.requests).toHaveLength(1);
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        body: "",
        channels: ["desktop"],
      });

      host.expo.ticketErrors.clear();
      await host.harness.behavior.setSettings({
        desktopEnabled: false,
        mobileEnabled: false,
      });
      await expect(
        host.harness.behavior.callRpc("notifications.send", { title: "Two" }),
      ).resolves.toEqual({ ok: true, channels: [] });
      expect(host.expo.requests).toHaveLength(1);
      expect(host.clientSignals()).toHaveLength(1);

      const cli = await host.harness.behavior.runCli([
        "send",
        "--title",
        "Three",
        "--json",
      ]);
      expect(cli.exitCode).toBe(1);
      expect(JSON.parse(cli.stdout)).toMatchObject({
        ok: false,
        error: { code: "not_delivered" },
      });

      await host.harness.behavior.setSettings({ mobileEnabled: true });
      await expect(
        host.harness.behavior.runCli(["send", "--title", "Four", "--json"]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: JSON.stringify({ ok: true, channels: ["mobile"] }),
      });
      expect(host.expo.requests.at(-1)?.[0]?.data).toEqual({
        subscriptionId: "subscription-1",
        kind: "message",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("opens the given thread and rejects unknown or deleted ones", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      const thread = host.setThread({ projectId: "project-7" });
      const deleted = host.setThread({ deletedAt: 5 });

      const cli = await host.harness.behavior.runCli([
        "send",
        "--title",
        "Review ready",
        "--body",
        "PR #12 needs you",
        "--thread",
        thread.id,
      ]);
      expect(cli).toMatchObject({
        exitCode: 0,
        stdout: "Sent to web, desktop, mobile",
      });
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        title: "Review ready",
        threadId: thread.id,
      });
      expect(host.expo.requests[0]?.[0]?.data).toEqual({
        subscriptionId: "subscription-1",
        kind: "message",
        projectId: "project-7",
        threadId: thread.id,
      });

      for (const threadId of ["thread-missing", deleted.id]) {
        await expect(
          host.harness.behavior.callRpc("notifications.send", {
            title: "Lost",
            threadId,
          }),
        ).rejects.toMatchObject({
          code: "handler_error",
          message: `Thread not found: ${threadId}`,
        });
      }
      const missing = await host.harness.behavior.runCli([
        "send",
        "--title",
        "Lost",
        "--thread",
        "thread-missing",
        "--json",
      ]);
      expect(JSON.parse(missing.stdout)).toMatchObject({
        error: { code: "thread_not_found" },
      });
      expect(host.clientSignals()).toHaveLength(1);
      expect(host.expo.requests).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("rejects blank titles and sends nothing once the sender stops", async () => {
    const host = await setup();
    try {
      await expect(
        host.harness.behavior.callRpc("notifications.send", { title: "   " }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      const blank = await host.harness.behavior.runCli([
        "send",
        "--title",
        " ",
      ]);
      expect(blank.exitCode).toBe(1);

      await host.stopService();
      await expect(
        host.harness.behavior.callRpc("notifications.send", { title: "Late" }),
      ).rejects.toThrow("Push notifications are not running");
      expect(host.clientSignals()).toHaveLength(0);
    } finally {
      await host.cleanup();
    }
  });
});

describe("thread notification levels", () => {
  it.each([
    {
      name: "unset worker under an unset parent gets the child default",
      grandparent: "inherit",
      parent: "inherit",
      worker: "inherit",
      childLevel: "input-only",
      expected: {
        parent: { effective: "input-only", source: "child-default" },
        worker: { effective: "input-only", source: "child-default" },
      },
    },
    {
      name: "a worker's own all beats the child default",
      grandparent: "inherit",
      parent: "inherit",
      worker: "all",
      childLevel: "input-only",
      expected: {
        parent: { effective: "input-only", source: "child-default" },
        worker: { effective: "all", source: "self" },
      },
    },
    {
      name: "a parent set to all does not raise an unset worker",
      grandparent: "inherit",
      parent: "all",
      worker: "inherit",
      childLevel: "input-only",
      expected: {
        parent: { effective: "all", source: "self" },
        worker: { effective: "input-only", source: "child-default" },
      },
    },
    {
      name: "a muted parent mutes an unset worker",
      grandparent: "inherit",
      parent: "muted",
      worker: "inherit",
      childLevel: "input-only",
      expected: {
        parent: { effective: "muted", source: "self" },
        worker: { effective: "muted", source: "parent" },
      },
    },
    {
      name: "a muted grandparent caps a parent set to all and its workers",
      grandparent: "muted",
      parent: "all",
      worker: "inherit",
      childLevel: "input-only",
      expected: {
        parent: { effective: "muted", source: "parent" },
        worker: { effective: "muted", source: "ancestor" },
      },
    },
    {
      name: "a muted grandparent caps a worker set to all",
      grandparent: "muted",
      parent: "inherit",
      worker: "all",
      childLevel: "all",
      expected: {
        parent: { effective: "muted", source: "parent" },
        worker: { effective: "muted", source: "ancestor" },
      },
    },
  ])("$name", async ({ grandparent, parent, worker, childLevel, expected }) => {
    const host = await setup();
    try {
      await host.harness.behavior.setSettings({ childLevel });
      const root = host.setThread({ id: "root" });
      const middle = host.setThread({ id: "middle", parentThreadId: root.id });
      const leaf = host.setThread({ id: "leaf", parentThreadId: middle.id });
      await host.setLevel(leaf.id, worker);
      await host.setLevel(middle.id, parent);
      await host.setLevel(root.id, grandparent);
      await expect(host.getLevel(middle.id)).resolves.toEqual({
        own: parent,
        ...expected.parent,
      });
      await expect(host.getLevel(leaf.id)).resolves.toEqual({
        own: worker,
        ...expected.worker,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("stores only each thread's own level and resolves limits from the current tree", async () => {
    const host = await setup();
    try {
      const root = host.setThread({ id: "root" });
      const child = host.setThread({ id: "child", parentThreadId: root.id });
      const grandchild = host.setThread({
        id: "grandchild",
        parentThreadId: child.id,
      });
      const other = host.setThread({ id: "other" });

      await host.setLevel(root.id, "muted");
      expect(host.storedLevel(root.id)).toBe("muted");
      expect(host.storedLevel(child.id)).toBeNull();
      expect(host.storedLevel(grandchild.id)).toBeNull();
      expect(host.storedLevel(other.id)).toBeNull();
      await expect(host.getLevel(grandchild.id)).resolves.toEqual({
        own: "inherit",
        effective: "muted",
        source: "ancestor",
      });

      await host.setLevel(child.id, "all");
      expect(host.storedLevel(child.id)).toBe("all");
      await expect(host.getLevel(child.id)).resolves.toEqual({
        own: "all",
        effective: "muted",
        source: "parent",
      });
      await expect(host.getLevel(grandchild.id)).resolves.toEqual({
        own: "inherit",
        effective: "muted",
        source: "ancestor",
      });

      await host.setLevel(root.id, "inherit");
      expect(host.storedLevel(root.id)).toBeNull();
      await expect(host.getLevel(child.id)).resolves.toEqual({
        own: "all",
        effective: "all",
        source: "self",
      });
      await expect(host.getLevel(grandchild.id)).resolves.toEqual({
        own: "inherit",
        effective: "input-only",
        source: "child-default",
      });

      await host.setLevel(child.id, "inherit");
      expect(host.storedLevel(child.id)).toBeNull();

      await host.harness.behavior.setSettings({ defaultLevel: "muted" });
      await expect(host.getLevel(root.id)).resolves.toEqual({
        own: "inherit",
        effective: "muted",
        source: "global",
      });
      await host.harness.behavior.setSettings({ childLevel: "inherit" });
      await expect(host.getLevel(grandchild.id)).resolves.toEqual({
        own: "inherit",
        effective: "muted",
        source: "global",
      });

      await expect(host.getLevel("missing")).rejects.toThrow(
        "Thread not found",
      );
      await expect(host.setLevel("missing", "muted")).rejects.toThrow(
        "Thread not found",
      );
    } finally {
      await host.cleanup();
    }
  });

  it("follows a thread nested under a new parent or released from an archived one", async () => {
    const host = await setup();
    try {
      const muted = host.setThread({ id: "muted" });
      const loud = host.setThread({ id: "loud" });
      const worker = host.setThread({ id: "worker", parentThreadId: muted.id });
      const subWorker = host.setThread({
        id: "sub-worker",
        parentThreadId: worker.id,
        status: "active",
      });
      await host.setLevel(muted.id, "muted");
      await host.setLevel(loud.id, "all");
      await expect(host.getLevel(subWorker.id)).resolves.toMatchObject({
        effective: "muted",
        source: "ancestor",
      });

      host.moveThread(worker.id, loud.id);
      await expect(host.getLevel(subWorker.id)).resolves.toEqual({
        own: "inherit",
        effective: "input-only",
        source: "child-default",
      });
      const question = pendingQuestion(subWorker.id, "Ship it?");
      host.interactions.set(subWorker.id, [question]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: host.threads.get(subWorker.id)!,
        interaction: question,
      });
      await waitForCoalesce();
      expect(host.clientSignals().map((signal) => signal.payload)).toEqual([
        expect.objectContaining({ threadId: subWorker.id, body: "Ship it?" }),
      ]);

      host.moveThread(worker.id, muted.id);
      await expect(host.getLevel(subWorker.id)).resolves.toMatchObject({
        effective: "muted",
        source: "ancestor",
      });
      host.moveThread(worker.id, null);
      await expect(host.getLevel(worker.id)).resolves.toEqual({
        own: "inherit",
        effective: "all",
        source: "global",
      });
      await expect(host.getLevel(subWorker.id)).resolves.toEqual({
        own: "inherit",
        effective: "input-only",
        source: "child-default",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("publishes a moved thread's subtree when its parent changes", async () => {
    const host = await setup();
    try {
      const muted = host.setThread({ id: "muted" });
      const worker = host.setThread({ id: "worker" });
      const subWorker = host.setThread({
        id: "sub-worker",
        parentThreadId: worker.id,
      });
      host.setThread({ id: "other" });
      await host.setLevel(muted.id, "muted");

      host.moveThread(worker.id, muted.id);
      await host.harness.behavior.emitThreadEvent(
        "experimental_thread.parentChanged",
        { thread: host.threads.get(worker.id)!, previousParentThreadId: null },
      );
      const capped = {
        own: "inherit",
        ancestorCap: { level: "muted", threadId: muted.id },
      };
      await expect(host.listLevels([worker.id, subWorker.id])).resolves.toEqual(
        { threads: { [worker.id]: capped, [subWorker.id]: capped } },
      );
    } finally {
      await host.cleanup();
    }
  });

  it("publishes only live, visible descendants and republishes a thread when it is unarchived", async () => {
    const host = await setup();
    try {
      const root = host.setThread({ id: "root" });
      const archived = host.setThread({
        id: "archived",
        parentThreadId: root.id,
        archivedAt: 1,
      });
      const worker = host.setThread({
        id: "worker",
        parentThreadId: archived.id,
      });
      host.setThread({
        id: "hidden",
        parentThreadId: root.id,
        visibility: "hidden",
      });
      const capped = {
        own: "inherit",
        ancestorCap: { level: "muted", threadId: root.id },
      };

      await host.setLevel(root.id, "muted");
      await expect(host.listLevels([root.id, worker.id])).resolves.toEqual({
        threads: {
          [root.id]: { own: "muted", ancestorCap: null },
          [worker.id]: capped,
        },
      });

      const unarchived = { ...archived, archivedAt: null };
      host.threads.set(archived.id, unarchived);
      await host.harness.behavior.emitThreadEvent("thread.unarchived", {
        thread: unarchived,
      });
      await expect(host.listLevels([archived.id, worker.id])).resolves.toEqual({
        threads: { [archived.id]: capped, [worker.id]: capped },
      });
    } finally {
      await host.cleanup();
    }
  });

  it("lists resolved levels in one call and publishes the written thread's subtree", async () => {
    const host = await setup();
    try {
      const root = host.setThread({ id: "root" });
      host.setThread({ id: "child", parentThreadId: root.id });
      host.setThread({ id: "other" });

      await host.setLevel(root.id, "muted");
      const capped = {
        own: "inherit",
        ancestorCap: { level: "muted", threadId: root.id },
      };
      await expect(
        host.listLevels(["root", "child", "other"]),
      ).resolves.toEqual({
        threads: { root: { own: "muted", ancestorCap: null }, child: capped },
      });
      await host.setLevel(root.id, "inherit");
      await expect(
        host.listLevels(["root", "child", "other"]),
      ).resolves.toEqual({ threads: {} });
    } finally {
      await host.cleanup();
    }
  });

  it("lists the requested threads' rows, archived ones included", async () => {
    const host = await setup();
    try {
      const archived = host.setThread({ id: "archived", archivedAt: 1 });
      const plain = host.setThread({ id: "plain" });
      host.setThread({ id: "unrequested" });
      await host.setLevel(archived.id, "muted");
      await host.setLevel("unrequested", "all");
      await expect(
        host.listLevels([archived.id, plain.id, "missing"]),
      ).resolves.toEqual({
        threads: { archived: { own: "muted", ancestorCap: null } },
      });
      await expect(host.listLevels([])).rejects.toMatchObject({
        code: "invalid_input",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("prints and sets levels from the CLI", async () => {
    const host = await setup();
    try {
      const root = host.setThread({ id: "root" });
      const child = host.setThread({ id: "child", parentThreadId: root.id });
      const grandchild = host.setThread({
        id: "grandchild",
        parentThreadId: child.id,
      });
      await expect(
        host.harness.behavior.runCli(["thread", root.id]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Notifications for root: all (default)",
      });
      await expect(
        host.harness.behavior.runCli(["thread", root.id, "--level", "muted"]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Notifications for root: muted (set on this thread)",
      });
      await expect(
        host.harness.behavior.runCli(["thread", child.id, "--level", "all"]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Notifications for child: muted (limited by parent)",
      });
      await expect(
        host.harness.behavior.runCli(["thread", grandchild.id]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Notifications for grandchild: muted (limited by an ancestor)",
      });
      const inherited = await host.harness.behavior.runCli([
        "thread",
        child.id,
        "--json",
      ]);
      expect(JSON.parse(inherited.stdout)).toEqual({
        threadId: "child",
        own: "all",
        effective: "muted",
        source: "parent",
      });
      const invalid = await host.harness.behavior.runCli([
        "thread",
        child.id,
        "--level",
        "loud",
      ]);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("invalid value 'loud' for --level");
      const missing = await host.harness.behavior.runCli([
        "thread",
        "missing",
        "--json",
      ]);
      expect(missing.exitCode).toBe(1);
      expect(JSON.parse(missing.stdout)).toMatchObject({
        ok: false,
        error: { code: "thread_not_found" },
      });
    } finally {
      await host.cleanup();
    }
  });

  it("applies the resolved level at send time", async () => {
    const host = await setup();
    try {
      const muted = host.setThread({ id: "muted", status: "active" });
      await host.setLevel(muted.id, "muted");
      const mutedQuestion = pendingQuestion(muted.id, "Continue?");
      host.interactions.set(muted.id, [mutedQuestion]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: muted,
        interaction: mutedQuestion,
      });

      const quiet = host.setThread({ id: "quiet" });
      await host.setLevel(quiet.id, "input-only");
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: quiet,
        lastAssistantText: "Finished quietly",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toEqual([]);

      host.threads.set(quiet.id, { ...quiet, status: "active" });
      const quietQuestion = pendingQuestion(quiet.id, "Deploy now?");
      host.interactions.set(quiet.id, [quietQuestion]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: quiet,
        interaction: quietQuestion,
      });
      await waitForCoalesce();
      expect(host.clientSignals().map((signal) => signal.payload)).toEqual([
        expect.objectContaining({ threadId: quiet.id, body: "Deploy now?" }),
      ]);

      const failing = host.setThread({ id: "failing", status: "error" });
      await host.setLevel(failing.id, "input-only");
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: failing,
        error: "Provider crashed",
      });

      const inheritedQuiet = host.setThread({
        id: "inherited-quiet",
        parentThreadId: quiet.id,
        status: "active",
      });
      const inheritedQuestion = pendingQuestion(inheritedQuiet.id, "Merge?");
      host.interactions.set(inheritedQuiet.id, [inheritedQuestion]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: inheritedQuiet,
        interaction: inheritedQuestion,
      });
      await waitForCoalesce();
      expect(host.clientSignals().map((signal) => signal.payload)).toEqual([
        expect.objectContaining({ threadId: quiet.id }),
        expect.objectContaining({
          threadId: failing.id,
          body: "Provider crashed",
        }),
        expect.objectContaining({
          threadId: inheritedQuiet.id,
          body: "Merge?",
        }),
      ]);

      await host.harness.behavior.setSettings({ defaultLevel: "input-only" });
      const plain = host.setThread({ id: "plain" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: plain,
        lastAssistantText: "Done",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toHaveLength(3);
    } finally {
      await host.cleanup();
    }
  });

  it("notifies only chosen trees under a muted default, their workers no louder than the child level", async () => {
    const host = await setup();
    try {
      await host.harness.behavior.setSettings({ defaultLevel: "muted" });
      const plain = host.setThread({ id: "plain" });
      const chosen = host.setThread({ id: "chosen" });
      await host.setLevel(chosen.id, "all");
      const chosenWorker = host.setThread({
        id: "chosen-worker",
        parentThreadId: chosen.id,
      });
      for (const thread of [plain, chosen, chosenWorker]) {
        await host.harness.behavior.emitThreadEvent("thread.idle", {
          thread,
          lastAssistantText: `${thread.id} done`,
        });
      }
      await waitForCoalesce();
      expect(host.clientSignals().map((signal) => signal.payload)).toEqual([
        expect.objectContaining({ threadId: chosen.id }),
      ]);

      const plainWorker = host.setThread({
        id: "plain-worker",
        parentThreadId: plain.id,
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: plainWorker,
        lastAssistantText: "Worker done",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toHaveLength(1);

      await host.harness.behavior.setSettings({ childLevel: "all" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: plainWorker,
        lastAssistantText: "Worker done again",
      });
      await waitForCoalesce();
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        threadId: plainWorker.id,
        body: "Worker done again",
      });
    } finally {
      await host.cleanup();
    }
  });
});

const PLUGIN_CALLER = { kind: "plugin", pluginId: "citadel" } as const;

function notifyInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "blocker",
    title: "Decision needed",
    body: "Pick the deploy window",
    ...overrides,
  };
}

async function notifyAs(
  host: Awaited<ReturnType<typeof setup>>,
  overrides: Record<string, unknown> = {},
  caller:
    | { kind: "plugin"; pluginId: string }
    | { kind: "client" } = PLUGIN_CALLER,
) {
  return (await host.harness.behavior.callRpc(
    "notifications.notify",
    notifyInput(overrides),
    { experimental_caller: caller },
  )) as {
    id: string;
    at: number;
    day: string;
    source: string;
    outcome: "sent" | "capped" | "deduped";
    capped: boolean;
    deduped: boolean;
    cap: number;
    sentToday: number;
    delivery: {
      web: boolean;
      desktop: boolean;
      mobileDevices: number;
      mobileSent: number;
      mobileFailure: string | null;
    } | null;
  };
}

async function blockerStatus(host: Awaited<ReturnType<typeof setup>>) {
  const result = await host.harness.behavior.runCli(["status", "--json"]);
  return JSON.parse(result.stdout).blockerPush as {
    timeZone: string;
    cap: number;
    today: string;
    days: {
      day: string;
      total: { sent: number; capped: number; deduped: number };
      sources: Record<
        string,
        { sent: number; capped: number; deduped: number }
      >;
    }[];
  };
}

describe("blocker push notifications", () => {
  it("pushes up to the cap and then counts without sending", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 2 });
      const first = await notifyAs(host);
      const second = await notifyAs(host);
      expect([first.outcome, second.outcome]).toEqual(["sent", "sent"]);
      expect([first.sentToday, second.sentToday]).toEqual([1, 2]);
      expect(host.expo.requests).toHaveLength(2);

      const third = await notifyAs(host);
      expect(third).toMatchObject({
        outcome: "capped",
        capped: true,
        deduped: false,
        cap: 2,
        sentToday: 2,
        delivery: null,
        source: "citadel",
      });
      expect(third.id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(host.expo.requests).toHaveLength(2);
      expect(host.clientSignals()).toHaveLength(2);

      const status = await blockerStatus(host);
      expect(status.days[0]?.sources).toEqual({
        citadel: { sent: 2, capped: 1, deduped: 0 },
      });
    } finally {
      await host.cleanup();
    }
  });

  it("defaults to three pushes per day", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      const outcomes: string[] = [];
      for (let index = 0; index < 4; index += 1) {
        outcomes.push((await notifyAs(host)).outcome);
      }
      expect(outcomes).toEqual(["sent", "sent", "sent", "capped"]);
      expect((await blockerStatus(host)).cap).toBe(3);
      expect(host.expo.requests).toHaveLength(3);
    } finally {
      await host.cleanup();
    }
  });

  it("applies the cap to all sources together", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 2 });
      const first = await notifyAs(host, {}, { kind: "plugin", pluginId: "a" });
      const second = await notifyAs(
        host,
        {},
        { kind: "plugin", pluginId: "b" },
      );
      expect([first.outcome, second.outcome]).toEqual(["sent", "sent"]);
      expect([first.sentToday, second.sentToday]).toEqual([1, 2]);
      const third = await notifyAs(host, {}, { kind: "plugin", pluginId: "c" });
      expect(third).toMatchObject({
        outcome: "capped",
        capped: true,
        sentToday: 2,
        source: "c",
      });
      const fourth = await notifyAs(
        host,
        {},
        { kind: "plugin", pluginId: "a" },
      );
      expect(fourth.outcome).toBe("capped");
      const invented = await notifyAs(
        host,
        { source: "invented-source" },
        { kind: "client" },
      );
      expect(invented.outcome).toBe("capped");
      expect(host.expo.requests).toHaveLength(2);
      expect((await blockerStatus(host)).days[0]).toEqual({
        day: expect.any(String),
        total: { sent: 2, capped: 3, deduped: 0 },
        sources: {
          a: { sent: 1, capped: 1, deduped: 0 },
          b: { sent: 1, capped: 0, deduped: 0 },
          _overflow: { sent: 0, capped: 2, deduped: 0 },
        },
      });
    } finally {
      await host.cleanup();
    }
  });

  it("accepts a cap of zero and rejects one above the maximum", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 0 });
      expect((await notifyAs(host)).outcome).toBe("capped");
      expect(host.expo.requests).toHaveLength(0);
      await expect(
        host.harness.behavior.setSettings({ blockerDailyCap: 101 }),
      ).rejects.toThrow();
    } finally {
      await host.cleanup();
    }
  });

  it("keys the dedupe on the source and the dedupe key", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 5 });
      expect(
        (
          await notifyAs(
            host,
            { dedupeKey: "card-1" },
            { kind: "plugin", pluginId: "a" },
          )
        ).outcome,
      ).toBe("sent");
      expect(
        (
          await notifyAs(
            host,
            { dedupeKey: "card-1" },
            { kind: "plugin", pluginId: "b" },
          )
        ).outcome,
      ).toBe("sent");
      expect(
        (
          await notifyAs(
            host,
            { dedupeKey: "card-1" },
            { kind: "plugin", pluginId: "a" },
          )
        ).outcome,
      ).toBe("deduped");
      expect(host.expo.requests).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });

  it("does not push the same dedupe key twice in a day", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 2 });
      expect((await notifyAs(host, { dedupeKey: "card-1" })).outcome).toBe(
        "sent",
      );
      const repeat = await notifyAs(host, { dedupeKey: "card-1" });
      expect(repeat).toMatchObject({
        outcome: "deduped",
        deduped: true,
        capped: false,
        sentToday: 1,
        delivery: null,
      });
      expect((await notifyAs(host, { dedupeKey: "card-2" })).outcome).toBe(
        "sent",
      );
      expect((await notifyAs(host, { dedupeKey: "card-3" })).outcome).toBe(
        "capped",
      );
      expect((await notifyAs(host, { dedupeKey: "card-1" })).outcome).toBe(
        "deduped",
      );
      expect(host.expo.requests).toHaveLength(2);
      expect((await blockerStatus(host)).days[0]?.sources).toEqual({
        citadel: { sent: 2, capped: 1, deduped: 2 },
      });
    } finally {
      await host.cleanup();
    }
  });

  it("lets a dedupe key be pushed again on the next day", async () => {
    let clock = Date.UTC(2026, 5, 10, 18, 0, 0);
    const host = await setup({ now: () => clock });
    try {
      await host.addSubscription();
      expect((await notifyAs(host, { dedupeKey: "card-1" })).outcome).toBe(
        "sent",
      );
      expect((await notifyAs(host, { dedupeKey: "card-1" })).outcome).toBe(
        "deduped",
      );
      clock += 24 * 60 * 60 * 1000;
      expect((await notifyAs(host, { dedupeKey: "card-1" })).outcome).toBe(
        "sent",
      );
    } finally {
      await host.cleanup();
    }
  });

  it("refuses any kind other than blocker and counts nothing", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await expect(notifyAs(host, { kind: "digest" })).rejects.toMatchObject({
        code: "invalid",
        message: expect.stringContaining('only "blocker" is accepted'),
      });
      const cli = await host.harness.behavior.runCli([
        "notify",
        "--source",
        "citadel",
        "--kind",
        "info",
        "--title",
        "T",
        "--body",
        "B",
        "--json",
      ]);
      expect(cli.exitCode).not.toBe(0);
      expect(cli.stdout).toContain('only \\"blocker\\" is accepted');
      expect(host.expo.requests).toHaveLength(0);
      expect((await blockerStatus(host)).days[0]?.sources).toEqual({});
    } finally {
      await host.cleanup();
    }
  });

  it("ties the source to the calling plugin and requires one from clients", async () => {
    const host = await setup();
    try {
      expect(await notifyAs(host, { source: "citadel" })).toMatchObject({
        source: "citadel",
      });
      await expect(
        notifyAs(host, { source: "someone-else" }),
      ).rejects.toMatchObject({ code: "forbidden" });
      await expect(
        notifyAs(host, {}, { kind: "client" }),
      ).rejects.toMatchObject({ code: "invalid" });
      expect(
        await notifyAs(host, { source: "ops-tool" }, { kind: "client" }),
      ).toMatchObject({ source: "ops-tool" });
      await expect(
        notifyAs(host, { source: "Bad Source" }, { kind: "client" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      await host.cleanup();
    }
  });

  it("sends the blocker to mobile, web, and desktop with the thread as the target", async () => {
    const host = await setup({ appUrl: "https://bb.test" });
    try {
      await host.addSubscription();
      const result = await notifyAs(host, {
        title: "T".repeat(120),
        body: "B".repeat(400),
        threadId: "thr_23456789ab",
      });
      expect(result.delivery).toEqual({
        web: true,
        desktop: true,
        mobileDevices: 1,
        mobileSent: 1,
        mobileFailure: null,
      });
      const message = alertMessage(host.expo.requests[0]?.[0]);
      expect(message.title).toHaveLength(80);
      expect(message.body).toHaveLength(180);
      expect(message.data).toEqual({
        kind: "blocker",
        serverUrl: "https://bb.test",
        subscriptionId: "subscription-1",
        threadId: "thr_23456789ab",
      });
      expect(host.clientSignals()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            id: result.id,
            threadId: "thr_23456789ab",
            channels: ["web", "desktop"],
          }),
        }),
      ]);
      await expect(
        notifyAs(host, { url: "/projects/p1" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      const cli = await host.harness.behavior.runCli([
        "notify",
        "--source",
        "citadel",
        "--kind",
        "blocker",
        "--title",
        "T",
        "--body",
        "B",
        "--url",
        "/projects/p1",
      ]);
      expect(cli.exitCode).not.toBe(0);
    } finally {
      await host.cleanup();
    }
  });

  it("honours the channel switches and reports a relay failure without failing", async () => {
    const failing: PushSenderFetch = async () => {
      throw new Error("down");
    };
    const host = await setup({ fetch: failing });
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({
        webEnabled: false,
        desktopEnabled: false,
      });
      const result = await notifyAs(host);
      expect(result).toMatchObject({
        outcome: "sent",
        delivery: {
          web: false,
          desktop: false,
          mobileDevices: 1,
          mobileSent: 0,
          mobileFailure: "network request failed",
        },
      });
      expect(host.clientSignals()).toHaveLength(0);
      expect((await blockerStatus(host)).days[0]?.sources).toEqual({
        citadel: { sent: 1, capped: 0, deduped: 0 },
      });
    } finally {
      await host.cleanup();
    }
  });

  it("rolls the count over at midnight Pacific time", async () => {
    let clock = Date.UTC(2026, 5, 10, 6, 59, 59);
    const host = await setup({ now: () => clock });
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 1 });
      const lateEvening = await notifyAs(host);
      expect(lateEvening).toMatchObject({ outcome: "sent", day: "2026-06-09" });
      expect((await notifyAs(host)).outcome).toBe("capped");
      clock = Date.UTC(2026, 5, 10, 7, 0, 0);
      const midnight = await notifyAs(host);
      expect(midnight).toMatchObject({ outcome: "sent", day: "2026-06-10" });
      expect((await notifyAs(host)).outcome).toBe("capped");
    } finally {
      await host.cleanup();
    }
  });

  it("keeps the 25-hour fall-back day as one day", async () => {
    let clock = Date.UTC(2026, 10, 1, 7, 0, 0);
    const host = await setup({ now: () => clock });
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 1 });
      expect(await notifyAs(host)).toMatchObject({
        outcome: "sent",
        day: "2026-11-01",
      });
      clock = Date.UTC(2026, 10, 2, 7, 0, 0);
      expect(await notifyAs(host)).toMatchObject({
        outcome: "capped",
        day: "2026-11-01",
      });
      clock = Date.UTC(2026, 10, 2, 7, 59, 59);
      expect(await notifyAs(host)).toMatchObject({
        outcome: "capped",
        day: "2026-11-01",
      });
      clock = Date.UTC(2026, 10, 2, 8, 0, 0);
      expect(await notifyAs(host)).toMatchObject({
        outcome: "sent",
        day: "2026-11-02",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("keeps the 23-hour spring-forward day as one day", async () => {
    let clock = Date.UTC(2027, 2, 14, 8, 0, 0);
    const host = await setup({ now: () => clock });
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 1 });
      expect(await notifyAs(host)).toMatchObject({
        outcome: "sent",
        day: "2027-03-14",
      });
      clock = Date.UTC(2027, 2, 15, 6, 59, 59);
      expect(await notifyAs(host)).toMatchObject({
        outcome: "capped",
        day: "2027-03-14",
      });
      clock = Date.UTC(2027, 2, 15, 7, 0, 0);
      expect(await notifyAs(host)).toMatchObject({
        outcome: "sent",
        day: "2027-03-15",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("shows today and the last 14 days in status and drops older days", async () => {
    let clock = Date.UTC(2026, 5, 1, 18, 0, 0);
    const host = await setup({ now: () => clock });
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 1 });
      await notifyAs(host);
      await notifyAs(host);
      clock = Date.UTC(2026, 5, 14, 18, 0, 0);
      await notifyAs(host, {}, { kind: "plugin", pluginId: "other" });
      let status = await blockerStatus(host);
      expect(status.timeZone).toBe("America/Los_Angeles");
      expect(status.today).toBe("2026-06-14");
      expect(status.cap).toBe(1);
      expect(status.days).toHaveLength(14);
      expect(status.days[0]).toEqual({
        day: "2026-06-14",
        total: { sent: 1, capped: 0, deduped: 0 },
        sources: { other: { sent: 1, capped: 0, deduped: 0 } },
      });
      expect(status.days[13]).toEqual({
        day: "2026-06-01",
        total: { sent: 1, capped: 1, deduped: 0 },
        sources: { citadel: { sent: 1, capped: 1, deduped: 0 } },
      });

      clock = Date.UTC(2026, 5, 15, 18, 0, 0);
      await notifyAs(host, {}, { kind: "plugin", pluginId: "other" });
      status = await blockerStatus(host);
      expect(status.days).toHaveLength(14);
      expect(status.days.map((entry) => entry.day)).not.toContain("2026-06-01");
      const text = await host.harness.behavior.runCli(["status"]);
      expect(text.stdout).toContain(
        "Blocker pushes (America/Los_Angeles, cap 1 per day across all sources)",
      );
      expect(text.stdout).toContain("2026-06-15 total: sent 1, capped 0");
      expect(text.stdout).toContain("2026-06-15 other: sent 1, capped 0");
    } finally {
      await host.cleanup();
    }
  });

  it("exits 0 with capped set from the CLI and prints the id", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 1 });
      const args = [
        "notify",
        "--source",
        "citadel",
        "--kind",
        "blocker",
        "--title",
        "Decision needed",
        "--body",
        "Pick the deploy window",
        "--thread",
        "thr_23456789ab",
        "--json",
      ];
      const sent = await host.harness.behavior.runCli([
        ...args,
        "--dedupe-key",
        "card-1",
      ]);
      expect(sent.exitCode).toBe(0);
      expect(JSON.parse(sent.stdout)).toMatchObject({
        outcome: "sent",
        capped: false,
        source: "citadel",
        sentToday: 1,
      });
      const deduped = await host.harness.behavior.runCli([
        ...args,
        "--dedupe-key",
        "card-1",
      ]);
      expect(deduped.exitCode).toBe(0);
      expect(JSON.parse(deduped.stdout)).toMatchObject({
        outcome: "deduped",
        deduped: true,
      });
      const capped = await host.harness.behavior.runCli([
        ...args,
        "--dedupe-key",
        "card-2",
      ]);
      expect(capped.exitCode).toBe(0);
      const parsed = JSON.parse(capped.stdout);
      expect(parsed).toMatchObject({ outcome: "capped", capped: true });
      expect(parsed.id).toMatch(/^[0-9a-f-]{36}$/u);
      expect(typeof parsed.at).toBe("number");
      const plain = await host.harness.behavior.runCli(
        args.filter((arg) => arg !== "--json"),
      );
      expect(plain.exitCode).toBe(0);
      expect(plain.stdout).toContain("daily cap of 1");
      expect(host.expo.requests).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("reports the day total when a repeated key is deduped", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 5 });
      const sourceA = { kind: "plugin", pluginId: "a" } as const;
      const sourceB = { kind: "plugin", pluginId: "b" } as const;
      await notifyAs(host, { dedupeKey: "card-1" }, sourceA);
      await notifyAs(host, {}, sourceB);
      const repeated = await notifyAs(host, { dedupeKey: "card-1" }, sourceA);
      expect(repeated).toMatchObject({
        outcome: "deduped",
        deduped: true,
        sentToday: 2,
      });
      expect(host.expo.requests).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });

  it("counts capped calls from sources with no row under one shared overflow row", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 1 });
      await notifyAs(host, {}, { kind: "plugin", pluginId: "a" });
      for (let index = 0; index < 30; index += 1) {
        const result = await notifyAs(
          host,
          { source: `invented-${index}` },
          { kind: "client" },
        );
        expect(result.outcome).toBe("capped");
      }
      const known = await notifyAs(host, {}, { kind: "plugin", pluginId: "a" });
      expect(known.outcome).toBe("capped");
      const status = await blockerStatus(host);
      expect(status.days[0]).toEqual({
        day: expect.any(String),
        total: { sent: 1, capped: 31, deduped: 0 },
        sources: {
          a: { sent: 1, capped: 1, deduped: 0 },
          _overflow: { sent: 0, capped: 30, deduped: 0 },
        },
      });
      expect(
        await host.bb.storage.kv.list(`blocker-day:${status.today}:`),
      ).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });

  it("creates only the overflow row when the cap is zero", async () => {
    const host = await setup();
    try {
      await host.harness.behavior.setSettings({ blockerDailyCap: 0 });
      for (let index = 0; index < 10; index += 1) {
        await notifyAs(
          host,
          { source: `invented-${index}` },
          { kind: "client" },
        );
      }
      const status = await blockerStatus(host);
      expect(Object.keys(status.days[0]?.sources ?? {})).toEqual(["_overflow"]);
      expect(status.days[0]?.total).toEqual({
        sent: 0,
        capped: 10,
        deduped: 0,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("sends exactly one of two concurrent calls one below the cap", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 2 });
      await notifyAs(host, {}, { kind: "plugin", pluginId: "a" });
      const results = await Promise.all([
        notifyAs(host, {}, { kind: "plugin", pluginId: "b" }),
        notifyAs(host, {}, { kind: "plugin", pluginId: "c" }),
      ]);
      expect(results.map((result) => result.outcome).sort()).toEqual([
        "capped",
        "sent",
      ]);
      expect(host.expo.requests).toHaveLength(2);
      expect((await blockerStatus(host)).days[0]?.total).toEqual({
        sent: 2,
        capped: 1,
        deduped: 0,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("refuses a thread id outside the bb format before counting or sending", async () => {
    const host = await setup({ appUrl: "https://bb.test" });
    try {
      await host.addSubscription();
      const bad = [
        "../settings?x=1",
        "thr_23456789ab/x",
        "thr_23456789ab\\x",
        "..",
        "thr_23456789a?",
        "thr_23456789a#",
        "thr_23456789%2f",
        "thr_23456789a b",
        " thr_23456789ab",
        "thr_23456789ab\n",
        "thr_23456789abc",
        `thr_${"a".repeat(300)}`,
        "thread-9",
        "",
      ];
      for (const threadId of bad) {
        await expect(notifyAs(host, { threadId })).rejects.toMatchObject({
          code: "invalid_input",
        });
        const cli = await host.harness.behavior.runCli([
          "notify",
          "--source",
          "citadel",
          "--kind",
          "blocker",
          "--title",
          "T",
          "--body",
          "B",
          "--thread",
          threadId,
        ]);
        expect(cli.exitCode).not.toBe(0);
      }
      expect(host.expo.requests).toHaveLength(0);
      expect(host.clientSignals()).toHaveLength(0);
      expect(await host.bb.storage.kv.list("blocker-day:")).toEqual([]);
      const accepted = await notifyAs(host, { threadId: "thr_23456789ab" });
      expect(accepted.outcome).toBe("sent");
    } finally {
      await host.cleanup();
    }
  });

  it("refuses a missing, empty, or oversized title or body before counting", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      const bad: Record<string, unknown>[] = [
        { title: undefined },
        { title: "" },
        { title: "   " },
        { title: "T".repeat(501) },
        { body: undefined },
        { body: "" },
        { body: "   " },
        { body: "B".repeat(501) },
      ];
      for (const overrides of bad) {
        await expect(notifyAs(host, overrides)).rejects.toMatchObject({
          code: "invalid_input",
        });
      }
      const cli = await host.harness.behavior.runCli([
        "notify",
        "--source",
        "citadel",
        "--kind",
        "blocker",
        "--body",
        "B",
      ]);
      expect(cli.exitCode).not.toBe(0);
      expect(host.expo.requests).toHaveLength(0);
      expect(await host.bb.storage.kv.list("blocker-day:")).toEqual([]);
      expect((await blockerStatus(host)).days[0]?.total).toEqual({
        sent: 0,
        capped: 0,
        deduped: 0,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("deletes stored rows older than 14 days", async () => {
    let clock = Date.UTC(2026, 5, 1, 18, 0, 0);
    const host = await setup({ now: () => clock });
    try {
      await host.addSubscription();
      await notifyAs(host);
      clock = Date.UTC(2026, 5, 2, 18, 0, 0);
      await notifyAs(host);
      expect(await host.bb.storage.kv.list("blocker-day:")).toEqual([
        "blocker-day:2026-06-01:citadel",
        "blocker-day:2026-06-02:citadel",
      ]);
      clock = Date.UTC(2026, 5, 15, 18, 0, 0);
      await notifyAs(host);
      expect(await host.bb.storage.kv.list("blocker-day:")).toEqual([
        "blocker-day:2026-06-02:citadel",
        "blocker-day:2026-06-15:citadel",
      ]);
    } finally {
      await host.cleanup();
    }
  });

  it("leaves the event-driven pushes alone whatever the blocker cap is", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.harness.behavior.setSettings({ blockerDailyCap: 0 });
      const thread = host.setThread();
      const interaction = pendingQuestion(thread.id, "Which database?");
      host.interactions.set(thread.id, [interaction]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread,
        interaction,
      });
      await waitForCoalesce();
      expect(host.expo.requests).toHaveLength(1);
      expect(host.expo.requests[0]?.[0]?.data).toMatchObject({
        kind: "pending-interaction",
        threadId: thread.id,
      });
      expect((await blockerStatus(host)).days[0]?.sources).toEqual({});
    } finally {
      await host.cleanup();
    }
  });

  it("waits for a blocker delivery that is pending when the sender stops", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      let reached!: () => void;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const kv = host.bb.storage.kv;
      const list = kv.list.bind(kv);
      vi.spyOn(kv, "list").mockImplementation(async (prefix) => {
        if (prefix === "subscription:") {
          reached();
          await gate;
        }
        return list(prefix);
      });
      const pending = notifyAs(host);
      await arrived;
      let stopped = false;
      const stopping = host.stopService().then(() => {
        stopped = true;
      });
      await waitForCoalesce();
      expect(stopped).toBe(false);
      open();
      const result = await pending;
      await stopping;
      expect(result).toMatchObject({
        outcome: "sent",
        sentToday: 1,
        delivery: { mobileDevices: 1, mobileSent: 1, mobileFailure: null },
      });
      expect(host.expo.requests).toHaveLength(1);
      expect(host.clientSignals()).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("refuses a notify after the sender stops without counting or sending", async () => {
    const host = await setup();
    try {
      await host.addSubscription();
      await host.stopService();
      await expect(notifyAs(host, { dedupeKey: "late" })).rejects.toThrow(
        "Push notifications are not running",
      );
      const cli = await host.harness.behavior.runCli([
        "notify",
        "--source",
        "citadel",
        "--kind",
        "blocker",
        "--title",
        "T",
        "--body",
        "B",
        "--json",
      ]);
      expect(cli.exitCode).not.toBe(0);
      expect(cli.stdout).toContain("sender_stopped");
      expect(host.expo.requests).toHaveLength(0);
      expect(host.clientSignals()).toHaveLength(0);
      expect((await blockerStatus(host)).days[0]?.sources ?? {}).toEqual({});
    } finally {
      await host.cleanup();
    }
  });
});
