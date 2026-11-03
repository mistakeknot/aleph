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
});
