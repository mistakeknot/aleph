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
});
