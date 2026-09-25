import { describe, expect, it } from "vitest";
import type {
  AppUpdateLauncherRequest,
  LauncherAppUpdateStatus,
} from "@bb/config/app-update";
import { ApiError } from "../../src/errors.js";
import { createAppUpdateService } from "../../src/services/system/app-update.js";
import { createAppVersionService } from "../../src/services/system/app-version.js";
import type { LauncherChannel } from "../../src/services/system/launcher-channel.js";
import { testLogger } from "../helpers/test-app.js";

const ALEPH_VERSION = "0.43.4+aleph.2";

class NpmLauncher implements LauncherChannel {
  readonly requests: AppUpdateLauncherRequest[] = [];
  private listeners = new Set<(status: LauncherAppUpdateStatus) => void>();

  dispose(): void {
    this.listeners.clear();
  }

  onDisconnect(): () => void {
    return () => undefined;
  }

  onStatus(listener: (status: LauncherAppUpdateStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(request: AppUpdateLauncherRequest): Promise<unknown> {
    this.requests.push(request);
    return null;
  }

  pushIdle(): void {
    for (const listener of this.listeners) {
      listener({
        activity: { phase: "idle" },
        current: {
          kind: "npm",
          packageRoot: `/pkg/${ALEPH_VERSION}`,
          version: ALEPH_VERSION,
        },
        lastResult: null,
        mode: "npm",
      });
    }
  }
}

describe("in-app npm updates on an Aleph build", () => {
  it("refuses with 409 and never asks the launcher to install upstream bb-app", async () => {
    const npmUrls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      npmUrls.push(String(input));
      return new Response(JSON.stringify({ version: "0.43.5" }), {
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const config = { appVersion: ALEPH_VERSION, isDevelopment: false };
    const launcher = new NpmLauncher();
    const service = createAppUpdateService({
      appSurface: "web",
      appVersion: createAppVersionService({
        config,
        fetchImpl,
        logger: testLogger,
      }),
      config,
      countRunningThreads: () => 0,
      launcher,
      logger: testLogger,
      mode: "npm",
      notifyChanged: () => undefined,
    });
    launcher.pushIdle();

    const error = await service
      .apply({ confirmInterruptingThreads: true })
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(ApiError);
    if (!(error instanceof ApiError)) throw new Error("expected ApiError");
    expect(error.status).toBe(409);
    expect(error.body.code).toBe("app_update_unavailable");
    expect(launcher.requests).toEqual([]);
    expect(npmUrls).toEqual([]);
  });
});
