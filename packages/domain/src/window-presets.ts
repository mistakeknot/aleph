import { z } from "zod";

export const WINDOW_PRESET_MAX_PANES = 8;
export const VIZIER_THREAD_TITLE_PREFIX = "Masaq' | vizier";

const presetIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);

const windowPresetPaneSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("thread"),
      projectId: z.string().min(1).max(256),
      threadId: z.string().min(1).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal("thread-title"),
      titlePrefix: z.string().min(1).max(256),
      pinnedOnly: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plugin-panel"),
      pluginId: z.string().min(1).max(256),
      panelPath: z.string().min(1).max(256),
      subPath: z.string().max(1_024).optional(),
    })
    .strict(),
]);
export type WindowPresetPane = z.infer<typeof windowPresetPaneSchema>;

export const windowPresetPanesSchema = z
  .array(windowPresetPaneSchema)
  .max(WINDOW_PRESET_MAX_PANES);

const windowPresetSchema = z
  .object({
    id: presetIdSchema,
    name: z.string().min(1).max(80),
    panes: windowPresetPanesSchema,
    direction: z.enum(["row", "col"]),
    hideSidebar: z.boolean(),
    rightPanelTab: z.string().min(1).max(256).nullable(),
    userEditable: z.boolean(),
  })
  .strict();
export type WindowPreset = z.infer<typeof windowPresetSchema>;

export const windowPresetsSchema = z
  .array(windowPresetSchema)
  .max(32)
  .superRefine((presets, context) => {
    const seen = new Set<string>();
    presets.forEach((preset, index) => {
      if (seen.has(preset.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate preset id '${preset.id}'`,
          path: [index, "id"],
        });
      }
      seen.add(preset.id);
    });
    const command = presets.findIndex((preset) => preset.id === "command");
    if (
      command < 0 ||
      JSON.stringify(presets[command]) !== JSON.stringify(COMMAND_WINDOW_PRESET)
    ) {
      context.addIssue({
        code: "custom",
        message: "The Command preset is built in and cannot be changed",
        path: [command < 0 ? 0 : command],
      });
    }
  });

const windowPresetSuggestionSchema = z
  .object({
    panes: windowPresetPanesSchema,
    reason: z.string().max(1_000).nullable(),
    proposedBy: z.string().min(1).max(256),
    proposedAt: z.string().min(1).max(64),
  })
  .strict();
export type WindowPresetSuggestion = z.infer<
  typeof windowPresetSuggestionSchema
>;

export const windowPresetSuggestionsSchema = z.record(
  presetIdSchema,
  windowPresetSuggestionSchema,
);
export type WindowPresetSuggestions = z.infer<
  typeof windowPresetSuggestionsSchema
>;

export const COMMAND_WINDOW_PRESET: WindowPreset = {
  id: "command",
  name: "Command",
  panes: [
    { kind: "plugin-panel", pluginId: "autarch", panelPath: "home" },
    {
      kind: "thread-title",
      titlePrefix: VIZIER_THREAD_TITLE_PREFIX,
      pinnedOnly: true,
    },
  ],
  direction: "row",
  hideSidebar: true,
  rightPanelTab: null,
  userEditable: false,
};

export const PRIORITIES_WINDOW_PRESET: WindowPreset = {
  id: "priorities",
  name: "Priorities",
  panes: [],
  direction: "row",
  hideSidebar: true,
  rightPanelTab: null,
  userEditable: true,
};

export const DEFAULT_WINDOW_PRESETS: WindowPreset[] = [
  COMMAND_WINDOW_PRESET,
  PRIORITIES_WINDOW_PRESET,
];

export const windowReportPaneSchema = z
  .object({
    paneId: z.string().min(1).max(256),
    kind: z.enum(["thread", "new-thread", "plugin-panel", "plugin-detail"]),
    projectId: z.string().max(256).nullable(),
    threadId: z.string().max(256).nullable(),
    threadTitle: z.string().max(512).nullable(),
    pluginId: z.string().max(256).nullable(),
    panelPath: z.string().max(256).nullable(),
    focused: z.boolean(),
  })
  .strict();

export const windowReportSchema = z
  .object({
    windowId: z.string().min(1).max(128),
    presetId: z.string().max(64).nullable(),
    route: z.string().max(2_048),
    sidebarOpen: z.boolean(),
    rightPanelOpen: z.boolean(),
    rightPanelTab: z.string().max(256).nullable(),
    maximizedPaneId: z.string().max(256).nullable(),
    panes: z.array(windowReportPaneSchema).max(WINDOW_PRESET_MAX_PANES),
    viewport: z
      .object({
        width: z.number().int().min(0),
        height: z.number().int().min(0),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type WindowReport = z.infer<typeof windowReportSchema>;

export interface WindowSnapshot extends WindowReport {
  reportedAt: string;
}

export const WINDOW_REPORT_STALE_MS = 90_000;
