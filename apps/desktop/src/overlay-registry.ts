import { z } from "zod";
import type { OverlayPluginRegistry } from "./overlay-panel.js";

const installedPluginsResponseSchema = z.object({
  plugins: z.array(
    z.looseObject({
      app: z.looseObject({
        bundle: z.looseObject({ compatible: z.boolean() }).nullable(),
        hasApp: z.boolean(),
      }),
      enabled: z.boolean(),
      id: z.string(),
    }),
  ),
});

export const OVERLAY_REGISTRY_TIMEOUT_MS = 5_000;
export const OVERLAY_REGISTRY_MAX_BYTES = 1024 * 1024;

interface CreateServerPluginRegistryArgs {
  fetchImpl: typeof fetch;
  getAppOrigin(): string | null;
  maxBytes?: number;
  timeoutMs?: number;
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = (): void =>
      reject(new Error("Plugin registry request timed out."));
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

async function readCappedText(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return null;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return null;
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), rejectOnAbort(signal)]);
      if (chunk.done) {
        return text + decoder.decode();
      }
      received += chunk.value.byteLength;
      if (received > maxBytes) {
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export function createServerPluginRegistry(
  args: CreateServerPluginRegistryArgs,
): OverlayPluginRegistry {
  const maxBytes = args.maxBytes ?? OVERLAY_REGISTRY_MAX_BYTES;
  const timeoutMs = args.timeoutMs ?? OVERLAY_REGISTRY_TIMEOUT_MS;
  return {
    async isPanelRouteAvailable(request) {
      const appOrigin = args.getAppOrigin();
      if (appOrigin === null) {
        return false;
      }
      const requestUrl = `${appOrigin}/api/v1/plugins`;
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        // redirect: "error" keeps any credentials attached by the fetch
        // implementation (Electron's net.fetch uses the session cookies) from
        // ever following a redirect off the app origin. Fail closed on all.
        const response = await Promise.race([
          args.fetchImpl(requestUrl, { redirect: "error", signal }),
          rejectOnAbort(signal),
        ]);
        if (
          !response.ok ||
          response.redirected ||
          new URL(response.url).origin !== appOrigin
        ) {
          return false;
        }
        const text = await readCappedText(response, maxBytes, signal);
        if (text === null) {
          return false;
        }
        const parsed = installedPluginsResponseSchema.safeParse(
          JSON.parse(text),
        );
        if (!parsed.success) {
          return false;
        }
        return parsed.data.plugins.some(
          (plugin) =>
            plugin.id === request.pluginId &&
            plugin.enabled &&
            plugin.app.hasApp &&
            plugin.app.bundle?.compatible === true,
        );
      } catch {
        return false;
      }
    },
  };
}
