import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { wikiListSchema, wikiPageSchema } from "./wiki-types.js";

export const wikiProjectSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    hasCheckout: z.boolean(),
  })
  .strict();
export type WikiProject = z.infer<typeof wikiProjectSchema>;

export const wikiPageResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("found"), page: wikiPageSchema }).strict(),
  z.object({ state: z.literal("missing") }).strict(),
]);
export type WikiPageResult = z.infer<typeof wikiPageResultSchema>;

export const PIN_BODY_MAX = 4000;

export const claimTargetSchema = z
  .object({
    label: z.string().min(1),
    context: z.string(),
    ordinal: z.number().int().min(0),
    groupSize: z.number().int().min(1),
  })
  .strict();

export const pinAnchorSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("page") }).strict(),
  z
    .object({
      state: z.literal("claim"),
      line: z.number().int().min(1),
      identical: z.boolean(),
    })
    .strict(),
  z
    .object({
      state: z.literal("detached"),
      reason: z.enum(["claim-changed", "ambiguous", "page-missing"]),
    })
    .strict(),
  z.object({ state: z.literal("unverified"), reason: z.string() }).strict(),
]);

export const pinSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    pageId: z.string().min(1),
    sourcePath: z.string().min(1),
    claim: claimTargetSchema.nullable(),
    body: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    resolvedAt: z.string().nullable(),
    threadIds: z.array(z.string()),
    anchor: pinAnchorSchema,
  })
  .strict();
export type Pin = z.infer<typeof pinSchema>;

export const pinTag = (projectId: string): string =>
  `design-wiki:pins:${projectId}`;

const pinResult = <Reason extends [string, ...string[]]>(reasons: Reason) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), pin: pinSchema }).strict(),
    z.object({ ok: z.literal(false), reason: z.enum(reasons) }).strict(),
  ]);

export const createPinResultSchema = pinResult([
  "page-missing",
  "unknown-claim",
  "stale-claim",
  "unverified",
  "invalid-body",
]);
export const updatePinResultSchema = pinResult(["not-found", "invalid-body"]);
export const linkPinThreadResultSchema = pinResult([
  "not-found",
  "thread-not-found",
  "wrong-project",
]);

export const pinTaskTag = (projectId: string): string =>
  `design-wiki:pin-tasks:${projectId}`;

export const taskRefSchema = z
  .object({ id: z.string().min(1), key: z.string().min(1) })
  .strict();

export const taskBoardSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    prefix: z.string().min(1),
  })
  .strict();
export type TaskBoard = z.infer<typeof taskBoardSchema>;

export const PIN_TASK_FAILURES = [
  "not-found",
  "no-board",
  "board-required",
  "wrong-board",
  "task-not-found",
  "tasks-unavailable",
  "tasks-refused",
  "not-linked",
] as const;

export const pinTaskResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: taskRefSchema }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(PIN_TASK_FAILURES),
      message: z.string(),
      boards: z.array(taskBoardSchema).optional(),
      task: taskRefSchema.optional(),
    })
    .strict(),
]);
export type PinTaskResult = z.infer<typeof pinTaskResultSchema>;

export const pinTaskItemSchema = z
  .object({
    pinId: z.string().min(1),
    taskId: z.string().min(1),
    key: z.string().min(1),
    state: z.enum(["found", "removed", "unavailable"]),
    message: z.string().nullable(),
    title: z.string().nullable(),
    status: z.string().nullable(),
    threads: z.array(
      z
        .object({
          threadId: z.string(),
          title: z.string(),
          liveStatus: z.string(),
        })
        .strict(),
    ),
    pullRequests: z.array(
      z
        .object({
          url: z.string(),
          number: z.number().int(),
          title: z.string(),
          state: z.string(),
        })
        .strict(),
    ),
    unavailableThreadIds: z.array(z.string()),
  })
  .strict();
export type PinTaskItem = z.infer<typeof pinTaskItemSchema>;

export const pinDecisionTag = (projectId: string): string =>
  `design-wiki:pin-decisions:${projectId}`;

export const pinDecisionOptionSchema = z
  .object({ id: z.string().min(1), label: z.string() })
  .strict();

export const pinDecisionAnswerSchema = z
  .object({
    decisionId: z.string().min(1),
    revision: z.string().min(1),
    question: z.string(),
    recommendation: z.string().nullable(),
    options: z.array(pinDecisionOptionSchema).min(1),
  })
  .strict();

export const pinDecisionItemSchema = z
  .object({
    pinId: z.string().min(1),
    key: z.string().min(1),
    origin: z.enum(["claim", "page", "task"]),
    state: z.enum(["open", "closed", "missing", "unavailable"]),
    cardState: z.string().nullable(),
    title: z.string().nullable(),
    answer: pinDecisionAnswerSchema.nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export type PinDecisionItem = z.infer<typeof pinDecisionItemSchema>;
export type PinDecisionAnswer = z.infer<typeof pinDecisionAnswerSchema>;

export const PIN_DECISION_FAILURES = [
  "not-found",
  "not-linked",
  "not-open",
  "not-answerable",
  "stale",
  "refused",
  "unavailable",
  "unknown",
] as const;

export const answerPinDecisionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(PIN_DECISION_FAILURES),
      message: z.string(),
    })
    .strict(),
]);
export type AnswerPinDecisionResult = z.infer<
  typeof answerPinDecisionResultSchema
