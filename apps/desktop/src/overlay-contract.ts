import { z } from "zod";

export const BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL =
  "bb-desktop:overlay:open-panel";

export const DEFAULT_OVERLAY_ACCELERATOR = "CommandOrControl+Shift+Space";

const OVERLAY_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const OVERLAY_PANEL_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export const overlayPluginIdSchema = z
  .string()
  .regex(OVERLAY_PLUGIN_ID_PATTERN);
export const overlayPanelIdSchema = z.string().regex(OVERLAY_PANEL_ID_PATTERN);

export const overlayOpenPanelRequestSchema = z
  .object({
    panelId: overlayPanelIdSchema,
    pluginId: overlayPluginIdSchema,
  })
  .strict();
export type OverlayOpenPanelRequest = z.infer<
  typeof overlayOpenPanelRequestSchema
>;

export const overlayOpenPanelResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), reason: z.string() }).strict(),
]);
export type OverlayOpenPanelResult = z.infer<
  typeof overlayOpenPanelResultSchema
>;

export interface BbOverlayApi {
  openPanel(request: OverlayOpenPanelRequest): Promise<OverlayOpenPanelResult>;
}

const ACCELERATOR_MODIFIERS = new Set([
  "command",
  "cmd",
  "control",
  "ctrl",
  "commandorcontrol",
  "cmdorctrl",
  "alt",
  "option",
  "altgr",
  "shift",
  "super",
  "meta",
]);
const ACCELERATOR_KEY_PATTERN =
  /^(?:[a-z0-9]|f(?:[1-9]|1[0-9]|2[0-4])|plus|space|tab|capslock|numlock|scrolllock|backspace|delete|insert|return|enter|up|down|left|right|home|end|pageup|pagedown|escape|esc|[-=;,./`'[\]\\])$/iu;
const ACCELERATOR_MAX_LENGTH = 64;

export function isValidOverlayAccelerator(value: unknown): value is string {
  if (typeof value !== "string" || value.length > ACCELERATOR_MAX_LENGTH) {
    return false;
  }
  const parts = value.split("+");
  const key = parts.pop();
  if (key === undefined || parts.length === 0) {
    return false;
  }
  const seen = new Set<string>();
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (!ACCELERATOR_MODIFIERS.has(normalized) || seen.has(normalized)) {
      return false;
    }
    seen.add(normalized);
  }
  return ACCELERATOR_KEY_PATTERN.test(key);
}

export const overlaySettingsSchema = z.object({
  accelerator: z
    .string()
    .refine(isValidOverlayAccelerator)
    .default(DEFAULT_OVERLAY_ACCELERATOR),
  target: z
    .object({ panelId: overlayPanelIdSchema, pluginId: overlayPluginIdSchema })
    .strict()
    .nullable()
    .default(null),
});
export type OverlaySettings = z.infer<typeof overlaySettingsSchema>;
