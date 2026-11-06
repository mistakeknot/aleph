import { randomUUID } from "node:crypto";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  experimental_PluginRpcRefusal,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BLOCKER_KIND,
  BLOCKER_TIME_ZONE,
  createBlockerLedger,
  DEFAULT_BLOCKER_DAILY_CAP,
  MAX_BLOCKER_DAILY_CAP,
  pacificDay,
  type BlockerDayView,
} from "./blocker-push.js";
import {
  addPushSubscriptionInputSchema,
  BLOCKER_BODY_MAX_LENGTH,
  BLOCKER_TITLE_MAX_LENGTH,
  CLIENT_NOTIFICATION_CHANNEL,
  clientChannelSchema,
  DEFAULT_EXPO_PUSH_URL,
  DEVICE_LABEL_MAX_LENGTH,
  EXPO_PUSH_TOKEN_MAX_LENGTH,
  blockerSourceSchema,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
  notifyBlockerInputSchema,
  pushNotificationsRpcContract,
  sendNotificationInputSchema,
  sendNotificationRpcContract,
  type ClientNotification,
  type DeliveryChannel,
  type NotifyBlockerInput,
  type NotifyBlockerOutput,
  type PushSubscriptionSummary,
} from "./contract.js";
import { truncate } from "./notification-text.js";
import {
  createNotificationPreferences,
  describeNotificationSource,
  NOTIFICATION_LEVEL_LABELS,
  notificationLevelSchema,
  ownNotificationLevelSchema,
  type ThreadNotifications,
} from "./preferences.js";
import {
  createPushSender,
  SendNotificationError,
  type CreatePushSenderArgs,
  type LastSendOutcome,
} from "./sender.js";
import { createPushSubscriptionStore } from "./subscriptions.js";

interface PushNotificationsPluginOptions {
  coalesceMs?: number;
  createId?: () => string;
  fetch?: CreatePushSenderArgs["fetch"];
  now?: () => number;
}

interface StatusView {
  enabled: true;
  subscriptionCount: number;
  mobileEnabled: boolean;
  webEnabled: boolean;
  desktopEnabled: boolean;
  defaultLevel: string;
  childLevel: string;
  relayUrl: string;
  lastSendOutcome: LastSendOutcome;
  blockerPush: {
    timeZone: string;
    cap: number;
    today: string;
    days: BlockerDayView[];
  };
}

type RpcCaller = { kind: "plugin"; pluginId: string } | { kind: "client" };

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

function formatSubscriptions(
  subscriptions: readonly PushSubscriptionSummary[],
): string {
  if (subscriptions.length === 0) return "No push devices registered";
  return [
    "ID\tDevice\tPlatform\tLast seen\tToken suffix",
    ...subscriptions.map((subscription) =>
      [
        subscription.id,
        subscription.deviceLabel,
        subscription.platform,
        new Date(subscription.lastSeenAt).toISOString(),
        subscription.tokenSuffix,
      ].join("\t"),
    ),
  ].join("\n");
}

function formatLastOutcome(outcome: LastSendOutcome): string {
  if (outcome.status === "never") return "Never";
  if (outcome.status === "sent") {
    return `Sent ${outcome.sentCount} at ${new Date(outcome.at).toISOString()}`;
  }
  return `Failed at ${new Date(outcome.at).toISOString()}: ${outcome.reason}`;
}

function formatBlockerPush(view: StatusView["blockerPush"]): string[] {
  const todayRow = view.days.find((entry) => entry.day === view.today);
  const sources = Object.entries(todayRow?.sources ?? {});
  const lines = [
    `Blocker pushes (${view.timeZone}, cap ${view.cap} per day across all sources)`,
  ];
  if (sources.length === 0) lines.push(`  ${view.today}: none`);
  else if (todayRow) {
    lines.push(
      `  ${view.today} total: sent ${todayRow.total.sent}, capped ${todayRow.total.capped}, deduped ${todayRow.total.deduped}`,
    );
  }
  for (const [source, counts] of sources) {
    lines.push(
      `  ${view.today} ${source}: sent ${counts.sent}, capped ${counts.capped}, deduped ${counts.deduped}`,
    );
  }
  return lines;
}

