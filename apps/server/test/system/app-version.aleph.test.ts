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
  it("treats the upstream base release as the same version", async () => {
    const { service, urls } = serviceFor("0.43.4");
    const response = await service.getSystemVersion();
    expect(urls).toEqual(["https://registry.npmjs.org/bb-app/latest"]);
    expect(response.currentVersion).toBe("0.43.4+aleph.1");
    expect(response.updateAvailable).toBe(false);
  });

  it("reports a newer upstream release as an update", async () => {
    const { service } = serviceFor("0.43.5");
    expect((await service.getSystemVersion()).updateAvailable).toBe(true);
  });
});
