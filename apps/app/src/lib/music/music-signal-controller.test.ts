// @vitest-environment jsdom
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onDiagnostic } from "@/lib/diagnostics";
import {
  decodeMusicSecret,
  MUSIC_ATTRIBUTE,
  MUSIC_GLOW_PROPERTY,
  MUSIC_HUE_PROPERTY,
  MUSIC_RECONNECT_MAX_MS,
  MUSIC_RECONNECT_MIN_MS,
  MusicSignalController,
  musicSignalUrl,
  type MusicEnvironment,
  type MusicSignalStatus,
  type MusicSocket,
  type MusicSocketHandlers,
} from "./music-signal-controller";
import { keyHue, MUSIC_FADE_MS, MUSIC_FRESH_MS } from "./music-motion";
import {
  challengeMessage,
  CLOSE_HANDSHAKE_TIMEOUT,
  CLOSE_REVOKED,
  clientProofInput,
  constantTimeEqual,
  parseClientProof,
  parseHello,
  serverProofInput,
  SIGNAL_DEFAULT_ORIGIN,
  SIGNAL_DEFAULT_PORT,
  SIGNAL_HANDSHAKE_TIMEOUT_MS,
  type HmacFn,
} from "./signal-protocol";
import type { SignalFields } from "./signal-schema";

const SECRET_BASE64 = Buffer.from(
  Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256),
).toString("base64");
const SECRET = decodeMusicSecret(SECRET_BASE64)!;
const OTHER_SECRET = new Uint8Array(32).fill(7);
const ORIGIN = SIGNAL_DEFAULT_ORIGIN;
const FRAME_MS = 16;

const vectors = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "signal-v1.vectors.json"),
    "utf8",
  ),
) as {
  schema: { invalid: { name: string; frame: unknown }[] };
};

const nodeHmac: HmacFn = async (key, data) =>
  new Uint8Array(createHmac("sha256", key).update(data).digest());

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

const fields = (over: Partial<SignalFields> = {}): SignalFields => ({
  energy: 0.5,
  beatEnv: 0,
  bpmConfidence: 0.8,
  keyConfidence: 0.9,
  beat: false,
  synthetic: false,
  bpm: 120,
  key: 2,
  keyMode: "major",
  ...over,
});

class Clock {
  t = 1000;
  private nextId = 1;
  timers = new Map<number, { at: number; callback: () => void }>();
  frames = new Map<number, () => void>();

  setTimer = (callback: () => void, ms: number) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, callback });
    return id;
  };

  clearTimer = (id: number) => {
    this.timers.delete(id);
  };

  requestFrame = (callback: () => void) => {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  };

  cancelFrame = (id: number) => {
    this.frames.delete(id);
  };

  now = () => this.t;

  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + FRAME_MS);
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.t)
        .sort((a, b) => a[1].at - b[1].at);
      for (const [id, timer] of due) {
        this.timers.delete(id);
        timer.callback();
      }
      const frames = [...this.frames.values()];
      this.frames.clear();
      for (const frame of frames) frame();
      await settle();
    }
  }
}

class FakeSocket implements MusicSocket {
  sent: string[] = [];
  closed: { code: number; reason: string } | null = null;
  authed = false;
  private seq = 0;
  private cn: Uint8Array | null = null;
  private sn = new Uint8Array(16).fill(3);

  constructor(
    readonly url: string,
    private readonly handlers: MusicSocketHandlers,
    private readonly server: FakeServer,
  ) {}

