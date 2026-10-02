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

interface CreateServerPluginRegistryArgs {
  fetchImpl: typeof fetch;
  getAppOrigin(): string | null;
}

export function createServerPluginRegistry(
  args: CreateServerPluginRegistryArgs,
): OverlayPluginRegistry {
  return {
    async isPanelRouteAvailable(request) {
      const appOrigin = args.getAppOrigin();
      if (appOrigin === null) {
        return false;
      }
      try {
        const response = await args.fetchImpl(`${appOrigin}/api/v1/plugins`);
        if (!response.ok) {
          return false;
        }
        const parsed = installedPluginsResponseSchema.safeParse(
          await response.json(),
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
