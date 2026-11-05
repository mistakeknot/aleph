import { describe, expect, it } from "vitest";
import { detectKeyShape } from "./key-shape.js";
import {
  secretRequestPayloadSchema,
  secretRequestResponseSchema,
} from "./secret-request.js";

const validPayload = {
  requestId: "6f1c1b0e-2d4a-4a43-9b5f-1f6d2c7a9e10",
  threadId: "thr_test",
  project: "demo",
  purpose: null,
  destination: { kind: "dotenv", path: "/repo/.env", consumer: "demo-app" },
  digestPrefix: "0123456789ab",
  allowlistEntryPrefix: "ba9876543210",
  expiresAtMs: 1_800_000_000_000,
  fields: [{ name: "API_KEY", description: null, existing: false }],
};

describe("secret-request payload contract (T1.1)", () => {
  it("accepts the strict payload", () => {
    expect(secretRequestPayloadSchema.safeParse(validPayload).success).toBe(
      true,
    );
  });

  it("rejects identifier-unsafe names", () => {
    expect(
      secretRequestPayloadSchema.safeParse({
        ...validPayload,
        fields: [{ name: "1BAD", description: null, existing: false }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown keys at every level", () => {
    expect(
      secretRequestPayloadSchema.safeParse({ ...validPayload, extra: 1 })
        .success,
    ).toBe(false);
    expect(
      secretRequestPayloadSchema.safeParse({
        ...validPayload,
        destination: { ...validPayload.destination, extra: 1 },
      }).success,
    ).toBe(false);
    expect(
      secretRequestPayloadSchema.safeParse({
        ...validPayload,
        fields: [
          { name: "API_KEY", description: null, existing: false, extra: 1 },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a destination that is not dotenv", () => {
    expect(
      secretRequestPayloadSchema.safeParse({
        ...validPayload,
        destination: { ...validPayload.destination, kind: "store" },
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed request id or digest prefix", () => {
    expect(
      secretRequestPayloadSchema.safeParse({
        ...validPayload,
        requestId: "not-a-uuid",
      }).success,
    ).toBe(false);
    expect(
      secretRequestPayloadSchema.safeParse({
        ...validPayload,
        digestPrefix: "xyz",
      }).success,
    ).toBe(false);
  });
});

describe("secret-request response contract (T1.1)", () => {
  it("accepts single-line values", () => {
    expect(
      secretRequestResponseSchema.safeParse({ values: { API_KEY: "abc" } })
        .success,
    ).toBe(true);
  });

  it("rejects multi-line, NUL, empty and oversized values", () => {
    for (const value of [
      "a\nb",
      "a\rb",
      "a\0b",
      "",
      "x".repeat(16 * 1024 + 1),
    ]) {
      expect(
        secretRequestResponseSchema.safeParse({ values: { API_KEY: value } })
          .success,
      ).toBe(false);
    }
  });

  it("rejects unknown keys and bad names", () => {
    expect(
      secretRequestResponseSchema.safeParse({
        values: { API_KEY: "abc" },
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      secretRequestResponseSchema.safeParse({ values: { "1BAD": "abc" } })
        .success,
    ).toBe(false);
  });
});

describe("credential-shape detector (T1.6)", () => {
  const positives: Array<[string, string]> = [
    [
      "private key block",
      ["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" "),
    ],
    ["AWS access key id", `id is AKIA${"B".repeat(16)}`],
    ["GitHub token", `ghp_${"a1".repeat(18)}`],
    ["provider API key", `sk-${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`],
    ["Slack token", `xoxb-${"1234567890"}-abcdefghij`],
    ["Google API key", `AIza${"a1B2c3D4e5".repeat(3)}abcde`],
    [
      "JSON web token",
      ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ4eHh4eHgifQ", "abcdefghijkl"].join(
        ".",
      ),
    ],
    ["credential in URL", "https://user:hunter2pw@example.com/path"],
    [
      "assignment of a value",
      `${"API_"}${"TOKEN"}${"="}${"abcdefgh"}${"12345"}`,
    ],
    [
      "high-entropy token",
      ["Zx9Qw7Er5Ty3", "Ui1Op8As6Df4", "Gh2Jk0LmNb"].join(""),
    ],
  ];

  it.each(positives)("flags %s", (label, text) => {
    expect(detectKeyShape(text)).toBe(label);
  });

  it("returns a label that never contains the matched text", () => {
    for (const [, text] of positives) {
      const label = detectKeyShape(text);
      expect(label).not.toBeNull();
      expect(text).not.toContain(label ?? "\0");
      expect(label).not.toMatch(/\d{6}/u);
    }
  });

  it.each([
    "Stripe API access for the billing worker",
    "Needed so the deploy job can reach the staging database",
    "/home/user/projects/example/config/settings.yaml",
    "the-quick-brown-fox-jumps-over-the-lazy-dog-again",
    "",
  ])("passes plain text %j", (text) => {
    expect(detectKeyShape(text)).toBeNull();
  });
});
