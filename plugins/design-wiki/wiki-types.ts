import { z } from "zod";

export const WIKI_STATUSES = ["ruled", "design-choice", "open"] as const;
export const wikiStatusSchema = z.enum(WIKI_STATUSES);
export type WikiStatus = z.infer<typeof wikiStatusSchema>;

export const WIKI_KINDS = ["cuj", "requirement"] as const;
export const wikiKindSchema = z.enum(WIKI_KINDS);
export type WikiKind = z.infer<typeof wikiKindSchema>;

export const claimMarkerSchema = z
  .object({
    status: wikiStatusSchema,
    label: z.string(),
    cards: z.array(z.string()),
    line: z.number().int().min(1),
  })
  .strict();
export type ClaimMarker = z.infer<typeof claimMarkerSchema>;

export const wikiPageSummarySchema = z
  .object({
    id: z.string().min(1),
    kind: wikiKindSchema,
    path: z.string().min(1),
    title: z.string().min(1),
    status: wikiStatusSchema,
    card: z.string().min(1).nullable(),
    source: z.string().min(1),
    updated: z.string().min(1),
  })
  .strict();
export type WikiPageSummary = z.infer<typeof wikiPageSummarySchema>;

export const wikiPageSchema = wikiPageSummarySchema
  .extend({
    body: z.string(),
    claims: z.array(claimMarkerSchema),
  })
  .strict();
export type WikiPage = z.infer<typeof wikiPageSchema>;

export const wikiPageErrorSchema = z
  .object({
    kind: wikiKindSchema,
    path: z.string().min(1),
    message: z.string().min(1),
    pageId: z.string().min(1).optional(),
  })
  .strict();
export type WikiPageError = z.infer<typeof wikiPageErrorSchema>;

export const WIKI_LIST_STATES = ["ready", "empty", "unavailable"] as const;
export const wikiListSchema = z
  .object({
    state: z.enum(WIKI_LIST_STATES),
    message: z.string().nullable(),
    pages: z.array(wikiPageSummarySchema),
    errors: z.array(wikiPageErrorSchema),
  })
  .strict();
export type WikiList = z.infer<typeof wikiListSchema>;
