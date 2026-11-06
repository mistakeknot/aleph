import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { BLOCKER_SOURCE_PATTERN, blockerCountsSchema } from "./blocker-push.js";
import {
  ownNotificationLevelSchema,
  threadNotificationInputsSchema,
} from "./preferences.js";

export const DEFAULT_EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_TOKEN_MAX_LENGTH = 512;
export const DEVICE_LABEL_MAX_LENGTH = 120;

export const pushPlatformSchema = z.enum(["ios", "android"]);

export const pushSubscriptionSchema = z
  .object({
    id: z.string().min(1),
    expoPushToken: z.string().min(1).max(EXPO_PUSH_TOKEN_MAX_LENGTH),
    platform: pushPlatformSchema,
    deviceLabel: z.string().min(1).max(DEVICE_LABEL_MAX_LENGTH),
    createdAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
  })
  .strict();

export const pushSubscriptionSummarySchema = pushSubscriptionSchema
  .omit({ expoPushToken: true })
  .extend({ tokenSuffix: z.string().min(1).max(6) })
  .strict();

export const addPushSubscriptionInputSchema = z
  .object({
    expoPushToken: z.string().trim().min(1).max(EXPO_PUSH_TOKEN_MAX_LENGTH),
    platform: pushPlatformSchema,
    deviceLabel: z.string().trim().min(1).max(DEVICE_LABEL_MAX_LENGTH),
  })
  .strict();

export const removePushSubscriptionInputSchema = z
  .object({ id: z.string().min(1) })
  .strict();

export const clientChannelSchema = z.enum(["web", "desktop"]);
export const CLIENT_NOTIFICATION_CHANNEL = "notification";
export const clientNotificationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    body: z.string(),
    threadId: z.string().nullable(),
    channels: z.array(clientChannelSchema),
  })
  .strict();
export type ClientNotification = z.infer<typeof clientNotificationSchema>;

export const THREAD_NOTIFICATIONS_LIST_MAX_IDS = 200;

export const BLOCKER_TITLE_MAX_LENGTH = 80;
export const BLOCKER_BODY_MAX_LENGTH = 180;
export const BLOCKER_FIELD_MAX_LENGTH = 500;

export const blockerSourceSchema = z
  .string()
  .regex(BLOCKER_SOURCE_PATTERN, "Use lowercase letters, digits, . _ -");

export const notifyBlockerInputSchema = z
  .object({
    source: blockerSourceSchema.optional(),
    kind: z.string().min(1),
    title: z.string().trim().min(1).max(BLOCKER_FIELD_MAX_LENGTH),
    body: z.string().trim().min(1).max(BLOCKER_FIELD_MAX_LENGTH),
    threadId: z.string().min(1).max(200).optional(),
    url: z.string().min(1).max(BLOCKER_FIELD_MAX_LENGTH).optional(),
    dedupeKey: z.string().min(1).max(200).optional(),
  })
  .strict();

export const notifyBlockerOutputSchema = z
  .object({
    id: z.string().min(1),
    at: z.number().int().nonnegative(),
    day: z.string(),
    source: blockerSourceSchema,
    outcome: z.enum(["sent", "capped", "deduped"]),
    capped: z.boolean(),
    deduped: z.boolean(),
    cap: z.number().int().nonnegative(),
    sentToday: z.number().int().nonnegative(),
    delivery: z
      .object({
        web: z.boolean(),
        desktop: z.boolean(),
        mobileDevices: z.number().int().nonnegative(),
        mobileSent: z.number().int().nonnegative(),
        mobileFailure: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export const blockerStatusSchema = z
  .object({
    timeZone: z.string(),
    cap: z.number().int().nonnegative(),
    today: z.string(),
    days: z.array(
      z
        .object({
          day: z.string(),
          total: blockerCountsSchema,
          sources: z.record(z.string(), blockerCountsSchema),
        })
        .strict(),
    ),
  })
  .strict();

export type NotifyBlockerInput = z.infer<typeof notifyBlockerInputSchema>;
export type NotifyBlockerOutput = z.infer<typeof notifyBlockerOutputSchema>;

const emptyInputSchema = z.object({}).strict();
export const listPushSubscriptionsOutputSchema = z
  .object({ subscriptions: z.array(pushSubscriptionSummarySchema) })
  .strict();

export const pushNotificationsRpcContract = defineRpcContract({
  "notifications.test": {
    input: z.object({ channel: clientChannelSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "notifications.notify": {
    input: notifyBlockerInputSchema,
    output: notifyBlockerOutputSchema,
  },
  "pushSubscriptions.list": {
    input: emptyInputSchema,
    output: listPushSubscriptionsOutputSchema,
  },
  "pushSubscriptions.add": {
    input: addPushSubscriptionInputSchema,
    output: z.object({ id: z.string().min(1), created: z.boolean() }).strict(),
  },
  "pushSubscriptions.remove": {
    input: removePushSubscriptionInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "threadNotifications.list": {
    input: z
      .object({
        threadIds: z
          .array(z.string().min(1))
          .min(1)
          .max(THREAD_NOTIFICATIONS_LIST_MAX_IDS),
      })
      .strict(),
    output: z
      .object({
        threads: z.record(z.string(), threadNotificationInputsSchema),
      })
      .strict(),
  },
  "threadNotifications.keyed": {
    input: z
      .object({
        keys: z
          .array(z.string().min(1))
          .min(1)
          .max(THREAD_NOTIFICATIONS_LIST_MAX_IDS),
      })
      .strict(),
    output: z.record(z.string(), threadNotificationInputsSchema),
    keyTags: (key) => [`thread:${key}`],
  },
  "threadNotifications.set": {
    input: z
      .object({
        threadId: z.string().min(1),
        level: ownNotificationLevelSchema,
      })
      .strict(),
    output: threadNotificationInputsSchema,
  },
});

export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;
export type PushSubscriptionSummary = z.infer<
  typeof pushSubscriptionSummarySchema
>;
export type AddPushSubscriptionInput = z.infer<
  typeof addPushSubscriptionInputSchema
>;