  send(text: string): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push(text);
    void this.server.onClientMessage(this, text);
  }

  close(code: number, reason: string): void {
    if (code !== 1000 && (code < 3000 || code > 4999)) {
      throw new Error(`InvalidAccessError: close code ${code}`);
    }
    this.closed = { code, reason };
  }

  async handle(text: string): Promise<void> {
    if (this.cn === null) {
      const hello = parseHello(text);
      if (!hello) throw new Error(`bad hello ${text}`);
      this.cn = hello.cn;
      if (this.server.mode === "silent") return;
      if (this.server.mode === "frames-first") {
        this.frame();
        return;
      }
      const key =
        this.server.mode === "wrong-sp" ? OTHER_SECRET : this.server.secret;
      const sp = await nodeHmac(
        key,
        serverProofInput(this.cn, this.sn, ORIGIN),
      );
      this.deliver(challengeMessage(this.sn, sp));
      return;
    }
    const proof = parseClientProof(text);
    if (!proof) throw new Error(`bad proof ${text}`);
    const expected = await nodeHmac(
      this.server.secret,
      clientProofInput(this.cn, this.sn, ORIGIN),
    );
    this.authed = constantTimeEqual(expected, proof.cp);
  }

  open(): void {
    this.handlers.open();
  }

  deliver(text: unknown): void {
    if (!this.closed) this.handlers.message(text);
  }

  frame(over: Partial<SignalFields> = {}, seq = this.seq): void {
    this.seq = seq + 1;
    this.deliver(JSON.stringify({ v: 1, seq, t: seq * 33, ...fields(over) }));
  }

  serverClose(): void {
    if (this.closed) return;
    this.closed = { code: CLOSE_REVOKED, reason: "server" };
    this.handlers.close();
  }
}

class FakeServer {
  sockets: FakeSocket[] = [];
  secret = SECRET;
  mode: "normal" | "wrong-sp" | "silent" | "frames-first" | "refuse" = "normal";

  connect = (url: string, handlers: MusicSocketHandlers): MusicSocket => {
    const socket = new FakeSocket(url, handlers, this);
    this.sockets.push(socket);
    queueMicrotask(() => {
      if (this.mode === "refuse") socket.serverClose();
      else socket.open();
    });
    return socket;
  };

  async onClientMessage(socket: FakeSocket, text: string): Promise<void> {
    await socket.handle(text);
  }

  get last(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (!socket) throw new Error("no socket");
    return socket;
  }
}

const visible: MusicEnvironment = {
  visible: true,
  suppressed: false,
  rest: false,
};

interface Harness {
  clock: Clock;
  server: FakeServer;
  controller: MusicSignalController;
  statuses: MusicSignalStatus[];
  pairing: { port: number; secret: Uint8Array } | null | "reject";
  loads: number;
}

function harness(): Harness {
  const clock = new Clock();
  const server = new FakeServer();
  const statuses: MusicSignalStatus[] = [];
  const h: Harness = {
    clock,
    server,
    statuses,
    pairing: { port: SIGNAL_DEFAULT_PORT, secret: SECRET },
    loads: 0,
    controller: null as unknown as MusicSignalController,
  };
  let random = 0;
  h.controller = new MusicSignalController({
    root: document.documentElement,
    origin: ORIGIN,
    connect: server.connect,
    loadPairing: async () => {
      h.loads++;
      if (h.pairing === "reject") throw new Error(`denied ${SECRET_BASE64}`);
      return h.pairing;
    },
    hmac: nodeHmac,
    random: (n) => new Uint8Array(n).fill(++random),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    onStatus: (status) => statuses.push(status),
  });
  return h;
}

async function start(h: Harness): Promise<FakeSocket> {
  h.controller.setEnvironment(visible);
  h.controller.setEnabled(true, "47615:set");
  await h.clock.advance(FRAME_MS);
  return h.server.last;
}

async function stream(
  socket: FakeSocket,
  clock: Clock,
  ms: number,
  over: Partial<SignalFields> = {},
): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 32) {
    socket.frame(over);
    await clock.advance(32);
  }
}

const root = () => document.documentElement;
const hueValue = () => root().style.getPropertyValue(MUSIC_HUE_PROPERTY);
const glowValue = () => root().style.getPropertyValue(MUSIC_GLOW_PROPERTY);
const isPristine = () =>
  hueValue() === "" &&
  glowValue() === "" &&
  !root().hasAttribute(MUSIC_ATTRIBUTE);

let baseline = "";

beforeEach(() => {
  root().removeAttribute("style");
  root().removeAttribute(MUSIC_ATTRIBUTE);
  baseline = root().outerHTML;
});

afterEach(() => {
  root().removeAttribute("style");
  root().removeAttribute(MUSIC_ATTRIBUTE);
});