>;

export const designWikiRpcContract = defineRpcContract({
  projects: {
    experimental_description:
      "The projects whose design wiki can be opened, with whether each has a checkout on a host.",
    input: z.object({}).strict(),
    output: z.array(wikiProjectSchema),
  },
  list: {
    experimental_description:
      "The CUJ and requirement pages under docs/wiki/src in the project's repository root, plus a row for each page that failed to parse.",
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: wikiListSchema,
  },
  page: {
    experimental_description:
      "One wiki page of the project, with its Markdown body and the claim markers found in it.",
    input: z
      .object({ projectId: z.string().min(1), pageId: z.string().min(1) })
      .strict(),
    output: wikiPageResultSchema,
  },
  pins: {
    experimental_description:
      "The pins (sticky notes) of a project's design wiki, each with its page, claim, linked threads and whether it still matches the page. Pins live in plugin storage, never in the repository.",
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.array(pinSchema),
    tags: (input) => [pinTag(input.projectId)],
  },
  createPin: {
    experimental_description:
      "Add a pin to a wiki page, or to one claim on it. The claim must match the page as it is now. Never edits the page.",
    input: z
      .object({
        projectId: z.string().min(1),
        pageId: z.string().min(1),
        claim: claimTargetSchema.nullable(),
        body: z.string().max(20_000),
      })
      .strict(),
    output: createPinResultSchema,
  },
  updatePin: {
    experimental_description:
      "Change a pin's note text, or resolve or reopen it.",
    input: z
      .object({
        projectId: z.string().min(1),
        pinId: z.string().min(1),
        body: z.string().max(20_000).optional(),
        resolved: z.boolean().optional(),
      })
      .strict(),
    output: updatePinResultSchema,
  },
  deletePin: {
    experimental_description: "Delete a pin and its thread links.",
    input: z
      .object({ projectId: z.string().min(1), pinId: z.string().min(1) })
      .strict(),
    output: z.object({ deleted: z.boolean() }).strict(),
  },
  linkPinThread: {
    experimental_description:
      "Record that a thread of the same project discusses a pin.",
    input: z
      .object({
        projectId: z.string().min(1),
        pinId: z.string().min(1),
        threadId: z.string().min(1),
      })
      .strict(),
    output: linkPinThreadResultSchema,
  },
  createPinTask: {
    experimental_description:
      "Make a card on the task board linked to the project from a pin, with a back-link to the pin and page in the card description, and record the card on the pin. A pin may hold several cards. If the project has several linked boards, taskProjectId picks one.",
    input: z
      .object({
        projectId: z.string().min(1),
        pinId: z.string().min(1),
        taskProjectId: z.string().min(1).optional(),
      })
      .strict(),
    output: pinTaskResultSchema,
  },
  linkPinTask: {
    experimental_description:
      "Record an existing card, by its display key, on a pin. The card must be on a board linked to the pin's project. Use it to recover a card that was created but not recorded.",
    input: z
      .object({
        projectId: z.string().min(1),
        pinId: z.string().min(1),
        taskKey: z.string().trim().min(1),
      })
      .strict(),
    output: pinTaskResultSchema,
  },
  unlinkPinTask: {
    experimental_description:
      "Stop showing a card on a pin. The card itself is left alone.",
    input: z
      .object({
        projectId: z.string().min(1),
        pinId: z.string().min(1),
        taskId: z.string().min(1),
      })
      .strict(),
    output: z.object({ removed: z.boolean() }).strict(),
  },
  pinTasks: {
    experimental_description:
      "The cards recorded on the pins of a project, each with its live status, agent threads, pull requests and merge state read from the tasks plugin. A card that no longer exists is reported as removed.",
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.array(pinTaskItemSchema),
    tags: (input) => [pinTaskTag(input.projectId)],
  },
  pinDecisions: {
    experimental_description:
      "The decision cards shown on the pins of a project, read from the autarch (Citadel) plugin. A pin on a claim shows the claim's cards, a pin on a page shows the page card, and every pin shows the cards recorded on it. A detached or unverified pin shows only recorded cards. Each open card that can be answered in place carries its options and revision.",
    input: z.object({ projectId: z.string().min(1) }).strict(),
    output: z.array(pinDecisionItemSchema),
    tags: (input) => [pinDecisionTag(input.projectId)],
  },
  answerPinDecision: {
    experimental_description:
      "Answer a decision card shown on a pin by picking one of its options, through the autarch (Citadel) plugin's pick with the revision the reader saw and a fresh pickId per click. A changed revision is reported as stale and never retried.",
    input: z
      .object({
        projectId: z.string().min(1),
        pinId: z.string().min(1),
        key: z.string().min(1),
        optionId: z.string().min(1),
        revision: z.string().min(1),
        pickId: z.string().min(1),
      })
      .strict(),
    output: answerPinDecisionResultSchema,
  },
});
