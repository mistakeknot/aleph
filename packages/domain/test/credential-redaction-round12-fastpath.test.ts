import { describe, expect, it } from "vitest";
import {
  parseStoredThreadEvent,
  redactEventDataForType,
  redactEventDataJsonForType,
  redactThreadEventPayload,
  turnScope,
} from "../src/index.js";
import {
  VENDOR_TOKEN_PATTERNS,
  VENDOR_TOKEN_PRECHECK,
} from "../src/vendor-token-patterns.js";

// Synthetic tokens assembled at runtime (no scanner-looking literal).
const f = (chars: string, n: number) => chars.repeat(n).slice(0, n);
const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const az = "abcdefghijklmnopqrstuvwxyz";
const D = "0123456789";
const ALNUM = AZ + az + D;
const HEX = "0123456789abcdef";

const SAMPLES: Record<string, string> = {
  "github-pat": "gh" + "p_" + f(ALNUM, 36),
  "github-oauth": "gh" + "o_" + f(ALNUM, 36),
  "github-app": "gh" + "s_" + f(ALNUM, 40),
  "github-refresh": "gh" + "r_" + f(ALNUM, 36),
  "github-fine-grained": "github" + "_pat_" + f(ALNUM + "_", 82),
  anthropic: "sk-" + "ant-api03-" + f(ALNUM + "_-", 93) + "AA",
  "openai-project":
    "sk-" + "proj-" + f(ALNUM, 74) + "T3Blbk" + "FJ" + f(ALNUM, 74),
  "openai-legacy": "sk-" + f(ALNUM, 20) + "T3Blbk" + "FJ" + f(ALNUM, 20),
  "slack-bot": "xox" + "b-" + f(D, 11) + "-" + f(D, 12) + "-" + f(ALNUM, 24),
  "slack-user":
    "xox" +
    "p-" +
    f(D, 11) +
    "-" +
    f(D, 11) +
    "-" +
    f(D, 12) +
    "-" +
    f(ALNUM, 30),
  "slack-legacy":
    "xox" +
    "s-" +
    f(D, 11) +
    "-" +
    f(D, 11) +
    "-" +
    f(D, 11) +
    "-" +
    f(HEX, 24),
  "slack-app":
    "xapp" + "-1-" + f(AZ + D, 11) + "-" + f(D, 13) + "-" + f(az + D, 40),
  stripe: "sk" + "_live_" + f(ALNUM, 24),
  "aws-access-key-id": "AK" + "IA" + f(AZ, 16),
  "google-api-key": "AI" + "za" + f(ALNUM, 35),
  npm: "npm" + "_" + f(ALNUM, 36),
  pypi: "pypi-" + "AgEIcHlwaS5vcmc" + f(ALNUM, 60),
  sendgrid: "SG" + "." + f(ALNUM, 22) + "." + f(ALNUM, 43),
  twilio: "S" + "K" + f(HEX, 32),
  gitlab: "gl" + "pat-" + f(ALNUM, 20),
  "cloudflare-origin-ca": "v1." + "0-" + f(HEX, 24) + "-" + f(HEX, 146),
  digitalocean: "dop" + "_v1_" + f(HEX, 64),
  shopify: "shp" + "at_" + f(HEX, 32),
  tailscale: "tskey" + "-auth-" + f(ALNUM, 12) + "-" + f(ALNUM, 32),
  "private-key":
    "-----BEGIN " +
    "OPENSSH PRIVATE" +
    " KEY-----\n" +
    f(ALNUM + "+/", 200) +
    "\n-----END " +
    "OPENSSH PRIVATE" +
    " KEY-----",
};

const META = {
  providerThreadId: "synthetic-provider",
  threadId: "thr_synthetic",
};

interface Case {
  name: string;
  type: "item/completed" | "item/commandExecution/outputDelta";
  data: (token: string) => Record<string, unknown>;
  read: (event: unknown) => string;
}

// Payloads carry no old precheck keyword (token, env, auth, ://, ...).
const CASES: Case[] = [
  {
    name: "commandExecution aggregatedOutput",
    type: "item/completed",
    data: (token) => ({
      item: {
        type: "commandExecution",
        id: "item_1",
        command: "ls",
        cwd: "/work",
        status: "completed",
        approvalStatus: null,
        aggregatedOutput: `plain output ${token} end`,
      },
    }),
    read: (e) =>
      (e as { item: { aggregatedOutput: string } }).item.aggregatedOutput,
  },
  {
    name: "commandExecution outputDelta that is only the token",
    type: "item/commandExecution/outputDelta",
    data: (token) => ({ itemId: "item_1", delta: token }),
    read: (e) => (e as { delta: string }).delta,
  },
];

describe("JSON write fast path is sound for vendor tokens", () => {
  it("has a sample for every pattern", () => {
    expect(VENDOR_TOKEN_PATTERNS.map((p) => p.id).sort()).toEqual(
      Object.keys(SAMPLES).sort(),
    );
  });

  for (const [id, token] of Object.entries(SAMPLES)) {
    it(`${id}: the precheck matches the token and its JSON form`, () => {
      expect(VENDOR_TOKEN_PRECHECK.test(token)).toBe(true);
      expect(VENDOR_TOKEN_PRECHECK.test(JSON.stringify(token))).toBe(true);
    });

    for (const c of CASES) {
      it(`${id}: ${c.name} is redacted on all four paths`, () => {
        const data = c.data(token);
        const json = JSON.stringify(data);
        for (const keyword of ["token", "env", "auth", "://", "secret"]) {
          expect(json.replace(token, "").toLowerCase()).not.toContain(keyword);
        }
        const object = redactEventDataForType(c.type, data);
        expect(JSON.stringify(object)).not.toContain(token);
        const viaJson = redactEventDataJsonForType(c.type, json);
        expect(viaJson).not.toContain(token);
        expect(JSON.parse(viaJson)).toEqual(object);
        const emitted = redactThreadEventPayload({
          type: c.type,
          ...META,
          scope: turnScope("turn_1"),
          ...data,
        } as { type: string });
        expect(JSON.stringify(emitted)).not.toContain(token);
        const decoded = parseStoredThreadEvent({
          type: c.type,
          data,
          scope: turnScope("turn_1"),
          ...META,
        });
        expect(JSON.stringify(decoded)).not.toContain(token);
        expect(c.read(decoded)).toContain("[redacted]");
      });
    }
  }

  it("still returns unchanged JSON for ordinary tool output", () => {
    const json = JSON.stringify({ itemId: "i", delta: "compiling 42 files" });
    expect(
      redactEventDataJsonForType("item/commandExecution/outputDelta", json),
    ).toBe(json);
  });
});
