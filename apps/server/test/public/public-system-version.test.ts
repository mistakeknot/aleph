import { describe, expect, it } from "vitest";
import {
  QUEUE_RETIREMENT_CAPABILITY,
  systemVersionResponseSchema,
} from "@bb/server-contract";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("GET /api/v1/system/version", () => {
  it("serves the app version service's development report", async () => {
    await withTestHarness(
      { appVersion: "0.0.5", isDevelopment: true },
      async (harness) => {
        const response = await harness.app.request("/api/v1/system/version");
        expect(response.status).toBe(200);
        const body = systemVersionResponseSchema.parse(
          await readJson(response),
        );
        expect(body).toMatchObject({
          currentVersion: "0.0.5",
          isDevelopment: true,
          latestVersion: null,
          updateAvailable: false,
        });
        expect(body.queueRetirement).toEqual(QUEUE_RETIREMENT_CAPABILITY);
      },
    );
  });
});
