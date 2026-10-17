import { describe, expect, it } from "vitest";
import {
  parseStoredThreadEvent,
  redactEventDataForType,
  redactEventDataJsonForType,
  redactProviderEnvResolvedData,
  redactThreadEventPayload,
  threadScope,
} from "../src/index.js";
import { expandSecretVariants } from "../src/secret-variants.js";

const BODY = "synth-s3cr3t-body";
const HIGH = "\ud800";
const LOW = "\udc00";

// Malformed UTF-16 secrets: unpaired high, unpaired low, and in the middle.
const MALFORMED: Record<string, string> = {
  "trailing high": BODY + HIGH,
  "leading low": LOW + BODY,
  "middle high": BODY + HIGH + "tail-xyz",
  "middle low": BODY + LOW + "tail-xyz",
  "high before astral": BODY + HIGH + "\u{1f600}tail",
};

const META = {
  providerThreadId: "synthetic-provider",
  threadId: "thr_synthetic",
};

describe("malformed UTF-16 known secrets never throw and never leak", () => {
  for (const [name, secret] of Object.entries(MALFORMED)) {
    it(`${name}: expansion keeps the raw secret and does not throw`, () => {
      const variants = expandSecretVariants(secret);
      expect(variants).not.toBeNull();
      expect(variants).toContain(secret);
      // The URL form of the well-formed (U+FFFD substituted) secret is there.
      const wf = [...secret]
        .map((ch) => (/^[\ud800-\udfff]$/.test(ch) ? "�" : ch))
        .join("");
      expect(variants).toContain(encodeURIComponent(wf));
    });

    it(`${name}: provider/warning echoes are masked on all four paths`, () => {
      const echoes = [
        `raw ${secret} end`,
        `url ${[...secret]
          .map((ch) =>
            /^[\ud800-\udfff]$/.test(ch) ? "%EF%BF%BD" : encodeURIComponent(ch),
          )
          .join("")} end`,
        `json ${JSON.stringify(secret).slice(1, -1)} end`,
      ];
      for (const echo of echoes) {
        const data = { category: "config", details: echo, token: secret };
        const object = redactEventDataForType("provider/warning", data) as {
          details: string;
        };
        const viaJson = JSON.parse(
          redactEventDataJsonForType("provider/warning", JSON.stringify(data)),
        ) as { details: string };
        const emitted = redactThreadEventPayload({
          type: "provider/warning",
          ...META,
          scope: threadScope(),
          ...data,
        } as { type: string }) as unknown as { details: string };
        const decoded = parseStoredThreadEvent({
          type: "provider/warning",
          data,
          scope: threadScope(),
          ...META,
        }) as unknown as { details: string };
        for (const out of [object, viaJson, emitted, decoded]) {
          expect(out.details, echo).not.toContain(BODY);
        }
      }
    });

    it(`${name}: env-resolved entries do not throw and mask the echo`, () => {
      const out = redactProviderEnvResolvedData({
        entries: [
          { name: "API_TOKEN", source: "shell", value: secret },
          {
            name: "NOTE",
            source: "shell",
            value: `copied ${secret}`,
            reason: `from ${secret}`,
          },
        ],
      });
      const text = JSON.stringify(out);
      expect(text).not.toContain(BODY);
    });
  }
});
