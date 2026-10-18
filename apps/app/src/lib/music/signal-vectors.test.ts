import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SIGNAL_FIELD_KEYS,
  SIGNAL_FRAME_KEYS,
  SignalSequenceChecker,
  acceptSignalFrame,
  validateSignalFields,
  validateSignalFrame,
} from "./signal-schema";
import {
  SignalClientHandshake,
  challengeMessage,
  clientProofInput,
  decodeB64url,
  encodeB64url,
  helloMessage,
  parseHello,
  parseServerChallenge,
  proofMessage,
  serverProofInput,
} from "./signal-protocol";
import { webCryptoHmac } from "./webcrypto-hmac";

const vectorsSchema = z.object({
  version: z.literal(1),
  schema: z.object({
    valid: z.array(z.object({ name: z.string(), frame: z.unknown() })),
    invalid: z.array(
      z.object({ name: z.string(), frame: z.unknown(), error: z.string() }),
    ),
    invalidJson: z.array(
      z.object({ name: z.string(), json: z.string(), error: z.string() }),
    ),
  }),
  sequence: z.array(
    z.object({
      name: z.string(),
      frames: z.array(z.record(z.string(), z.unknown())),
      expect: z.array(z.boolean()),
    }),
  ),
  handshake: z.array(
    z.object({
      name: z.string(),
      secretBytes: z.array(z.number().int().min(0).max(255)).length(32),
      origin: z.string(),
      cn: z.string(),
      sn: z.string(),
      sp: z.string(),
      cp: z.string(),
      hello: z.string(),
      challenge: z.string(),
      proof: z.string(),
    }),
  ),
  encoding: z.object({
    valid: z.array(z.object({ text: z.string(), bytes: z.number().int() })),
    invalid: z.array(
      z.object({ text: z.string(), bytes: z.number().int(), why: z.string() }),
    ),
  }),
  handshakeMessages: z.object({
    hello: z.array(z.string()),
    challenge: z.array(z.string()),
  }),
});

const vectors = vectorsSchema.parse(
  JSON.parse(
    readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "signal-v1.vectors.json"),
      "utf8",
    ),
  ),
);

const baseFrame = z
  .record(z.string(), z.unknown())
  .parse(vectors.schema.valid[0]?.frame);

function decodeExact(text: string, length: number): Uint8Array {
  const bytes = decodeB64url(text, length);
  if (!bytes) throw new Error(`vector ${text} does not decode`);
  return bytes;
}

