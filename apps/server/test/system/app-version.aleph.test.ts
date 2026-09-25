import { describe, expect, it } from "vitest";
import { createAppVersionService } from "../../src/services/system/app-version.js";
import { testLogger } from "../helpers/test-app.js";

function serviceFor(latestVersion: string) {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return new Response(JSON.stringify({ version: latestVersion }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const service = createAppVersionService({
    config: { appVersion: "0.43.4+aleph.1", isDevelopment: false },
    fetchImpl,
    logger: testLogger,
  });
  return { service, urls };
}

describe("Aleph build-metadata versions", () => {
  it("never asks npm, whose bb-app is upstream bb", async () => {
    const { service, urls } = serviceFor("0.43.5");
    const response = await service.getSystemVersion({ forceRefresh: true });
    expect(urls).toEqual([]);
    expect(response.currentVersion).toBe("0.43.4+aleph.1");
    expect(response.latestVersion).toBeNull();
    expect(response.updateAvailable).toBe(false);
  });

  it("says checks are off and offers no upstream upgrade command", async () => {
    const { service } = serviceFor("0.43.5");
    const response = await service.getSystemVersion({ forceRefresh: true });
    expect(response.updateChecksDisabled).toBe(true);
    expect(response.upgradeCommand).toBeNull();
  });
});
