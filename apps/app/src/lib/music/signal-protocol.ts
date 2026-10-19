import {
  SIGNAL_SCHEMA_VERSION,
  SignalSequenceChecker,
  acceptSignalFrame,
  type SignalFrameV1,
} from "./signal-schema";

export const SIGNAL_PATH = "/signal/v1";
export const SIGNAL_HOST = "127.0.0.1";
export const SIGNAL_DEFAULT_PORT = 47615;
export const SIGNAL_DEFAULT_ORIGIN = "https://app.example.com";

export const SIGNAL_NONCE_BYTES = 16;
export const SIGNAL_PROOF_BYTES = 32;
export const SIGNAL_SECRET_BYTES = 32;

export const SIGNAL_HANDSHAKE_TIMEOUT_MS = 2000;
export const SIGNAL_MAX_CONNECTIONS = 4;
export const SIGNAL_MAX_INBOUND_BYTES = 512;
export const SIGNAL_MAX_BUFFERED_BYTES = 64 * 1024;
export const SIGNAL_PING_INTERVAL_MS = 10_000;
export const SIGNAL_PONG_TIMEOUT_MS = 20_000;
export const SIGNAL_SEND_HZ = 30;

export const CLOSE_POLICY = 1008;
export const CLOSE_GOING_AWAY = 1001;
export const CLOSE_REVOKED = 4000;
export const CLOSE_HANDSHAKE_TIMEOUT = 4008;

export type HmacFn = (key: Uint8Array, data: Uint8Array) => Promise<Uint8Array>;
export type RandomFn = (n: number) => Uint8Array;

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP: Record<string, number> = {};
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET[i]] = i;

export function encodeB64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    out += ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      ALPHABET[(n >> 18) & 63] +
      ALPHABET[(n >> 12) & 63] +
      ALPHABET[(n >> 6) & 63];
  }
  return out;
}

export function decodeB64url(s: unknown, length: number): Uint8Array | null {
  if (typeof s !== "string") return null;
  if (s.length !== Math.ceil((length * 4) / 3)) return null;
  const bytes = new Uint8Array(length);
  let acc = 0;
  let bits = 0;
  let j = 0;
  for (let i = 0; i < s.length; i++) {
    const v = LOOKUP[s[i]];
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[j++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  if (j !== length || acc !== 0) return null;
  return bytes;
}

function ascii(s: string): Uint8Array | null {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return null;
    out[i] = c;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function serverProofInput(
  cn: Uint8Array,
  sn: Uint8Array,
  origin: string,
): Uint8Array {
  const o = ascii(origin);
  if (!o) throw new Error("origin must be printable ASCII");
  return concat([ascii("srv")!, cn, sn, o]);
}

export function clientProofInput(
  cn: Uint8Array,
  sn: Uint8Array,
  origin: string,
): Uint8Array {
  const o = ascii(origin);
  if (!o) throw new Error("origin must be printable ASCII");
  return concat([ascii("cli")!, sn, cn, o]);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function parseExact(
  text: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const obj = x as Record<string, unknown>;
  const own = Object.keys(obj);
  if (own.length !== keys.length || !keys.every((k) => own.includes(k)))
    return null;
  if (obj.v !== SIGNAL_SCHEMA_VERSION) return null;
  return obj;
}

export function parseHello(text: unknown): { cn: Uint8Array } | null {
  const m = parseExact(text, ["v", "hello"]);
  const cn = m && decodeB64url(m.hello, SIGNAL_NONCE_BYTES);
  return cn ? { cn } : null;
}

export function parseServerChallenge(
  text: unknown,
): { sn: Uint8Array; sp: Uint8Array } | null {
  const m = parseExact(text, ["v", "sn", "sp"]);
  if (!m) return null;
  const sn = decodeB64url(m.sn, SIGNAL_NONCE_BYTES);
  const sp = decodeB64url(m.sp, SIGNAL_PROOF_BYTES);
  return sn && sp ? { sn, sp } : null;
}

export function parseClientProof(text: unknown): { cp: Uint8Array } | null {
  const m = parseExact(text, ["v", "cp"]);
  const cp = m && decodeB64url(m.cp, SIGNAL_PROOF_BYTES);
  return cp ? { cp } : null;
}

export const helloMessage = (cn: Uint8Array): string =>
  JSON.stringify({ v: SIGNAL_SCHEMA_VERSION, hello: encodeB64url(cn) });

export const challengeMessage = (sn: Uint8Array, sp: Uint8Array): string =>
  JSON.stringify({
    v: SIGNAL_SCHEMA_VERSION,
    sn: encodeB64url(sn),
    sp: encodeB64url(sp),
  });

export const proofMessage = (cp: Uint8Array): string =>
  JSON.stringify({ v: SIGNAL_SCHEMA_VERSION, cp: encodeB64url(cp) });

export type ClientAction =
  | { kind: "send"; text: string }
  | { kind: "frame"; frame: SignalFrameV1 }
  | { kind: "close"; reason: string };

export class SignalClientHandshake {
  private state:
    | "init"
    | "await-challenge"
    | "verifying"
    | "authed"
    | "closed" = "init";
  private cn: Uint8Array | null = null;
  private readonly seq = new SignalSequenceChecker();

  constructor(
    private readonly secret: Uint8Array,
    private readonly origin: string,
    private readonly hmac: HmacFn,
    private readonly random: RandomFn,
  ) {}

  get authed(): boolean {
    return this.state === "authed";
  }

  get closed(): boolean {
    return this.state === "closed";
  }

  start(): string {
    if (this.state !== "init") throw new Error("handshake already started");
    this.cn = this.random(SIGNAL_NONCE_BYTES);
    this.state = "await-challenge";
    return helloMessage(this.cn);
  }

  async onMessage(text: unknown): Promise<ClientAction> {
    if (this.state === "await-challenge") {
      const ch = parseServerChallenge(text);
      if (!ch) return this.close("malformed challenge");
      this.state = "verifying";
      const expected = await this.hmac(
        this.secret,
        serverProofInput(this.cn!, ch.sn, this.origin),
      );
      if (this.state !== "verifying")
        return this.close("closed during verification");
      if (!constantTimeEqual(expected, ch.sp))
        return this.close("server proof mismatch");
      const cp = await this.hmac(
        this.secret,
        clientProofInput(this.cn!, ch.sn, this.origin),
      );
      if (this.state !== "verifying")
        return this.close("closed during verification");
      this.state = "authed";
      return { kind: "send", text: proofMessage(cp) };
    }
    if (this.state === "authed") {
      let x: unknown;
      try {
        x = typeof text === "string" ? JSON.parse(text) : undefined;
      } catch {
        return this.close("frame is not JSON");
      }
      const r = acceptSignalFrame(x, this.seq);
      return r.ok ? { kind: "frame", frame: r.value } : this.close(r.error);
    }
    return this.close(`unexpected message in state ${this.state}`);
  }

  private close(reason: string): ClientAction {
    this.state = "closed";
    return { kind: "close", reason };
  }
}