describe("MusicSignalController handshake", () => {
  it("authenticates mutually on loopback and only then uses frames", async () => {
    const h = harness();
    const socket = await start(h);
    expect(socket.url).toBe(musicSignalUrl(SIGNAL_DEFAULT_PORT));
    expect(socket.url).toBe("ws://127.0.0.1:47615/signal/v1");
    expect(socket.sent).toHaveLength(2);
    expect(socket.authed).toBe(true);
    expect(h.statuses.at(-1)).toEqual({ kind: "connected" });
    await stream(socket, h.clock, 3000);
    expect(Number(hueValue())).toBeCloseTo(keyHue(2, "major"), 0);
    expect(root().hasAttribute(MUSIC_ATTRIBUTE)).toBe(true);
    h.controller.dispose();
  });

  it("closes on a wrong server proof without sending a client proof", async () => {
    const h = harness();
    h.server.mode = "wrong-sp";
    const socket = await start(h);
    expect(socket.sent).toHaveLength(1);
    expect(socket.closed?.reason).toBe("server proof mismatch");
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "retrying",
      retryInMs: MUSIC_RECONNECT_MIN_MS,
    });
    await h.clock.advance(3000);
    expect(isPristine()).toBe(true);
    h.controller.dispose();
  });

  it("ignores frames sent before authentication", async () => {
    const h = harness();
    h.server.mode = "frames-first";
    const socket = await start(h);
    expect(socket.closed?.reason).toBe("malformed challenge");
    await h.clock.advance(3000);
    expect(isPristine()).toBe(true);
    h.controller.dispose();
  });

  it("gives up a handshake after its timeout with a script-legal close code", async () => {
    const h = harness();
    h.server.mode = "silent";
    const socket = await start(h);
    await h.clock.advance(SIGNAL_HANDSHAKE_TIMEOUT_MS);
    expect(socket.closed).toEqual({
      code: CLOSE_HANDSHAKE_TIMEOUT,
      reason: "handshake timed out",
    });
    h.controller.dispose();
  });
});

describe("MusicSignalController frames", () => {
  it.each(vectors.schema.invalid.map((v) => [v.name, v.frame] as const))(
    "drops the invalid frame vector %s and reconnects",
    async (_name, frame) => {
      const h = harness();
      const socket = await start(h);
      socket.deliver(JSON.stringify(frame));
      await h.clock.advance(3000);
      expect(socket.closed).not.toBeNull();
      expect(isPristine()).toBe(true);
      expect(h.server.sockets.length).toBeGreaterThan(1);
      h.controller.dispose();
    },
  );

  it("drops a frame whose seq does not advance", async () => {
    const h = harness();
    const socket = await start(h);
    socket.frame({ keyConfidence: 0, energy: 0 });
    socket.frame({ key: 7 }, 0);
    await h.clock.advance(3000);
    expect(socket.closed?.reason).toMatch(/^seq must be 1/);
    expect(hueValue()).toBe("");
    expect(glowValue()).toBe("");
    h.controller.dispose();
  });

  it("ignores synthetic frames entirely", async () => {
    const h = harness();
    const socket = await start(h);
    await stream(socket, h.clock, 4000, { synthetic: true, beat: true });
    expect(isPristine()).toBe(true);
    h.controller.dispose();
  });

  it("fades back to today's output exactly once frames go stale", async () => {
    const h = harness();
    const socket = await start(h);
    await stream(socket, h.clock, 3000, { beat: true });
    expect(isPristine()).toBe(false);
    await h.clock.advance(MUSIC_FRESH_MS - 100);
    expect(isPristine()).toBe(false);
    await h.clock.advance(100 + MUSIC_FADE_MS + 500);
    expect(isPristine()).toBe(true);
    expect(root().outerHTML).toBe(baseline);
    expect(h.clock.frames.size).toBe(0);
    h.controller.dispose();
  });
});

