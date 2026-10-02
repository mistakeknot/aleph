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

interface AbortWatch {
  aborted: Promise<never>;
  dispose(): void;
}

// One abort listener per watch, removed by dispose(); callers race it against
// as many reads as they need without accumulating listeners on the signal.
function watchAbort(signal: AbortSignal): AbortWatch {
  let fail = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    fail = () => reject(new Error("Plugin registry request timed out."));
  });
  // Never an unhandled rejection when the watch is disposed without a race.
  aborted.catch(() => undefined);
  if (signal.aborted) {
    fail();
  } else {
    signal.addEventListener("abort", fail, { once: true });
  }
  return {
    aborted,
    dispose: () => signal.removeEventListener("abort", fail),
  };
}

async function readCappedText(
  response: Response,
  maxBytes: number,
  watch: AbortWatch,
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
      const chunk = await Promise.race([reader.read(), watch.aborted]);
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

// Electron's net.fetch builds the Response without URL metadata, so a
// successful response has url === "". The requested URL, derived from the
// revalidated app origin and sent with redirect: "error", is then the
// provenance. A present url must still match the requested origin.
function isResponseFromOrigin(response: Response, origin: string): boolean {
  if (response.redirected) {
    return false;
  }
  const url: unknown = response.url;
  if (url === undefined || url === null || url === "") {
    return true;
  }
  if (typeof url !== "string") {
    return false;
  }
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
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
      const watch = watchAbort(signal);
      try {
        // redirect: "error" keeps any credentials attached by the fetch
        // implementation (Electron's net.fetch uses the session cookies) from
        // ever following a redirect off the app origin. Fail closed on all.
        const response = await Promise.race([
          args.fetchImpl(requestUrl, { redirect: "error", signal }),
          watch.aborted,
        ]);
        if (
          !response.ok ||
          !isResponseFromOrigin(response, new URL(requestUrl).origin)
        ) {
          return false;
        }
        const text = await readCappedText(response, maxBytes, watch);
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
      } finally {
        watch.dispose();
      }
    },
  };
}
