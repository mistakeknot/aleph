import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("ioskeley mono font route", () => {
  it("serves the downloaded font with an immutable cache header", async () => {
    await withTestHarness({}, async (harness) => {
      await mkdir(join(harness.config.dataDir, "fonts"), { recursive: true });
      await writeFile(
        join(harness.config.dataDir, "fonts", "ioskeley-mono.woff2"),
        Buffer.from("fake woff2 bytes"),
      );

      const response = await harness.app.request(
        "/api/v1/system/fonts/ioskeley-mono.woff2",
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("font/woff2");
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(await response.text()).toBe("fake woff2 bytes");
    });
  });

  it("returns 404 when the font has not been downloaded", async () => {
    await withTestHarness({}, async (harness) => {
      const response = await harness.app.request(
        "/api/v1/system/fonts/ioskeley-mono.woff2",
      );

      expect(response.status).toBe(404);
      expect(await readJson(response)).toMatchObject({
        code: "ioskeley_mono_font_not_found",
      });
    });
  });
});
