import type {
  WindowPresetPane,
  WindowPresetSuggestion,
  WindowReport,
  WindowSnapshot,
} from "@bb/domain";
import { windowPresetPanesSchema, windowReportSchema } from "@bb/domain";
import { z } from "zod";

export type PathWindowPreset = { param: { presetId: string } };

export type ReportWindowRequest = WindowReport;
export const reportWindowRequestSchema = windowReportSchema;

export interface WindowsResponse {
  windows: WindowSnapshot[];
}

export interface ReportWindowResponse {
  window: WindowSnapshot;
}

export const proposeWindowPresetRequestSchema = z
  .object({
    panes: windowPresetPanesSchema,
    reason: z.string().max(1_000).nullable().optional(),
    proposedBy: z.string().min(1).max(256).optional(),
  })
  .strict();
export type ProposeWindowPresetRequest = z.infer<
  typeof proposeWindowPresetRequestSchema
>;

export interface ProposeWindowPresetResponse {
  presetId: string;
  suggestion: WindowPresetSuggestion;
}

export const acceptWindowSuggestionRequestSchema = z
  .object({
    windowId: z.string().min(1).max(128),
    proposedAt: z.string().min(1).max(64),
  })
  .strict();
export type AcceptWindowSuggestionRequest = z.infer<
  typeof acceptWindowSuggestionRequestSchema
>;

export interface AcceptWindowSuggestionResponse {
  presetId: string;
  panes: WindowPresetPane[];
}

export const dismissWindowSuggestionRequestSchema = z
  .object({ proposedAt: z.string().min(1).max(64) })
  .strict();
export type DismissWindowSuggestionRequest = z.infer<
  typeof dismissWindowSuggestionRequestSchema
>;

export interface DismissWindowSuggestionResponse {
  presetId: string;
}
