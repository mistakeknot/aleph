import { ambientHueFor, MusicMotion } from "./music-motion";
import {
  CLOSE_HANDSHAKE_TIMEOUT,
  SIGNAL_HANDSHAKE_TIMEOUT_MS,
  SIGNAL_HOST,
  SIGNAL_PATH,
  SIGNAL_SECRET_BYTES,
  SignalClientHandshake,
  type HmacFn,
  type RandomFn,
} from "./signal-protocol";

export const MUSIC_HUE_PROPERTY = "--bb-music-hue";
export const MUSIC_GLOW_PROPERTY = "--bb-music-glow";
export const MUSIC_ATTRIBUTE = "data-bb-music";
export const MUSIC_AMBIENT_WAVE_PROPERTY = "--bb-ambient-wave";
export const MUSIC_RECONNECT_MIN_MS = 1000;
export const MUSIC_RECONNECT_MAX_MS = 60_000;
export const MUSIC_CLOSE_NORMAL = 1000;

export interface MusicSocketHandlers {
  open(): void;
  message(data: unknown): void;
  close(): void;
}

export interface MusicSocket {
  send(text: string): void;
  close(code: number, reason: string): void;
}

export type MusicSocketFactory = (
  url: string,
  handlers: MusicSocketHandlers,
) => MusicSocket;

export interface MusicPairingBytes {
  port: number;
  secret: Uint8Array;
}

export type MusicSignalStatus =
  | { kind: "off" }
  | { kind: "paused" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "retrying"; reason: string; retryInMs: number };

export interface MusicEnvironment {
  visible: boolean;
  suppressed: boolean;
  rest: boolean;
}

export interface MusicSignalDeps {
  root: HTMLElement;
  origin: string;
  connect: MusicSocketFactory;
  loadPairing(): Promise<MusicPairingBytes | null>;
  hmac: HmacFn;
  random: RandomFn;
  now(): number;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
  requestFrame(callback: () => void): number;
  cancelFrame(id: number): void;
  onStatus(status: MusicSignalStatus): void;
  createMotion?: () => MusicMotion;
}

export function musicSignalUrl(port: number): string {
  return `ws://${SIGNAL_HOST}:${port}${SIGNAL_PATH}`;
}