function formatNotifyResult(result: NotifyBlockerOutput): string {
  if (result.outcome === "capped") {
    return `Not pushed: the daily cap of ${result.cap} blocker pushes across all sources was reached (${result.id})`;
  }
  if (result.outcome === "deduped") {
    return `Not pushed: already pushed today for that dedupe key (${result.id})`;
  }
  const mobile = result.delivery
    ? `, ${result.delivery.mobileSent} of ${result.delivery.mobileDevices} devices`
    : "";
  return `Pushed ${result.sentToday} of ${result.cap} today for ${result.source}${mobile} (${result.id})`;
}

function formatStatus(status: StatusView): string {
  return [
    `Enabled: ${status.enabled}`,
    `Mobile: ${status.mobileEnabled}`,
    `Web: ${status.webEnabled}`,
    `Desktop: ${status.desktopEnabled}`,
    `Default level: ${status.defaultLevel}`,
    `Child thread level: ${status.childLevel}`,
    `Subscriptions: ${status.subscriptionCount}`,
    `Relay URL: ${status.relayUrl}`,
    `Last send: ${formatLastOutcome(status.lastSendOutcome)}`,
    ...formatBlockerPush(status.blockerPush),
  ].join("\n");
}

function formatThreadNotifications(
  threadId: string,
  row: ThreadNotifications,
): string {
  return `Notifications for ${threadId}: ${row.effective} (${describeNotificationSource(row)})`;
}

