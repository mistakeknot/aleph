import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppVersionService } from "../../src/services/system/app-version.js";

const VERSIONS = [
  "0.0.5",
  "0.43.5-nightly.100.1",
  "totally-not-semver",
  "0.43.4+aleph.1",
];

describe("createAppVersionService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const appVersion of VERSIONS) {
    for (const isDevelopment of [false, true]) {
      it(`never contacts npm for ${appVersion} (development=${isDevelopment})`, async () => {
        const fetchSpy = vi
          .spyOn(globalThis, "fetch")
          .mockResolvedValue(
            new Response(JSON.stringify({ version: "99.0.0" })),
          );
        const service = createAppVersionService({
          config: { appVersion, isDevelopment },
        });

        const response = await service.getSystemVersion({ forceRefresh: true });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(response).toEqual({
          currentVersion: appVersion,
          isDevelopment,
          latestVersion: null,
          source: "npm",
          updateAvailable: false,
          updateChecksDisabled: true,
          upgradeCommand: null,
        });
      });
    }
  }
});
