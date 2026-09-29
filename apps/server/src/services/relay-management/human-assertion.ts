import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import {
  getConnectBinding,
  type ConnectBindingRow,
  type DbConnection,
} from "@bb/db";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import {
  getGateAuthKind,
  type GateAuthHeaderReader,
} from "../../request-context.js";
import type { RelayAssertionKey } from "./assertion-keys.js";

export const GATE_ASSERTION_HEADER_NAME = "x-bb-gate-assertion";
export const HUMAN_SESSION_REQUIRED_CODE = "human_session_required";
export const RELAY_ASSERTION_MAX_LIFETIME_S = 60;
export const RELAY_ASSERTION_CLOCK_SKEW_S = 5;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

const headerSchema = z
  .object({
    alg: z.literal("EdDSA"),
    kid: z.string().min(1).max(128),
    typ: z.string().max(32).optional(),
  })
  .strict();

const claimsSchema = z
  .object({
    iss: z.string().min(1),
    aud: z.string().min(1),
    sub: z.string().min(1),
    kind: z.literal("human-session"),
    method: z.string().min(1),
    path: z.string().min(1),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().nonnegative(),
    jti: z.string().regex(/^[A-Za-z0-9_-]{22,64}$/u),
  })
  .strict();

export interface HumanAssertionRequest extends GateAuthHeaderReader {
  req: GateAuthHeaderReader["req"] & {
    arrayBuffer(): Promise<ArrayBuffer>;
    method: string;
    url: string;
  };
}

export interface VerifiedHumanAssertion {
  binding: ConnectBindingRow;
  expiresAtMs: number;
  jti: string;
}

export interface HumanAssertionDeps {
  db: DbConnection;
  keys: readonly RelayAssertionKey[];
  now?: () => number;
}

export function humanSessionRequired(): ApiError {
  return new ApiError(
    403,
    HUMAN_SESSION_REQUIRED_CODE,
    "Relay targets can only be managed by a signed-in human through the app. Open the machine settings page to manage them.",
  );
}

function decodeBase64Url(value: string): Buffer | null {
  if (!BASE64URL_PATTERN.test(value)) return null;
  return Buffer.from(value, "base64url");
}

function decodeJson(segment: string): unknown {
  const bytes = decodeBase64Url(segment);
  if (bytes === null) return null;
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

function importPublicKey(encoded: string): KeyObject | null {
  const raw = decodeBase64Url(encoded);
  if (raw === null || raw.length !== ED25519_PUBLIC_KEY_BYTES) return null;
  try {
    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

export async function verifyHumanAssertion(
  context: HumanAssertionRequest,
  deps: HumanAssertionDeps,
): Promise<VerifiedHumanAssertion> {
  const nowMs = (deps.now ?? Date.now)();
  const fail = humanSessionRequired;

  if (getGateAuthKind(context) === "machine") throw fail();

  const binding = getConnectBinding(deps.db);
  if (binding === null) throw fail();

  const token = context.req.header(GATE_ASSERTION_HEADER_NAME);
  if (token === undefined) throw fail();
  const segments = token.split(".");
  if (segments.length !== 3) throw fail();
  const [headerSegment, payloadSegment, signatureSegment] = segments as [
    string,
    string,
    string,
  ];

  const header = headerSchema.safeParse(decodeJson(headerSegment));
  if (!header.success) throw fail();
  const signature = decodeBase64Url(signatureSegment);
  if (signature === null || signature.length !== ED25519_SIGNATURE_BYTES) {
    throw fail();
  }

  const key = deps.keys.find(
    (entry) =>
      entry.kid === header.data.kid && entry.runtime === binding.runtime,
  );
  if (key === undefined) throw fail();
  if (nowMs < key.notBefore || nowMs > key.notAfter) throw fail();
  const publicKey = importPublicKey(key.publicKey);
  if (publicKey === null) throw fail();
  const signatureValid = verifySignature(
    null,
    Buffer.from(`${headerSegment}.${payloadSegment}`, "ascii"),
    publicKey,
    signature,
  );
  if (!signatureValid) throw fail();

  const claims = claimsSchema.safeParse(decodeJson(payloadSegment));
  if (!claims.success) throw fail();
  const claim = claims.data;

  if (claim.iss !== key.issuer || claim.iss !== binding.issuer) throw fail();
  if (claim.aud !== binding.serverId) throw fail();
  if (claim.sub !== binding.ownerUserId) throw fail();

  const url = new URL(context.req.url);
  if (url.search !== "") throw fail();
  if (
    claim.method.toUpperCase() !== context.req.method.toUpperCase() ||
    claim.path !== url.pathname
  ) {
    throw fail();
  }

  const nowS = nowMs / 1000;
  if (
    claim.iat > nowS + RELAY_ASSERTION_CLOCK_SKEW_S ||
    nowS > claim.exp ||
    claim.exp - claim.iat > RELAY_ASSERTION_MAX_LIFETIME_S ||
    claim.exp < claim.iat
  ) {
    throw fail();
  }
  const iatMs = claim.iat * 1000;
  if (iatMs < key.notBefore || iatMs > key.notAfter) throw fail();

  if ((await context.req.arrayBuffer()).byteLength !== 0) throw fail();

  return { binding, expiresAtMs: claim.exp * 1000, jti: claim.jti };
}
