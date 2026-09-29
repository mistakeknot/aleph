import type { SystemVersionResponse } from "@bb/server-contract";
import type { ServerRuntimeConfig } from "../../types.js";

export interface AppVersionService {
  getSystemVersion(
    args?: AppVersionGetSystemVersionArgs,
  ): Promise<SystemVersionResponse>;
}

interface AppVersionGetSystemVersionArgs {
  forceRefresh?: boolean;
}

interface CreateAppVersionServiceArgs {
  config: Pick<ServerRuntimeConfig, "appVersion" | "isDevelopment">;
}

export function createAppVersionService(
  args: CreateAppVersionServiceArgs,
): AppVersionService {
  const config = args.config;
  return {
    async getSystemVersion(): Promise<SystemVersionResponse> {
      return {
        currentVersion: config.appVersion,
        latestVersion: null,
        source: "npm",
        updateAvailable: false,
        updateChecksDisabled: true,
        isDevelopment: config.isDevelopment,
        upgradeCommand: null,
      };
    },
  };
}
