import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  RELAY_ATTACHMENT_MAX_BASE64_CHARS,
  RELAY_ATTACHMENTS_TOTAL_MAX_BASE64_CHARS,
  RELAY_ERROR_CODES,
  RELAY_ERROR_HTTP_STATUS,
  RELAY_ERROR_RETRYABLE,
  classifyRelayParseError,
  decodeRelayAttachments,
  relayTargetsRemoveRequestSchema,
  relayTargetsRemoveResponseSchema,
  relayTargetsResponseSchema,
  relayTellRequestSchema,
} from "../src/relay.js";

const VALID_ID = "01J9Z3K8Q4W5X6Y7Z8A9B0C1D2";

function attachmentOf(bytes: Buffer, filename = "note.txt") {
  return {
    filename,
    mimeType: "text/plain",
    contentBase64: bytes.toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    clientMessageId: VALID_ID,
    threadId: "thr_abc",
    text: "hello",
    ...overrides,
  };
}

describe("relayTellRequestSchema", () => {
  it("accepts a minimal and a full request", () => {
    expect(relayTellRequestSchema.safeParse(baseRequest()).success).toBe(true);
    expect(
      relayTellRequestSchema.safeParse(
        baseRequest({
          label: "after-them-feedback",
          attachments: [attachmentOf(Buffer.from("abc"))],
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["senderThreadId", "thr_forged"],
    ["mode", "steer"],
    ["model", "opus"],
    ["permissionMode", "full-access"],
    ["reasoningLevel", "high"],
    ["serviceTier", "fast"],
    ["sendAt", "2026-01-01T00:00:00Z"],
    ["input", []],
    ["mentions", []],
    ["pluginSubmission", {}],
    ["hostId", "host_x"],
  ])("rejects the smuggled field %s (T-SCH-1)", (field, value) => {
    const result = relayTellRequestSchema.safeParse(
      baseRequest({ [field]: value }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(classifyRelayParseError(result.error)).toBe("invalid_request");
    }
  });

  it("rejects unknown keys inside an attachment", () => {
    const result = relayTellRequestSchema.safeParse(
      baseRequest({
        attachments: [{ ...attachmentOf(Buffer.from("a")), sizeBytes: 1 }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it.each([
    "",
    "01J9Z3K8Q4W5X6Y7Z8A9B0C1D",
    "01J9Z3K8Q4W5X6Y7Z8A9B0C1D22",
    "01j9z3k8q4w5x6y7z8a9b0c1d2",
    "81J9Z3K8Q4W5X6Y7Z8A9B0C1D2",
    "01J9Z3K8Q4W5X6Y7Z8A9B0C1DU",
    "01J9Z3K8Q4W5X6Y7Z8A9B0C1DI",
    "01J9Z3K8Q4W5X6Y7Z8A9B0C1D ",
  ])("rejects the non-ULID clientMessageId %j", (clientMessageId) => {
    expect(
      relayTellRequestSchema.safeParse(baseRequest({ clientMessageId }))
        .success,
    ).toBe(false);
  });

  it("rejects empty and oversized text, measuring UTF-8 bytes", () => {
    expect(
      relayTellRequestSchema.safeParse(baseRequest({ text: "" })).success,
    ).toBe(false);
    expect(
      relayTellRequestSchema.safeParse(
        baseRequest({ text: "a".repeat(32 * 1024) }),
      ).success,
    ).toBe(true);
    const tooManyBytes = relayTellRequestSchema.safeParse(
      baseRequest({ text: "é".repeat(16 * 1024 + 1) }),
    );
    expect(tooManyBytes.success).toBe(false);
    if (!tooManyBytes.success) {
      expect(classifyRelayParseError(tooManyBytes.error)).toBe(
        "payload_too_large",
      );
    }
    const tooManyChars = relayTellRequestSchema.safeParse(
      baseRequest({ text: "a".repeat(32 * 1024 + 1) }),
    );
    expect(tooManyChars.success).toBe(false);
    if (!tooManyChars.success) {
      expect(classifyRelayParseError(tooManyChars.error)).toBe(
        "payload_too_large",
      );
    }
  });

  it("restricts label characters", () => {
    for (const label of ["", "a b", "<x>", "a".repeat(65), "é"]) {
      expect(
        relayTellRequestSchema.safeParse(baseRequest({ label })).success,
      ).toBe(false);
    }
  });

  it("rejects a fifth attachment as too large", () => {
    const attachment = attachmentOf(Buffer.from("a"));
    const result = relayTellRequestSchema.safeParse(
      baseRequest({ attachments: Array(5).fill(attachment) }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(classifyRelayParseError(result.error)).toBe("payload_too_large");
    }
  });

  it("rejects a malformed mimeType", () => {
    for (const mimeType of ["text", "text/", "a b/c", "text/plain; x=y"]) {
      expect(
        relayTellRequestSchema.safeParse(
          baseRequest({
            attachments: [{ ...attachmentOf(Buffer.from("a")), mimeType }],
          }),
        ).success,
      ).toBe(false);
    }
  });

  it("rejects uppercase and short sha256 values", () => {
    const attachment = attachmentOf(Buffer.from("a"));
    for (const sha256 of [attachment.sha256.toUpperCase(), "abc", ""]) {
      expect(
        relayTellRequestSchema.safeParse(
          baseRequest({ attachments: [{ ...attachment, sha256 }] }),
        ).success,
      ).toBe(false);
    }
  });
});

describe("relay attachment filenames (T-ATT-2)", () => {
  it.each([
    ["../x"],
    ["a/b"],
    ["a\\b"],
    ["a\0b"],
    ["a\rb"],
    ["a\nb"],
    ["a\tb"],
    ["a\x7fb"],
    ["a\x1fb"],
    [".."],
    ["."],
    [""],
    ["a".repeat(256)],
  ])("rejects the filename %j", (filename) => {
    const result = relayTellRequestSchema.safeParse(
      baseRequest({ attachments: [attachmentOf(Buffer.from("a"), filename)] }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts ordinary filenames including markup-looking ones", () => {
    for (const filename of [
      "a.txt",
      "résumé.pdf",
      '<b>"x".md',
      "a".repeat(255),
    ]) {
      expect(
        relayTellRequestSchema.safeParse(
          baseRequest({
            attachments: [attachmentOf(Buffer.from("a"), filename)],
          }),
        ).success,
      ).toBe(true);
    }
  });
});

describe("decodeRelayAttachments", () => {
  it("decodes canonical attachments and reports measured sizes", () => {
    const first = Buffer.from([0, 1, 2, 3, 250, 251, 252]);
    const second = Buffer.from("hello world");
    const result = decodeRelayAttachments([
      attachmentOf(first),
      attachmentOf(second),
      attachmentOf(Buffer.alloc(0)),
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.attachments.map((entry) => entry.sizeBytes)).toEqual([
        7, 11, 0,
      ]);
      expect(result.attachments[0]?.bytes.equals(first)).toBe(true);
      expect(result.attachments[1]?.bytes.equals(second)).toBe(true);
    }
  });

  it("rejects a sha256 that does not match the decoded bytes", () => {
    const attachment = attachmentOf(Buffer.from("abc"));
    const result = decodeRelayAttachments([
      { ...attachment, sha256: "0".repeat(64) },
    ]);
    expect(result).toMatchObject({ ok: false, code: "invalid_request" });
  });

  describe("malformed base64 (T-B64-1)", () => {
    const sha256 = "0".repeat(64);
    it.each([
      ["whitespace inside", "QUJD RA=="],
      ["newline inside", "QUJD\nRA=="],
      ["trailing newline", "QUJDRA==\n"],
      ["url-safe minus", "QU-D"],
      ["url-safe underscore", "QU_D"],
      ["missing padding", "QUI"],
      ["missing padding, two", "QQ"],
      ["length not a multiple of four", "QUJDR"],
      ["equals in the middle", "QU=DRA=="],
      ["padding followed by data", "QQ==QUJD"],
      ["three pad characters", "Q==="],
      ["only padding", "===="],
      ["characters outside the alphabet", "QUJD!A=="],
      ["non-ascii", "QUJDé==="],
      ["nul byte", "QUJ\0"],
    ])("rejects %s", (_name, contentBase64) => {
      const result = decodeRelayAttachments([{ contentBase64, sha256 }]);
      expect(result).toMatchObject({ ok: false, code: "invalid_request" });
      const parsed = relayTellRequestSchema.safeParse(
        baseRequest({
          attachments: [
            {
              filename: "a.txt",
              mimeType: "text/plain",
              contentBase64,
              sha256,
            },
          ],
        }),
      );
      expect(parsed.success).toBe(false);
    });

    it("rejects strings that Node's lenient decoder would shorten", () => {
      const lenient = "QUJD RA==";
      expect(Buffer.from(lenient, "base64").length).toBe(4);
      expect(lenient.length).toBeGreaterThan(
        Buffer.from(lenient, "base64").toString("base64").length,
      );
      expect(
        decodeRelayAttachments([{ contentBase64: lenient, sha256 }]),
      ).toMatchObject({ ok: false, code: "invalid_request" });
    });

    it("never hands an unvalidated string to the base64 decoder", () => {
      const fromSpy = vi.spyOn(Buffer, "from");
      try {
        decodeRelayAttachments([{ contentBase64: "QUJD RA==", sha256 }]);
        expect(fromSpy).not.toHaveBeenCalled();
      } finally {
        fromSpy.mockRestore();
      }
    });
  });

  describe("non-canonical base64 (T-B64-2)", () => {
    it.each([
      ["QR==", "QQ=="],
      ["QUJ=", "QUI="],
      ["QUK=", "QUI="],
    ])("rejects %s (canonical %s)", (contentBase64, canonical) => {
      expect(Buffer.from(contentBase64, "base64").toString("base64")).toBe(
        canonical,
      );
      const sha256 = createHash("sha256")
        .update(Buffer.from(contentBase64, "base64"))
        .digest("hex");
      expect(decodeRelayAttachments([{ contentBase64, sha256 }])).toMatchObject(
        { ok: false, code: "invalid_request" },
      );
    });

    it("accepts the canonical encodings", () => {
      for (const bytes of [
        Buffer.from("A"),
        Buffer.from("AB"),
        Buffer.from("ABC"),
      ]) {
        expect(decodeRelayAttachments([attachmentOf(bytes)]).ok).toBe(true);
      }
    });
  });

  describe("length caps before decoding (T-B64-3)", () => {
    const sha256 = "0".repeat(64);

    it("rejects one character over the per-attachment cap without decoding", () => {
      const fromSpy = vi.spyOn(Buffer, "from");
      try {
        const over = "A".repeat(RELAY_ATTACHMENT_MAX_BASE64_CHARS + 4);
        expect(
          decodeRelayAttachments([{ contentBase64: over, sha256 }]),
        ).toMatchObject({ ok: false, code: "payload_too_large" });
        const oneOver = "A".repeat(RELAY_ATTACHMENT_MAX_BASE64_CHARS + 1);
        expect(
          decodeRelayAttachments([{ contentBase64: oneOver, sha256 }]),
        ).toMatchObject({ ok: false, code: "payload_too_large" });
        expect(fromSpy).not.toHaveBeenCalled();
      } finally {
        fromSpy.mockRestore();
      }
    });

    it("rejects a total over the combined cap without decoding", () => {
      const fromSpy = vi.spyOn(Buffer, "from");
      try {
        const chunk = "A".repeat(RELAY_ATTACHMENT_MAX_BASE64_CHARS);
        const attachments = [chunk, chunk, chunk].map((contentBase64) => ({
          contentBase64,
          sha256,
        }));
        expect(
          attachments.length * RELAY_ATTACHMENT_MAX_BASE64_CHARS,
        ).toBeGreaterThan(RELAY_ATTACHMENTS_TOTAL_MAX_BASE64_CHARS);
        expect(decodeRelayAttachments(attachments)).toMatchObject({
          ok: false,
          code: "payload_too_large",
        });
        expect(fromSpy).not.toHaveBeenCalled();
      } finally {
        fromSpy.mockRestore();
      }
    });

    it("rejects more than four attachments without decoding", () => {
      const fromSpy = vi.spyOn(Buffer, "from");
      try {
        expect(
          decodeRelayAttachments(
            Array(5).fill({ contentBase64: "QQ==", sha256 }),
          ),
        ).toMatchObject({ ok: false, code: "payload_too_large" });
        expect(fromSpy).not.toHaveBeenCalled();
      } finally {
        fromSpy.mockRestore();
      }
    });

    it("maps a schema-level length overflow to payload_too_large", () => {
      const parsed = relayTellRequestSchema.safeParse(
        baseRequest({
          attachments: [
            {
              filename: "a.bin",
              mimeType: "application/octet-stream",
              contentBase64: "A".repeat(RELAY_ATTACHMENT_MAX_BASE64_CHARS + 4),
              sha256: "0".repeat(64),
            },
          ],
        }),
      );
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(classifyRelayParseError(parsed.error)).toBe("payload_too_large");
      }
    });

    it("measures decoded size against the byte limits", () => {
      const fiveMiB = Buffer.alloc(5 * 1024 * 1024, 7);
      expect(decodeRelayAttachments([attachmentOf(fiveMiB)]).ok).toBe(true);
      const overOne = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
      expect(decodeRelayAttachments([attachmentOf(overOne)])).toMatchObject({
        ok: false,
        code: "payload_too_large",
      });
      const half = Buffer.alloc(5 * 1024 * 1024, 1);
      const third = Buffer.alloc(1, 2);
      expect(
        decodeRelayAttachments([
          attachmentOf(half),
          attachmentOf(half),
          attachmentOf(third),
        ]),
      ).toMatchObject({ ok: false, code: "payload_too_large" });
    });
  });
});

describe("relay target routes (T-EMR-3, schema half)", () => {
  it("accepts only an optional threadId on remove", () => {
    expect(relayTargetsRemoveRequestSchema.safeParse({}).success).toBe(true);
    expect(
      relayTargetsRemoveRequestSchema.safeParse({ threadId: "thr_a" }).success,
    ).toBe(true);
  });

  it.each([
    [{ hostId: "host_b" }],
    [{ threadId: "thr_a", hostId: "host_b" }],
    [{ add: "thr_a" }],
    [{ threadIds: ["thr_a"] }],
    [{ threadId: "" }],
    [{ threadId: 1 }],
    [{ createdByUserId: "u" }],
  ])("rejects %j", (body) => {
    expect(relayTargetsRemoveRequestSchema.safeParse(body).success).toBe(false);
  });

  it("returns only IDs and creation times from the target list", () => {
    expect(
      relayTargetsResponseSchema.safeParse({
        targets: [{ threadId: "thr_a", createdAt: "2026-09-29T00:00:00Z" }],
      }).success,
    ).toBe(true);
    for (const extra of [{ threadTitle: "secret" }, { projectId: "prj_1" }]) {
      expect(
        relayTargetsResponseSchema.safeParse({
          targets: [
            { threadId: "thr_a", createdAt: "2026-09-29T00:00:00Z", ...extra },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("validates the remove response", () => {
    expect(
      relayTargetsRemoveResponseSchema.safeParse({ removed: 1, cancelled: 2 })
        .success,
    ).toBe(true);
    expect(
      relayTargetsRemoveResponseSchema.safeParse({ removed: -1, cancelled: 0 })
        .success,
    ).toBe(false);
  });
});

describe("relay error codes", () => {
  it("defines a status and retryable flag for every code", () => {
    for (const code of RELAY_ERROR_CODES) {
      expect(RELAY_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(typeof RELAY_ERROR_RETRYABLE[code]).toBe("boolean");
    }
    expect(RELAY_ERROR_HTTP_STATUS.payload_too_large).toBe(413);
    expect(RELAY_ERROR_HTTP_STATUS.host_revoked).toBe(401);
    expect(RELAY_ERROR_RETRYABLE.target_not_allowed).toBe(false);
    expect(RELAY_ERROR_RETRYABLE.relay_in_progress).toBe(true);
  });
});
