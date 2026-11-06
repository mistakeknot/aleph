import { spawn, type ChildProcess } from "node:child_process";
import { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

import {
  encodeFrame,
  encodeJsonFrame,
  FrameDecoder,
  type FrameViolation,
} from "./frame.js";

export const CHILD_INPUT_FD = 3;
export const CHILD_OUTPUT_FD = 4;
export const DEFAULT_CLOSE_GRACE_MS = 2000;

export type ChildExitCause =
  | "exited"
  | "killed"
  | "protocol_violation"
  | "stream_error"
  | "spawn_failed";

export interface ChildExit {
  cause: ChildExitCause;
  code: number | null;
  signal: NodeJS.Signals | null;
  violation: FrameViolation | null;
  killRequestedAtMs: number | null;
  reapLatencyMs: number | null;
  detail: string | null;
}

export interface FramedChildStats {
  bufferedBytes: number;
  peakBufferedBytes: number;
  largestChunkBytes: number;
  bytesReceived: number;
  framesReceived: number;
  pendingSendBytes: number;
}

export interface FramedChildOptions {
  args: readonly string[];
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stderr?: "ignore" | "inherit";
  onFrame: (payload: Buffer) => void;
  onViolation?: (violation: FrameViolation) => void;
  now?: () => number;
}

export interface KillResult {
  alreadyExited: boolean;
  reapLatencyMs: number;
}

export class SendInFlightError extends Error {
  constructor() {
    super("a send is already in flight");
    this.name = "SendInFlightError";
  }
}

function monotonicNow(): number {
  return Number(process.hrtime.bigint() / 1000n) / 1000;
}

export class FramedChild {
  readonly exited: Promise<ChildExit>;

  private readonly process: ChildProcess;
  private readonly decoder = new FrameDecoder();
  private readonly now: () => number;
  private readonly input: Writable | null;
  private readonly output: Readable | null;
  private killRequestedAtMs: number | null = null;
  private exitedAtMs: number | null = null;
  private cause: ChildExitCause = "exited";
  private violation: FrameViolation | null = null;
  private detail: string | null = null;
  private settled = false;
  private pendingSendBytes = 0;
  private sendInFlight = false;
  private resolveExit!: (exit: ChildExit) => void;
  private readonly reaped: Promise<void>;
  private resolveReaped!: () => void;

  constructor(private readonly options: FramedChildOptions) {
    this.now = options.now ?? monotonicNow;
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    this.reaped = new Promise((resolve) => {
      this.resolveReaped = resolve;
    });
    const child = spawn(
      options.command ?? process.execPath,
      [...options.args],
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["ignore", "ignore", options.stderr ?? "ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    this.process = child;
    this.input = (child.stdio[CHILD_INPUT_FD] as Writable | null) ?? null;
    this.output = (child.stdio[CHILD_OUTPUT_FD] as Readable | null) ?? null;
    child.once("error", (error) => {
      this.cause = "spawn_failed";
      this.detail = error.message;
      this.exitedAtMs = this.now();
      this.resolveReaped();
      this.finish(null, null);
    });
    child.once("exit", (code, signal) => {
      this.exitedAtMs = this.now();
      this.resolveReaped();
      this.noteExit(code, signal);
    });
    child.once("close", (code, signal) => {
      this.finalize(code, signal);
    });
    this.input?.on("error", () => {});
    this.output?.on("error", (error) => {
      this.fault("stream_error", error.message);
    });
    this.output?.on("data", (chunk: Buffer) => {
      this.receive(chunk);
    });
    this.output?.on("end", () => {
      this.endOfOutput();
    });
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  get alive(): boolean {
    return this.exitedAtMs === null && this.process.pid !== undefined;
  }

  stats(): FramedChildStats {
    return {
      bufferedBytes: this.decoder.bufferedBytes,
      peakBufferedBytes: this.decoder.peakBufferedBytes,
      largestChunkBytes: this.decoder.largestChunkBytes,
      bytesReceived: this.decoder.bytesReceived,
      framesReceived: this.decoder.framesDecoded,
      pendingSendBytes: this.pendingSendBytes,
    };
  }

  send(payload: Uint8Array): Promise<void> {
    if (this.sendInFlight) return Promise.reject(new SendInFlightError());
    return this.write(encodeFrame(payload));
  }

  sendJson(value: unknown): Promise<void> {
    if (this.sendInFlight) return Promise.reject(new SendInFlightError());
    return this.write(encodeJsonFrame(value));
  }

  async kill(): Promise<KillResult> {
    if (this.exitedAtMs !== null) {
      return { alreadyExited: true, reapLatencyMs: 0 };
    }
    this.requestKill();
    await this.reaped;
    const requested = this.killRequestedAtMs ?? this.now();
    return {
      alreadyExited: false,
      reapLatencyMs: Math.max(0, (this.exitedAtMs ?? this.now()) - requested),
    };
  }

  async close(graceMs: number = DEFAULT_CLOSE_GRACE_MS): Promise<ChildExit> {
    if (this.exitedAtMs === null) {
      this.input?.end();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), graceMs);
      });
      const winner = await Promise.race([
        this.exited.then(() => false),
        timedOut,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (winner) await this.kill();
    }
    return this.exited;
  }

  private write(frame: Buffer): Promise<void> {
    const input = this.input;
    if (input === null || this.exitedAtMs !== null || input.destroyed) {
      return Promise.reject(new Error("child channel is closed"));
    }
    this.sendInFlight = true;
    this.pendingSendBytes = frame.byteLength;
    return new Promise((resolve, reject) => {
      input.write(frame, (error) => {
        this.sendInFlight = false;
        this.pendingSendBytes = 0;
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private receive(chunk: Buffer): void {
    if (this.violation !== null || this.killRequestedAtMs !== null) return;
    for (const event of this.decoder.push(chunk)) {
      if (event.kind === "violation") {
        this.violate(event.violation);
        return;
      }
      this.options.onFrame(event.payload);
    }
  }

  private endOfOutput(): void {
    if (this.violation !== null || this.killRequestedAtMs !== null) return;
    const trailing = this.decoder.end();
    if (trailing === null) return;
    this.violate(trailing);
  }

  private violate(violation: FrameViolation): void {
    this.violation = violation;
    this.cause = "protocol_violation";
    this.output?.pause();
    this.output?.destroy();
    this.options.onViolation?.(violation);
    this.requestKill();
  }

  private fault(cause: ChildExitCause, detail: string): void {
    if (this.violation !== null || this.killRequestedAtMs !== null) return;
    this.cause = cause;
    this.detail = detail;
    this.requestKill();
  }

  private requestKill(): void {
    if (this.killRequestedAtMs !== null || this.exitedAtMs !== null) return;
    this.killRequestedAtMs = this.now();
    if (this.cause === "exited") this.cause = "killed";
    this.process.kill("SIGKILL");
  }

  private noteExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.output === null || this.output.destroyed) {
      this.finalize(code, signal);
    }
  }

  private finalize(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.violation === null && this.killRequestedAtMs === null) {
      const trailing = this.decoder.end();
      if (trailing !== null) {
        this.violation = trailing;
        this.cause = "protocol_violation";
        this.options.onViolation?.(trailing);
      }
    }
    this.finish(code, signal);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.settled) return;
    this.settled = true;
    this.input?.destroy();
    this.output?.destroy();
    const reapLatencyMs =
      this.killRequestedAtMs !== null && this.exitedAtMs !== null
        ? Math.max(0, this.exitedAtMs - this.killRequestedAtMs)
        : null;
    this.resolveExit({
      cause: this.cause,
      code,
      signal,
      violation: this.violation,
      killRequestedAtMs: this.killRequestedAtMs,
      reapLatencyMs,
      detail: this.detail,
    });
  }
}

export function spawnFramedChild(options: FramedChildOptions): FramedChild {
  return new FramedChild(options);
}

export interface ParentChannel {
  input: Readable;
  output: Writable;
}

export function openParentChannel(): ParentChannel {
  return {
    input: new Socket({ fd: CHILD_INPUT_FD, readable: true, writable: false }),
    output: new Socket({
      fd: CHILD_OUTPUT_FD,
      readable: false,
      writable: true,
    }),
  };
}