describe("MusicSignalController lifecycle", () => {
  it("backs off from 1 s doubling to 60 s and resets after authenticating", async () => {
    const h = harness();
    h.server.mode = "refuse";
    await start(h);
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      const status = h.statuses.at(-1);
      if (status?.kind !== "retrying") throw new Error("not retrying");
      delays.push(status.retryInMs);
      await h.clock.advance(status.retryInMs);
    }
    expect(delays).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
    expect(Math.max(...delays)).toBe(MUSIC_RECONNECT_MAX_MS);
    h.server.mode = "normal";
    await h.clock.advance(MUSIC_RECONNECT_MAX_MS);
    expect(h.statuses.at(-1)).toEqual({ kind: "connected" });
    h.server.last.serverClose();
    await settle();
    expect(h.statuses.at(-1)).toMatchObject({ retryInMs: 1000 });
    h.controller.dispose();
  });

  it("reconnects after the server closes and keeps rendering", async () => {
    const h = harness();
    const first = await start(h);
    await stream(first, h.clock, 1000);
    first.serverClose();
    await h.clock.advance(MUSIC_RECONNECT_MIN_MS + FRAME_MS);
    const second = h.server.last;
    expect(second).not.toBe(first);
    expect(second.authed).toBe(true);
    await stream(second, h.clock, 1000);
    expect(isPristine()).toBe(false);
    h.controller.dispose();
  });

  it("retries when the pairing cannot be loaded and reloads it each attempt", async () => {
    const h = harness();
    h.pairing = "reject";
    h.controller.setEnvironment(visible);
    h.controller.setEnabled(true, "47615:set");
    await h.clock.advance(FRAME_MS);
    expect(h.server.sockets).toHaveLength(0);
    expect(h.statuses.at(-1)).toMatchObject({
      kind: "retrying",
      reason: "music pairing could not be loaded",
    });
    h.pairing = { port: 50_000, secret: SECRET };
    await h.clock.advance(MUSIC_RECONNECT_MIN_MS + FRAME_MS);
    expect(h.loads).toBe(2);
    expect(h.server.last.url).toBe("ws://127.0.0.1:50000/signal/v1");
    h.controller.dispose();
  });

  it("reconnects at once when the pairing revision changes", async () => {
    const h = harness();
    const first = await start(h);
    h.pairing = { port: 50_001, secret: SECRET };
    h.controller.setEnabled(true, "50001:set");
    await h.clock.advance(FRAME_MS);
    expect(first.closed?.code).toBe(1000);
    expect(h.server.last.url).toBe("ws://127.0.0.1:50001/signal/v1");
    h.controller.dispose();
  });

  it("mode off closes the socket, fades, then restores today's output exactly", async () => {
    const h = harness();
    const socket = await start(h);
    await stream(socket, h.clock, 3000, { beat: true });
    h.controller.setEnabled(false, "47615:set");
    expect(socket.closed).toEqual({ code: 1000, reason: "music mode stopped" });
    expect(isPristine()).toBe(false);
    await h.clock.advance(MUSIC_FADE_MS + 500);
    expect(root().outerHTML).toBe(baseline);
    expect(h.clock.timers.size).toBe(0);
    expect(h.clock.frames.size).toBe(0);
    expect(h.statuses.at(-1)).toEqual({ kind: "off" });
    await h.clock.advance(MUSIC_RECONNECT_MAX_MS * 2);
    expect(h.server.sockets).toHaveLength(1);
    h.controller.dispose();
  });

  it("theme change disables it the same way as mode off", async () => {
    const h = harness();
    const socket = await start(h);
    await stream(socket, h.clock, 3000);
    h.controller.setEnabled(false, "47615:set");
    await h.clock.advance(MUSIC_FADE_MS + 500);
    expect(socket.closed?.code).toBe(1000);
    expect(root().outerHTML).toBe(baseline);
    h.controller.dispose();
  });

  it("a hidden window disconnects and clears output, then reconnects when visible", async () => {
    const h = harness();
    const socket = await start(h);
    await stream(socket, h.clock, 3000);
    h.controller.setEnvironment({ ...visible, visible: false });
    expect(socket.closed?.code).toBe(1000);
    expect(root().outerHTML).toBe(baseline);
    expect(h.statuses.at(-1)).toEqual({ kind: "paused" });
    await h.clock.advance(MUSIC_RECONNECT_MAX_MS);
    expect(h.server.sockets).toHaveLength(1);
    h.controller.setEnvironment(visible);
    await h.clock.advance(FRAME_MS);
    expect(h.server.sockets).toHaveLength(2);
    expect(h.server.last.authed).toBe(true);
    h.controller.dispose();
  });

  it("unmount closes everything immediately and leaves no timers", async () => {
    const h = harness();
    const socket = await start(h);
    await stream(socket, h.clock, 3000, { beat: true });
    h.controller.dispose();
    expect(socket.closed?.code).toBe(1000);
    expect(root().outerHTML).toBe(baseline);
    expect(h.clock.timers.size).toBe(0);
    expect(h.clock.frames.size).toBe(0);
    socket.frame();
    h.controller.setEnabled(true, "47615:set");
    h.controller.setEnvironment(visible);
    await h.clock.advance(3000);
    expect(root().outerHTML).toBe(baseline);
    expect(h.server.sockets).toHaveLength(1);
  });

  it("a frame racing a disconnect is not applied", async () => {
    const h = harness();
    const socket = await start(h);
    socket.frame();
    h.controller.setEnabled(false, "47615:set");
    await h.clock.advance(3000);
    expect(root().outerHTML).toBe(baseline);
    h.controller.dispose();
  });
});

