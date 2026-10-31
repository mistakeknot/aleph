import type {
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