export function decodeMusicSecret(base64: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return null;
  }
  if (binary.length !== SIGNAL_SECRET_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export const browserMusicSocket: MusicSocketFactory = (url, handlers) => {
  const ws = new WebSocket(url);
  ws.onopen = () => handlers.open();
  ws.onmessage = (event) => handlers.message(event.data);
  ws.onclose = () => handlers.close();
  ws.onerror = () => {};
  return {
    send: (text) => ws.send(text),
    close: (code, reason) => {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close(code, reason);
    },
  };
};

interface Connection {
  generation: number;
  socket: MusicSocket | null;
  handshake: SignalClientHandshake | null;
  handshakeTimer: number | null;
}

export class MusicSignalController {
  private enabled = false;
  private revision = "";
  private environment: MusicEnvironment = {
    visible: false,
    suppressed: false,
    rest: false,
  };
  private generation = 0;
  private connection: Connection | null = null;
  private reconnectTimer: number | null = null;
  private backoffMs = MUSIC_RECONNECT_MIN_MS;
  private motion: MusicMotion | null = null;
  private frameId: number | null = null;
  private written = { hue: "", glow: "", attribute: false };
  private status: MusicSignalStatus = { kind: "off" };
  private disposed = false;

  constructor(private readonly deps: MusicSignalDeps) {}

  setEnabled(enabled: boolean, revision: string): void {
    if (this.disposed) return;
    const restart = enabled && this.enabled && revision !== this.revision;
    this.enabled = enabled;
    this.revision = revision;
    if (restart) this.disconnect(true);
    this.sync();
  }

  setEnvironment(environment: MusicEnvironment): void {
    if (this.disposed) return;
    this.environment = environment;
    this.sync();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disconnect(true);
    this.resetOutput();
    this.setStatus({ kind: "off" });
    this.disposed = true;
  }

  private get running(): boolean {
    return this.environment.visible && !this.environment.suppressed;
  }

  private sync(): void {
    if (!this.running) {
      this.disconnect(true);
      this.resetOutput();
      this.setStatus(this.enabled ? { kind: "paused" } : { kind: "off" });
      return;
    }
    if (this.enabled) {
      const motion = this.ensureMotion();
      motion.setActive(true);
      motion.setRest(this.environment.rest);
      if (this.connection === null && this.reconnectTimer === null) {
        this.connect();
      }
    } else {
      this.disconnect(true);
      this.setStatus({ kind: "off" });
      if (this.motion) {
        this.motion.setActive(false);
        this.motion.setRest(this.environment.rest);
      }
    }
    if (this.motion) this.ensureFrame();
  }

  private ensureMotion(): MusicMotion {
    this.motion ??= this.deps.createMotion?.() ?? new MusicMotion();
    return this.motion;
  }

  private setStatus(status: MusicSignalStatus): void {
    if (JSON.stringify(status) === JSON.stringify(this.status)) return;
    this.status = status;
    this.deps.onStatus(status);
  }

  private connect(): void {
    const generation = ++this.generation;
    const connection: Connection = {
      generation,
      socket: null,
      handshake: null,
      handshakeTimer: null,
    };
    this.connection = connection;
    this.setStatus({ kind: "connecting" });
    this.deps.loadPairing().then(
      (pairing) => {
        if (!this.isCurrent(connection)) return;
        if (pairing === null) {
          this.fail(connection, "music pairing secret is not set");
          return;
        }
        this.open(connection, pairing);
      },
      () => {
        if (this.isCurrent(connection)) {
          this.fail(connection, "music pairing could not be loaded");
        }
      },
    );
  }

  private isCurrent(connection: Connection): boolean {
    return (
      !this.disposed &&
      this.connection === connection &&
      connection.generation === this.generation
    );
  }

  private open(connection: Connection, pairing: MusicPairingBytes): void {
    const handshake = new SignalClientHandshake(
      pairing.secret,
      this.deps.origin,
      this.deps.hmac,
      this.deps.random,
    );
    connection.handshake = handshake;
    connection.handshakeTimer = this.deps.setTimer(() => {
      connection.handshakeTimer = null;
      if (this.isCurrent(connection) && !handshake.authed) {
        this.fail(connection, "handshake timed out", CLOSE_HANDSHAKE_TIMEOUT);
      }
    }, SIGNAL_HANDSHAKE_TIMEOUT_MS);
    connection.socket = this.deps.connect(musicSignalUrl(pairing.port), {
      open: () => {
        if (this.isCurrent(connection)) {
          connection.socket?.send(handshake.start());
        }
      },
      message: (data) => {
        if (this.isCurrent(connection)) this.receive(connection, data);
      },
      close: () => {
        if (this.isCurrent(connection)) {
          connection.socket = null;
          this.fail(connection, "connection closed");
        }
      },
    });
  }

  private receive(connection: Connection, data: unknown): void {
    const handshake = connection.handshake;
    if (handshake === null) return;
    void handshake.onMessage(data).then((action) => {
      if (!this.isCurrent(connection)) return;
      if (action.kind === "close") {
        this.fail(connection, action.reason);
        return;
      }
      if (action.kind === "send") {
        connection.socket?.send(action.text);
        this.clearHandshakeTimer(connection);
        this.backoffMs = MUSIC_RECONNECT_MIN_MS;
        this.setStatus({ kind: "connected" });
        return;
      }
      if (!this.motion) return;
      this.motion.receive(this.deps.now(), action.frame);
      this.ensureFrame();
    });
  }

  private clearHandshakeTimer(connection: Connection): void {
    if (connection.handshakeTimer !== null) {
      this.deps.clearTimer(connection.handshakeTimer);
      connection.handshakeTimer = null;
    }
  }

  private closeConnection(
    connection: Connection,
    code: number,
    reason: string,
  ) {
    this.clearHandshakeTimer(connection);
    const socket = connection.socket;
    connection.socket = null;
    socket?.close(code, reason);
  }

  private fail(
    connection: Connection,
    reason: string,
    code: number = MUSIC_CLOSE_NORMAL,
  ): void {
    this.closeConnection(connection, code, reason);
    this.connection = null;
    this.generation++;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(MUSIC_RECONNECT_MAX_MS, this.backoffMs * 2);
    this.setStatus({ kind: "retrying", reason, retryInMs: delay });
    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = null;
      if (!this.disposed && this.enabled && this.running) this.connect();
    }, delay);
  }

  private disconnect(resetBackoff: boolean): void {
    this.generation++;
    if (this.connection) {
      this.closeConnection(
        this.connection,
        MUSIC_CLOSE_NORMAL,
        "music mode stopped",
      );
      this.connection = null;
    }
    if (this.reconnectTimer !== null) {
      this.deps.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (resetBackoff) this.backoffMs = MUSIC_RECONNECT_MIN_MS;
  }

  private ensureFrame(): void {
    if (this.frameId !== null || this.disposed) return;
    this.frameId = this.deps.requestFrame(() => this.onFrame());
  }

  private ambientHue(): number {
    const raw = this.deps.root.style.getPropertyValue(
      MUSIC_AMBIENT_WAVE_PROPERTY,
    );
    const wave = Number.parseFloat(raw);
    return ambientHueFor(Number.isFinite(wave) ? wave : 0);
  }

  private onFrame(): void {
    this.frameId = null;
    const motion = this.motion;
    if (!motion) return;
    const out = motion.tick(this.deps.now(), this.ambientHue());
    if (out.settled) {
      this.clearOutput();
      if (!this.enabled) this.motion = null;
      return;
    }
    this.write(
      out.hue === null ? "" : String(Math.round(out.hue * 100) / 100),
      out.glow > 0 ? out.glow.toFixed(3) : "",
    );
    this.ensureFrame();
  }

  private write(hue: string, glow: string): void {
    const root = this.deps.root;
    if (!this.written.attribute) {
      root.setAttribute(MUSIC_ATTRIBUTE, "");
      this.written.attribute = true;
    }
    if (hue !== this.written.hue) {
      if (hue === "") root.style.removeProperty(MUSIC_HUE_PROPERTY);
      else root.style.setProperty(MUSIC_HUE_PROPERTY, hue);
      this.written.hue = hue;
    }
    if (glow !== this.written.glow) {
      if (glow === "") root.style.removeProperty(MUSIC_GLOW_PROPERTY);
      else root.style.setProperty(MUSIC_GLOW_PROPERTY, glow);
      this.written.glow = glow;
    }
  }

  private clearOutput(): void {
    const root = this.deps.root;
    root.style.removeProperty(MUSIC_HUE_PROPERTY);
    root.style.removeProperty(MUSIC_GLOW_PROPERTY);
    root.removeAttribute(MUSIC_ATTRIBUTE);
    if (root.getAttribute("style") === "") root.removeAttribute("style");
    this.written = { hue: "", glow: "", attribute: false };
  }

  private resetOutput(): void {
    if (this.frameId !== null) {
      this.deps.cancelFrame(this.frameId);
      this.frameId = null;
    }
    this.motion = null;
    if (this.written.attribute || this.written.hue || this.written.glow) {
      this.clearOutput();
    }
  }
}