describe("MusicSignalController accessibility and rest", () => {
  it("applies nothing and opens no socket under reduced motion or forced colours", async () => {
    const h = harness();
    h.controller.setEnvironment({ ...visible, suppressed: true });
    h.controller.setEnabled(true, "47615:set");
    await h.clock.advance(5000);
    expect(h.server.sockets).toHaveLength(0);
    expect(root().outerHTML).toBe(baseline);
    h.controller.dispose();
  });

  it("clears output at once when suppression turns on mid-stream", async () => {
    const h = harness();
    const socket = await start(h);
    await stream(socket, h.clock, 3000, { beat: true });
    h.controller.setEnvironment({ ...visible, suppressed: true });
    expect(socket.closed?.code).toBe(1000);
    expect(root().outerHTML).toBe(baseline);
    await h.clock.advance(3000);
    expect(root().outerHTML).toBe(baseline);
    h.controller.dispose();
  });

  it("turns the glow off at rest while the hue keeps following the music", async () => {
    const h = harness();
    const socket = await start(h);
    await stream(socket, h.clock, 3000, { beat: true, energy: 1 });
    expect(Number(glowValue())).toBeGreaterThan(0);
    h.controller.setEnvironment({ ...visible, rest: true });
    await stream(socket, h.clock, 3000, {
      beat: true,
      energy: 1,
      key: 5,
    });
    expect(glowValue()).toBe("");
    expect(Number(hueValue())).toBeCloseTo(keyHue(5, "major"), 0);
    h.controller.dispose();
  });
});

describe("MusicSignalController redaction", () => {
  it("never exposes the secret or frames to diagnostics, console, status or the wire", async () => {
    const events: unknown[] = [];
    const stopDiagnostics = onDiagnostic((event) => events.push(event));
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      const h = harness();
      const socket = await start(h);
      await stream(socket, h.clock, 2000, { beat: true });
      socket.deliver("not json");
      await h.clock.advance(MUSIC_RECONNECT_MIN_MS + FRAME_MS);
      h.server.mode = "wrong-sp";
      h.server.last.serverClose();
      await h.clock.advance(5000);
      h.pairing = "reject";
      await h.clock.advance(10_000);
      h.controller.dispose();

      const secretHex = Buffer.from(SECRET).toString("hex");
      const secretUrl = Buffer.from(SECRET).toString("base64url");
      const forbidden = [SECRET_BASE64, secretHex, secretUrl, "energy"];
      const surfaces = [
        JSON.stringify(events),
        JSON.stringify(h.statuses),
        JSON.stringify(consoleSpies.map((spy) => spy.mock.calls)),
        h.server.sockets.flatMap((s) => s.sent).join("\n"),
        root().outerHTML,
      ];
      for (const surface of surfaces) {
        for (const value of forbidden) expect(surface).not.toContain(value);
      }
      expect(events).toEqual([]);
      for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
      for (const sent of h.server.sockets.flatMap((s) => s.sent)) {
        expect(Object.keys(JSON.parse(sent)).sort()).toEqual(
          sent.includes('"hello"') ? ["hello", "v"] : ["cp", "v"],
        );
      }
    } finally {
      stopDiagnostics();
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });
});

describe("decodeMusicSecret", () => {
  it("accepts exactly 32 bytes of standard base64", () => {
    expect(decodeMusicSecret(SECRET_BASE64)).toHaveLength(32);
    expect(decodeMusicSecret("AAAA")).toBeNull();
    expect(decodeMusicSecret("not base64!")).toBeNull();
  });
});