describe("signal wire schema v1 shared vectors", () => {
  it.each(vectors.schema.valid)("accepts valid frame: $name", ({ frame }) => {
    expect(validateSignalFrame(frame).ok).toBe(true);
  });

  it.each(vectors.schema.invalid)(
    "rejects invalid frame with the exact error: $name",
    ({ frame, error }) => {
      expect(validateSignalFrame(frame)).toEqual({ ok: false, error });
    },
  );

  it.each(vectors.schema.invalidJson)(
    "rejects invalid JSON frame: $name",
    ({ json, error }) => {
      if (error === "parse") {
        expect(() => JSON.parse(json)).toThrow();
        return;
      }
      expect(validateSignalFrame(JSON.parse(json))).toEqual({
        ok: false,
        error,
      });
    },
  );

  it("rejects every missing key with its name", () => {
    for (const key of SIGNAL_FRAME_KEYS) {
      const frame = { ...baseFrame };
      delete frame[key];
      expect(validateSignalFrame(frame)).toEqual({
        ok: false,
        error: `missing key "${key}"`,
      });
    }
  });

  it("rejects non-finite numbers on every numeric key", () => {
    for (const key of [
      "seq",
      "t",
      "energy",
      "beatEnv",
      "bpmConfidence",
      "keyConfidence",
      "bpm",
      "key",
    ]) {
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(validateSignalFrame({ ...baseFrame, [key]: value }).ok).toBe(
          false,
        );
      }
    }
  });

  it("rejects a fractional key, an extra key and class instances", () => {
    expect(validateSignalFrame({ ...baseFrame, key: 1.5 }).ok).toBe(false);
    expect(validateSignalFrame({ ...baseFrame, extra: 1 }).ok).toBe(false);
    expect(
      validateSignalFrame(Object.assign(Object.create(null), baseFrame)).ok,
    ).toBe(true);
    class Frame {}
    expect(validateSignalFrame(Object.assign(new Frame(), baseFrame)).ok).toBe(
      false,
    );
  });

  it("validates the nine field keys on their own", () => {
    const fields = Object.fromEntries(
      SIGNAL_FIELD_KEYS.map((key) => [key, baseFrame[key]]),
    );
    expect(validateSignalFields(fields).ok).toBe(true);
    expect(validateSignalFields({ ...fields, seq: 0 })).toEqual({
      ok: false,
      error: 'unexpected key "seq"',
    });
  });

  it.each(vectors.sequence)(
    "applies the sequence rules: $name",
    ({ frames, expect: expected }) => {
      const checker = new SignalSequenceChecker();
      expect(
        frames.map(
          (frame) => acceptSignalFrame({ ...baseFrame, ...frame }, checker).ok,
        ),
      ).toEqual(expected);
    },
  );

  it.each(vectors.encoding.valid)(
    "round-trips canonical base64url $text",
    ({ text, bytes }) => {
      expect(encodeB64url(decodeExact(text, bytes))).toBe(text);
    },
  );

  it.each(vectors.encoding.invalid)(
    "rejects non-canonical base64url ($why)",
    ({ text, bytes }) => {
      expect(decodeB64url(text, bytes)).toBeNull();
    },
  );

  it.each(vectors.handshake)(
    "reproduces handshake vector with WebCrypto: $name",
    async (vector) => {
      const secret = Uint8Array.from(vector.secretBytes);
      const cn = decodeExact(vector.cn, 16);
      const sn = decodeExact(vector.sn, 16);
      expect(
        encodeB64url(
          await webCryptoHmac(secret, serverProofInput(cn, sn, vector.origin)),
        ),
      ).toBe(vector.sp);
      expect(
        encodeB64url(
          await webCryptoHmac(secret, clientProofInput(cn, sn, vector.origin)),
        ),
      ).toBe(vector.cp);
      expect(helloMessage(cn)).toBe(vector.hello);
      expect(challengeMessage(sn, decodeExact(vector.sp, 32))).toBe(
        vector.challenge,
      );
      expect(proofMessage(decodeExact(vector.cp, 32))).toBe(vector.proof);

      const client = new SignalClientHandshake(
        secret,
        vector.origin,
        webCryptoHmac,
        () => cn,
      );
      expect(client.start()).toBe(vector.hello);
      expect(await client.onMessage(vector.challenge)).toEqual({
        kind: "send",
        text: vector.proof,
      });
      expect(client.authed).toBe(true);
    },
  );

  it("closes on a server proof made with the wrong secret", async () => {
    const vector = vectors.handshake[0]!;
    const wrongSecret = Uint8Array.from(vector.secretBytes, (b) => b ^ 0xff);
    const client = new SignalClientHandshake(
      wrongSecret,
      vector.origin,
      webCryptoHmac,
      () => decodeExact(vector.cn, 16),
    );
    client.start();
    expect(await client.onMessage(vector.challenge)).toEqual({
      kind: "close",
      reason: "server proof mismatch",
    });
    expect(client.closed).toBe(true);
  });

  it("rejects every malformed handshake message vector", () => {
    for (const text of vectors.handshakeMessages.hello) {
      expect(parseHello(text)).toBeNull();
    }
    for (const text of vectors.handshakeMessages.challenge) {
      expect(parseServerChallenge(text)).toBeNull();
    }
  });
});
