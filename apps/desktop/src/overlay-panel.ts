import {
  overlayOpenPanelRequestSchema,
  type OverlayOpenPanelRequest,
} from "./overlay-contract.js";

export interface OverlayPluginRegistry {
  isPanelRouteAvailable(request: OverlayOpenPanelRequest): Promise<boolean>;
}

const ENCODED_PATH_TRICK_PATTERN = /%(?:2e|2f|5c|00)|\\/iu;

export function parseOverlayAppOrigin(rawUrl: string | null): string | null {
  if (rawUrl === null) {
    return null;
  }
  try {
    const url = new URL(rawUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function parseOverlayOpenPanelRequest(
  payload: unknown,
): OverlayOpenPanelRequest | null {
  const parsed = overlayOpenPanelRequestSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function resolveOverlayPanelUrl(args: {
  appOrigin: string;
  request: OverlayOpenPanelRequest;
}): string {
  return `${args.appOrigin}/plugins/${encodeURIComponent(args.request.pluginId)}/${encodeURIComponent(args.request.panelId)}`;
}

export function isOverlayNavigationAllowed(args: {
  appOrigin: string | null;
  url: string;
}): boolean {
  if (args.appOrigin === null) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    return false;
  }
  return (
    parsed.origin === args.appOrigin &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname.startsWith("/plugins/") &&
    !ENCODED_PATH_TRICK_PATTERN.test(parsed.pathname)
  );
}
