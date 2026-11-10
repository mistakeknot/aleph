import { describe, expect, it, vi } from "vitest";
import type { TelemetryService } from "../../src/services/system/telemetry.js";
import { readJson } from "../helpers/json.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function post(harness: TestAppHarness, body: unknown) {
  return harness.app.request("/api/v1/system/client-timing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("client timing", () => {
  it("logs accepted samples locally and never forwards them to telemetry", async () => {
    await withTestHarness(async (harness) => {
      const capture = vi.fn<TelemetryService["capture"]>();
      harness.deps.telemetry = { ...harness.deps.telemetry, capture };
      const info = vi.spyOn(harness.deps.logger, "info");
      const body = {
        device: "mobile",
        surface: "remote",
        samples: [
          { kind: "thread-view", ms: 412.5, cached: true },
          { kind: "send-ack", ms: 180 },
          { kind: "stream-lag", ms: 35 },
          { kind: "rtt", ms: 92 },
        ],
      };
      const response = await post(harness, body);
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ ok: true });
      expect(info).toHaveBeenCalledWith(body, "Client timing");
      expect(capture).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed, oversized or identifying payloads", async () => {
    await withTestHarness(async (harness) => {
      const info = vi.spyOn(harness.deps.logger, "info");
      const sample = { kind: "rtt", ms: 10 };
      const invalid = [
        { device: "desktop", surface: "local", samples: [] },
        {
          device: "desktop",
          surface: "local",
          samples: Array.from({ length: 201 }, () => sample),
        },
        {
          device: "desktop",
          surface: "local",
          samples: [{ kind: "rtt", ms: -1 }],
        },
        {
          device: "desktop",
          surface: "local",
          samples: [{ kind: "rtt", ms: 600_001 }],
        },
        {
          device: "desktop",
          surface: "local",
          samples: [{ kind: "paint", ms: 10 }],
        },
        {
          device: "desktop",
          surface: "local",
          samples: [{ ...sample, threadId: "thr_1" }],
        },
        {
          device: "desktop",
          surface: "local",
          samples: [sample],
          userAgent: "x",
        },
        { device: "tv", surface: "local", samples: [sample] },
      ];
      for (const body of invalid) {
        expect((await post(harness, body)).status).toBe(400);
      }
      expect(info).not.toHaveBeenCalledWith(expect.anything(), "Client timing");
    });
  });
});