function formatSent(channels: readonly DeliveryChannel[]): string {
  return `Sent to ${channels.join(", ")}`;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function createPushNotificationsPlugin(
  options: PushNotificationsPluginOptions = {},
) {
  return async function pushNotificationsPlugin(
    bb: BbPluginApi,
  ): Promise<void> {
    const settings = bb.settings.define({
      mobileEnabled: {
        type: "boolean",
        label: "Mobile notifications",
        description:
          "Send push messages to your registered phones and tablets.",
        default: true,
      },
      webEnabled: {
        type: "boolean",
        label: "Web notifications",
        description:
          "Show system notifications while bb is open in a browser. Each browser needs notification permission.",
        default: true,
      },
      desktopEnabled: {
        type: "boolean",
        label: "Desktop notifications",
        description:
          "Show system notifications while the bb desktop app is running.",
        default: true,
      },
      defaultLevel: {
        type: "select",
        label: "Default notifications",
        description:
          "For threads you haven't set. Needs input only skips finished turns.",
        options: [...notificationLevelSchema.options],
        experimental_optionLabels: {
          all: NOTIFICATION_LEVEL_LABELS.all,
          "input-only": NOTIFICATION_LEVEL_LABELS["input-only"],
          muted: NOTIFICATION_LEVEL_LABELS.muted,
        },
        default: "all",
        experimental_schema: notificationLevelSchema,
      },
      childLevel: {
        type: "select",
        label: "Child thread notifications",
        description:
          "For child threads you haven't set. A thread's level also limits its child threads.",
        options: [...ownNotificationLevelSchema.options],
        experimental_optionLabels: {
          inherit: NOTIFICATION_LEVEL_LABELS.inherit,
          all: NOTIFICATION_LEVEL_LABELS.all,
          "input-only": NOTIFICATION_LEVEL_LABELS["input-only"],
          muted: NOTIFICATION_LEVEL_LABELS.muted,
        },
        default: "input-only",
        experimental_schema: ownNotificationLevelSchema,
      },
      blockerDailyCap: {
        type: "number",
        label: "Blocker pushes per day",
        description:
          "The most blocker notifications pushed per local day (America/Los_Angeles) across all sources combined. Further ones are counted but not sent.",
        default: DEFAULT_BLOCKER_DAILY_CAP,
        experimental_schema: z.number().int().min(0).max(MAX_BLOCKER_DAILY_CAP),
      },
      expoPushUrl: {
        type: "string",
        label: "Expo push relay URL",
        description: "The Expo push relay endpoint used for mobile delivery.",
        default: DEFAULT_EXPO_PUSH_URL,
        experimental_schema: z.string().url(),
      },
    });
    const preferences = createNotificationPreferences({
      bb,
      getDefaults: async () => {
        const { defaultLevel, childLevel } = await settings.get();
        return {
          defaultLevel: notificationLevelSchema.parse(defaultLevel),
          childLevel: ownNotificationLevelSchema.parse(childLevel),
        };
      },
      publish: (threadIds) =>
        bb.rpc.experimental_invalidate(threadIds.map((id) => `thread:${id}`)),
    });
    const subscriptions = createPushSubscriptionStore(bb, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.createId === undefined ? {} : { createId: options.createId }),
    });
    const sender = createPushSender({
      bb,
      subscriptions,
      getDeliverySettings: () => settings.get(),
      getExpoPushUrl: async () => (await settings.get()).expoPushUrl,
      getNotificationLevel: (thread) => preferences.effectiveLevel(thread),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.coalesceMs === undefined
        ? {}
        : { coalesceMs: options.coalesceMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    const now = options.now ?? Date.now;
    const blockerLedger = createBlockerLedger(bb);

    async function notifyBlocker(
      input: NotifyBlockerInput,
      caller: RpcCaller,
    ): Promise<NotifyBlockerOutput> {
      if (input.kind !== BLOCKER_KIND) {
        throw new experimental_PluginRpcRefusal({
          code: "invalid",
          message: `Unsupported notification kind "${input.kind.slice(0, 40)}"; only "${BLOCKER_KIND}" is accepted`,
        });
      }
      let source: string;
      if (caller.kind === "plugin") {
        if (input.source !== undefined && input.source !== caller.pluginId) {
          throw new experimental_PluginRpcRefusal({
            code: "forbidden",
            message: `A plugin can only notify as itself (${caller.pluginId})`,
          });
        }
        source = caller.pluginId;
      } else if (input.source !== undefined) {
        source = input.source;
      } else {
        throw new experimental_PluginRpcRefusal({
          code: "invalid",
          message: "A source is required",
        });
      }
      if (!blockerSourceSchema.safeParse(source).success) {
        throw new experimental_PluginRpcRefusal({
          code: "invalid",
          message: "The source must use lowercase letters, digits, . _ -",
        });
      }
      if (!sender.isRunning()) {
        throw new SendNotificationError(
          "sender_stopped",
          "Push notifications are not running",
        );
      }
      const at = now();
      const id = randomUUID();
      const { blockerDailyCap } = await settings.get();
      const admission = await blockerLedger.admit({
        source,
        dedupeKey: input.dedupeKey ?? null,
        cap: blockerDailyCap,
        at,
      });
      let delivery: NotifyBlockerOutput["delivery"] = null;
      if (admission.outcome === "sent") {
        try {
          delivery = await sender.deliverBlocker({
            id,
            title: truncate(input.title, BLOCKER_TITLE_MAX_LENGTH),
            body: truncate(input.body, BLOCKER_BODY_MAX_LENGTH),
            threadId: input.threadId ?? null,
          });
        } catch (error) {
          bb.log.error(
            `Blocker push delivery failed for ${source}: ${error instanceof Error ? error.message : String(error)}`,
          );
          delivery = {
            web: false,
            desktop: false,
            mobileDevices: 0,
            mobileSent: 0,
            mobileFailure: "delivery failed",
          };
        }
      }
      return {
        id,
        at,
        day: admission.day,
        source,
        outcome: admission.outcome,
        capped: admission.outcome === "capped",
        deduped: admission.outcome === "deduped",
        cap: admission.cap,
        sentToday: admission.sentToday,
        delivery,
      };
    }

    async function status(): Promise<StatusView> {
      const [
        {
          expoPushUrl,
          mobileEnabled,
          webEnabled,
          desktopEnabled,
          defaultLevel,
          childLevel,
          blockerDailyCap,
        },
        rows,
        blockerDays,
      ] = await Promise.all([
        settings.get(),
        subscriptions.list(),
        blockerLedger.recent(now()),
      ]);
      return {
        enabled: true,
        subscriptionCount: rows.length,
        mobileEnabled,
        webEnabled,
        desktopEnabled,
        defaultLevel,
        childLevel,
        relayUrl: expoPushUrl,
        lastSendOutcome: sender.getLastOutcome(),
        blockerPush: {
          timeZone: BLOCKER_TIME_ZONE,
          cap: blockerDailyCap,
          today: pacificDay(now()),
          days: blockerDays,
        },
      };
    }

    async function sendTest(channel: "web" | "desktop") {
      const config = await settings.get();
      if (!(channel === "web" ? config.webEnabled : config.desktopEnabled)) {
        throw new Error(`${channel} notifications are disabled`);
      }
      bb.realtime.publish(CLIENT_NOTIFICATION_CHANNEL, {
        id: randomUUID(),
        title: "bb notifications are working",
        body: "You’ll be notified when a thread needs your attention.",
        threadId: null,
        channels: [channel],
      } satisfies ClientNotification);
      return { ok: true as const };
    }

    bb.rpc.register(
      sendNotificationRpcContract,
      {
        "notifications.send": async (input, context) => ({
          ok: true as const,
          channels: await sender.send(input, context.experimental_caller),
        }),
      },
      {
        experimental_discoverable: true,
        experimental_description:
          "Notifications on bb's mobile, web and desktop channels.",
      },
    );

    bb.rpc.register(pushNotificationsRpcContract, {
      "notifications.test": ({ channel }) => sendTest(channel),
      "notifications.notify": (input, context) =>
        notifyBlocker(input, context.experimental_caller),
      "pushSubscriptions.list": async () => ({
        subscriptions: await subscriptions.listSummaries(),
      }),
      "pushSubscriptions.add": (input) => subscriptions.add(input),
      "pushSubscriptions.remove": async ({ id }) => {
        if (!(await subscriptions.remove(id))) {
          throw new Error(`Push subscription not found: ${id}`);
        }
        return { ok: true as const };
      },
      "threadNotifications.keyed": async ({ keys }) => {
        const rows = await preferences.list(keys);
        return Object.fromEntries(
          keys.map((key) => [
            key,
            rows[key] ?? { own: "inherit" as const, ancestorCap: null },
          ]),
        );
      },
      "threadNotifications.list": async ({ threadIds }) => ({
        threads: await preferences.list(threadIds),
      }),
      "threadNotifications.set": ({ threadId, level }) =>
        preferences.set(threadId, level),
    });

    bb.cli.register(
      defineCli({
        name: "push-notifications",
        summary: "Manage mobile, web, and desktop notifications",
        description:
          "Mobile devices receive Expo push messages; web and desktop clients receive system notifications while they are open.",
        commands: {
          test: cliCommand({
            summary:
              "Send a test to connected web or desktop clients with permission",
            positionals: [
              {
                name: "channel",
                description: "Client type to notify: web or desktop",
                required: true,
              },
            ],
            options: { json: JSON_OPTION },
            async run(input) {
              const channel = clientChannelSchema.safeParse(
                input.positionals.channel,
              );
              if (!channel.success) {
                throw new PluginCliError("Use web or desktop", {
                  code: "invalid_channel",
                  hint: "Mobile devices are tested from the phone itself; this command only reaches web and desktop clients.",
                });
              }
              try {
                await sendTest(channel.data);
              } catch (error) {
                throw new PluginCliError(
                  error instanceof Error ? error.message : String(error),
                  {
                    code: "channel_disabled",
                    hint: `Turn it on with \`bb plugin config push-notifications set ${channel.data}Enabled true\`.`,
                  },
                );
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ ok: true, channel: channel.data })
                  : `Test sent to connected ${channel.data} clients with notification permission`,
              };
            },
          }),
          send: cliCommand({
            summary: "Send a notification to every enabled channel",
            description: `Uses the same delivery as thread notifications: connected web and desktop clients with permission, and every registered mobile device. The title is cut to ${NOTIFICATION_TITLE_MAX_LENGTH} characters and the body to ${NOTIFICATION_BODY_MAX_LENGTH}. With --thread, a click opens that thread; otherwise it opens bb.`,
            options: {
              title: {
                type: "string",
                required: true,
                placeholder: "text",
                description: "Notification title",
              },
              body: {
                type: "string",
                placeholder: "text",
                description: "Notification text under the title",
              },
              thread: {
                type: "string",
                placeholder: "thread-id",
                description: "Thread to open when the notification is clicked",
              },
              json: JSON_OPTION,
            },
            async run(input) {
              const parsed = sendNotificationInputSchema.safeParse({
                title: input.options.title,
                ...(input.options.body === undefined
                  ? {}
                  : { body: input.options.body }),
                ...(input.options.thread === undefined
                  ? {}
                  : { threadId: input.options.thread }),
              });
              if (!parsed.success) {
                throw new PluginCliError(
                  parsed.error.issues
                    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                    .join("; "),
                  { code: "invalid_notification" },
                );
              }
              let channels: DeliveryChannel[];
              try {
                channels = await sender.send(parsed.data, { kind: "client" });
              } catch (error) {
                if (!(error instanceof SendNotificationError)) throw error;
                throw new PluginCliError(
                  error.message,
                  error.code === "thread_not_found"
                    ? { code: error.code }
                    : {
                        code: error.code,
                        hint: "Check the push-sender service in `bb plugin list`.",
                      },
                );
              }
              if (channels.length === 0) {
                throw new PluginCliError(
                  "No channel received the notification",
                  {
                    code: "not_delivered",
                    hint: "Run `bb push-notifications status` to see which channels are on, how many devices are registered, and the last mobile send.",
                  },
                );
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ ok: true, channels })
                  : formatSent(channels),
              };
            },
          }),
          notify: cliCommand({
            summary: "Push a blocker notification, subject to a daily cap",
            description:
              "Sends a blocker notification to web, desktop, and registered mobile devices. At most blockerDailyCap blocker pushes are sent per America/Los_Angeles day across all sources; further requests exit 0 with capped set and send nothing. Only the blocker kind is accepted.",
            options: {
              source: {
                type: "string",
                required: true,
                placeholder: "plugin-id",
                description: "Plugin or tool the notification comes from",
              },
              kind: {
                type: "string",
                required: true,
                placeholder: BLOCKER_KIND,
                description: `Notification kind; only ${BLOCKER_KIND} is accepted`,
              },
              title: {
                type: "string",
                required: true,
                description: `Notification title, shown at most ${BLOCKER_TITLE_MAX_LENGTH} characters`,
              },
              body: {
                type: "string",
                required: true,
                description: `Notification text, shown at most ${BLOCKER_BODY_MAX_LENGTH} characters`,
              },
              thread: {
                type: "string",
                placeholder: "thread-id",
                description: "Thread to open when the notification is tapped",
              },
              "dedupe-key": {
                type: "string",
                placeholder: "key",
                description:
                  "A key already pushed today for this source is not pushed again",
              },
              json: JSON_OPTION,
            },
            async run(input) {
              const parsed = notifyBlockerInputSchema.safeParse({
                source: input.options.source,
                kind: input.options.kind,
                title: input.options.title,
                body: input.options.body,
                ...(input.options.thread === undefined
                  ? {}
                  : { threadId: input.options.thread }),
                ...(input.options["dedupe-key"] === undefined
                  ? {}
                  : { dedupeKey: input.options["dedupe-key"] }),
              });
              if (!parsed.success) {
                throw new PluginCliError(
                  parsed.error.issues.map((issue) => issue.message).join("; "),
                  { code: "invalid_notification" },
                );
              }
              let result: NotifyBlockerOutput;
              try {
                result = await notifyBlocker(parsed.data, { kind: "client" });
              } catch (error) {
                if (error instanceof experimental_PluginRpcRefusal) {
                  throw new PluginCliError(error.message, {
                    code: "invalid_notification",
                    hint: `Only the ${BLOCKER_KIND} kind is accepted.`,
                  });
                }
                if (error instanceof SendNotificationError) {
                  throw new PluginCliError(error.message, {
                    code: error.code,
                    hint: "Check the push-sender service in `bb plugin list`.",
                  });
                }
                throw error;
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(result)
                  : formatNotifyResult(result),
              };
            },
          }),
          list: cliCommand({
            summary: "List registered push devices",
            options: { json: JSON_OPTION },
            async run(input) {
              const rows = await subscriptions.listSummaries();
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ subscriptions: rows })
                  : formatSubscriptions(rows),
              };
            },
          }),
          add: cliCommand({
            summary: "Register or refresh an Expo push device",
            options: {
              token: {
                type: "string",
                required: true,
                placeholder: "expo-push-token",
                aliases: ["expo-token", "push-token", "expo-push-token"],
                description: `Expo push token the device reported, at most ${EXPO_PUSH_TOKEN_MAX_LENGTH} characters`,
              },
              platform: {
                type: "enum",
                required: true,
                values: ["ios", "android"],
                aliases: ["os"],
                description: "Device operating system",
              },
              label: {
                type: "string",
                required: true,
                placeholder: "device-label",
                aliases: ["device-label", "device", "name"],
                description: `Name shown for the device, at most ${DEVICE_LABEL_MAX_LENGTH} characters`,
              },
              json: JSON_OPTION,
            },
            async run(input) {
              const parsed = addPushSubscriptionInputSchema.safeParse({
                expoPushToken: input.options.token,
                platform: input.options.platform,
                deviceLabel: input.options.label,
              });
              if (!parsed.success) {
                throw new PluginCliError(
                  parsed.error.issues.map((issue) => issue.message).join("; "),
                  { code: "invalid_device" },
                );
              }
              const result = await subscriptions.add(parsed.data);
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(result)
                  : `${result.created ? "Registered" : "Refreshed"} push device ${result.id}`,
              };
            },
          }),
          remove: cliCommand({
            summary: "Remove a registered push device",
            positionals: [
              {
                name: "id",
                description:
                  "Subscription id, as `bb push-notifications list` prints it",
                required: true,
              },
            ],
            options: { json: JSON_OPTION },
            async run(input) {
              const id = input.positionals.id;
              if (!(await subscriptions.remove(id))) {
                throw new PluginCliError(`Push subscription not found: ${id}`, {
                  code: "subscription_not_found",
                  hint: "Run `bb push-notifications list` for the registered ids.",
                });
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ id, removed: true })
                  : `Removed push device ${id}`,
              };
            },
          }),
          thread: cliCommand({
            summary: "Show or set a thread's notification level",
            description:
              "Without --level, prints the resolved level and where it comes from. A thread uses its own level, else childLevel if it has a parent, else defaultLevel; every ancestor's own level caps it.",
            positionals: [
              {
                name: "thread",
                description: "Thread id",
                required: true,
              },
            ],
            options: {
              level: {
                type: "enum",
                values: ownNotificationLevelSchema.options,
                description:
                  "Set the thread's own level; inherit clears it so the parent or default applies",
              },
              json: JSON_OPTION,
            },
            async run(input) {
              const threadId = input.positionals.thread;
              let row: ThreadNotifications;
              try {
                if (input.options.level !== undefined) {
                  await preferences.set(threadId, input.options.level);
                }
                row = await preferences.get(threadId);
              } catch (error) {
                throw new PluginCliError(
                  error instanceof Error ? error.message : String(error),
                  { code: "thread_not_found" },
                );
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ threadId, ...row })
                  : formatThreadNotifications(threadId, row),
              };
            },
          }),
          status: cliCommand({
            summary: "Show push delivery status",
            options: { json: JSON_OPTION },
            async run(input) {
              const view = await status();
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(view)
                  : formatStatus(view),
              };
            },
          }),
        },
      }),
    );

    bb.events.on("interaction.pending", (payload) => {
      sender.onInteractionPending(payload);
    });
    bb.events.on("thread.idle", (payload) => {
      sender.onThreadIdle(payload);
    });
    bb.events.on("thread.failed", (payload) => {
      sender.onThreadFailed(payload);
    });
    bb.events.on("experimental_thread.parentChanged", ({ thread }) =>
      preferences.publishSubtree(thread.id),
    );
    bb.events.on("thread.unarchived", ({ thread }) =>
      preferences.publishSubtree(thread.id),
    );
    bb.background.service("push-sender", {
      async start(signal) {
        await sender.start();
        try {
          await waitForAbort(signal);
        } finally {
          await sender.stop();
        }
      },
    });
  };
}

export default createPushNotificationsPlugin();
