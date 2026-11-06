import { setTimeout as sleep } from "node:timers/promises";

import type { PageBudget, SourcePage } from "../adapters/jsonl-page.js";
import { admitMemory, type MemoryReservation } from "../admission.js";
import { FramedChild, type ChildExit } from "../ipc/framed-child.js";
import {
  SUPERVISED_MEMORY_POLICY,
  type MemorySupervisor,
  type WatchedChild,
} from "../ipc/memory-supervisor.js";
import {
  pageBindingViolation,
  parseParserResponse,
  type ParserErrorCode,
  type ParserResponse,
  type ParserSourceSpec,
} from "./protocol.js";

export const DEFAULT_PAGE_ACCOUNTED_BYTES = 2 * 1024 * 1024;

export type TerminationCause =
  | "crash"
  | "protocol_violation"
  | "memory_kill"
  | "stream_error"
  | "spawn_failed"
  | "external_kill";

export interface ParserReadInput {
  source: ParserSourceSpec;
  cursor: string | null;
  budget?: PageBudget;
  stallMs: number;
}

export type ParserOutcome =
  | { kind: "page"; page: SourcePage }
  | { kind: "error"; code: ParserErrorCode; message: string }
  | { kind: "refused"; message: string }
  | { kind: "stalled"; message: string }
  | { kind: "terminated"; cause: TerminationCause; message: string };

export interface ParserHandle {
  readonly label: string;
  read(input: ParserReadInput): Promise<ParserOutcome>;
  close(): Promise<void>;
}

export interface ParserSlotOptions {
  label: string;
  supervisor: MemorySupervisor;
  args: readonly string[];
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readyTimeoutMs?: number;
  admissionWaitMs?: number;
  admissionPollMs?: number;
  idleExitMs?: number;
  closeGraceMs?: number;
}

interface Incarnation {
  child: FramedChild;
  watched: WatchedChild;
  label: string;
  killedByUs: boolean;
  closing: boolean;
  exit: ChildExit | null;
  waiter: ((response: ParserResponse | null) => void) | null;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_ADMISSION_WAIT_MS = 1_000;
const DEFAULT_ADMISSION_POLL_MS = 25;
const DEFAULT_IDLE_EXIT_MS = 30_000;
const CLOSE_GRACE_MS = 1_000;

function timeout<T>(
  ms: number,
  value: T,
): { promise: Promise<T>; cancel(): void } {
  let handle: NodeJS.Timeout | undefined;
  const promise = new Promise<T>((resolve) => {
    handle = setTimeout(() => resolve(value), ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

export class ParserSlot implements ParserHandle {
  readonly label: string;

  private current: Incarnation | null = null;
  private generation = 0;
  private nextRequestId = 1;
  private idleTimer: NodeJS.Timeout | null = null;
  private retiring: Promise<void> | null = null;
  private busy = false;
  private closed = false;

  constructor(private readonly options: ParserSlotOptions) {
    this.label = options.label;
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private armIdle(): void {
    this.clearIdle();
    const idle = this.options.idleExitMs ?? DEFAULT_IDLE_EXIT_MS;
    if (idle <= 0 || this.closed) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.busy) void this.retire(true);
    }, idle);
    this.idleTimer.unref();
  }

  private retire(graceful: boolean): Promise<void> {
    const incarnation = this.current;
    this.current = null;
    const previous = this.retiring;
    if (incarnation === null) return previous ?? Promise.resolve();
    incarnation.closing = true;
    const ending = graceful
      ? incarnation.child.close(this.options.closeGraceMs ?? CLOSE_GRACE_MS)
      : incarnation.child.kill();
    const tracked: Promise<void> = Promise.all([
      previous,
      ending.catch(() => undefined),
    ]).then(() => {
      if (this.retiring === tracked) this.retiring = null;
    });
    this.retiring = tracked;
    return tracked;
  }

  private spawn(): Incarnation {
    this.generation += 1;
    const label = `${this.label}#${this.generation}`;
    const holder: { incarnation: Incarnation | null } = { incarnation: null };
    const child = new FramedChild({
      args: this.options.args,
      command: this.options.command,
      cwd: this.options.cwd,
      env: this.options.env,
      onFrame: (payload) => {
        const incarnation = holder.incarnation;
        if (incarnation === null) return;
        const response = parseParserResponse(payload);
        const waiter = incarnation.waiter;
        incarnation.waiter = null;
        if (response === null) {
          incarnation.killedByUs = true;
          void incarnation.child.kill();
          waiter?.(null);
          return;
        }
        waiter?.(response);
      },
      onViolation: () => {
        const incarnation = holder.incarnation;
        const waiter = incarnation?.waiter ?? null;
        if (incarnation !== null) incarnation.waiter = null;
        waiter?.(null);
      },
    });
    const watched = this.options.supervisor.watch(child, label);
    const incarnation: Incarnation = {
      child,
      watched,
      label,
      killedByUs: false,
      closing: false,
      exit: null,
      waiter: null,
    };
    holder.incarnation = incarnation;
    void child.exited.then((exit) => {
      incarnation.exit = exit;
      const waiter = incarnation.waiter;
      incarnation.waiter = null;
      waiter?.(null);
    });
    return incarnation;
  }

  private awaitResponse(
    incarnation: Incarnation,
  ): Promise<ParserResponse | null> {
    return new Promise((resolve) => {
      if (incarnation.exit !== null || !incarnation.child.alive) {
        resolve(null);
        return;
      }
      incarnation.waiter = resolve;
    });
  }

  private async terminated(
    incarnation: Incarnation,
    note?: string,
  ): Promise<ParserOutcome> {
    const exit = incarnation.exit ?? (await incarnation.child.exited);
    if (this.current === incarnation) this.current = null;
    const memoryKill = this.options.supervisor
      .kills()
      .some((record) => record.label === incarnation.label);
    let cause: TerminationCause;
    switch (exit.cause) {
      case "protocol_violation":
        cause = "protocol_violation";
        break;
      case "stream_error":
        cause = "stream_error";
        break;
      case "spawn_failed":
        cause = "spawn_failed";
        break;
      case "killed":
        cause = memoryKill
          ? "memory_kill"
          : incarnation.killedByUs
            ? "protocol_violation"
            : "external_kill";
        break;
      default:
        cause = "crash";
    }
    return {
      kind: "terminated",
      cause,
      message: `${cause}: code ${exit.code ?? "none"} signal ${exit.signal ?? "none"}${exit.detail ? ` (${exit.detail})` : ""}${note ? `: ${note}` : ""}`,
    };
  }

  private async ensureReady(): Promise<
    { incarnation: Incarnation } | { outcome: ParserOutcome }
  > {
    if (this.retiring !== null) await this.retiring;
    if (this.closed) {
      return { outcome: { kind: "refused", message: "parser slot is closed" } };
    }
    const existing = this.current;
    if (existing !== null && existing.child.alive && existing.exit === null) {
      return { incarnation: existing };
    }
    if (existing !== null) this.current = null;
    const incarnation = this.spawn();
    this.current = incarnation;
    const ready = timeout<"timeout">(
      this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      "timeout",
    );
    const response = await Promise.race([
      this.awaitResponse(incarnation),
      ready.promise,
    ]);
    ready.cancel();
    if (response === "timeout") {
      incarnation.killedByUs = true;
      incarnation.waiter = null;
      await incarnation.child.kill();
      this.current = null;
      return {
        outcome: { kind: "stalled", message: "parser did not become ready" },
      };
    }
    if (response === null || response.t !== "ready") {
      if (incarnation.exit === null && incarnation.child.alive) {
        incarnation.killedByUs = true;
        await incarnation.child.kill();
      }
      return { outcome: await this.terminated(incarnation) };
    }
    return { incarnation };
  }

  private async admit(
    incarnation: Incarnation,
    accountedBytes: number,
  ): Promise<MemoryReservation | string> {
    const deadline =
      incarnation.watched.provider.clock() +
      (this.options.admissionWaitMs ?? DEFAULT_ADMISSION_WAIT_MS);
    let message = "memory admission was not attempted";
    for (;;) {
      if (!incarnation.child.alive) return "parser exited before admission";
      this.options.supervisor.sampleNow();
      const admission = admitMemory(
        incarnation.watched.provider,
        SUPERVISED_MEMORY_POLICY,
        accountedBytes,
      );
      if (admission.ok) return admission.reservation;
      message = admission.message;
      if (incarnation.watched.provider.clock() >= deadline) return message;
      await sleep(this.options.admissionPollMs ?? DEFAULT_ADMISSION_POLL_MS);
    }
  }

  async read(input: ParserReadInput): Promise<ParserOutcome> {
    if (this.closed) {
      return { kind: "refused", message: "parser slot is closed" };
    }
    this.busy = true;
    this.clearIdle();
    try {
      const ready = await this.ensureReady();
      if ("outcome" in ready) return ready.outcome;
      const { incarnation } = ready;
      const accounted = input.budget?.maxBytes ?? DEFAULT_PAGE_ACCOUNTED_BYTES;
      const reservation = await this.admit(incarnation, accounted);
      if (typeof reservation === "string") {
        if (!incarnation.child.alive || incarnation.exit !== null) {
          return await this.terminated(incarnation);
        }
        return { kind: "refused", message: reservation };
      }
      try {
        const id = this.nextRequestId++;
        const pending = this.awaitResponse(incarnation);
        try {
          await incarnation.child.sendJson({
            v: 1,
            t: "read",
            id,
            source: input.source,
            cursor: input.cursor,
            budget: input.budget,
          });
        } catch {
          incarnation.waiter = null;
          if (incarnation.exit === null) {
            incarnation.killedByUs = true;
            await incarnation.child.kill();
          }
          return await this.terminated(incarnation);
        }
        const deadline = timeout<"stalled">(input.stallMs, "stalled");
        const response = await Promise.race([pending, deadline.promise]);
        deadline.cancel();
        if (response === "stalled") {
          incarnation.waiter = null;
          incarnation.killedByUs = true;
          await incarnation.child.kill();
          if (this.current === incarnation) this.current = null;
          return {
            kind: "stalled",
            message: `no response within ${input.stallMs} ms`,
          };
        }
        if (response === null) return await this.terminated(incarnation);
        if (response.t === "page" && response.id === id) {
          const violation = pageBindingViolation(
            response.page,
            input.source.ref,
            input.cursor,
          );
          if (violation === null) return { kind: "page", page: response.page };
          incarnation.killedByUs = true;
          await incarnation.child.kill();
          if (this.current === incarnation) this.current = null;
          return await this.terminated(incarnation, violation);
        }
        if (response.t === "error" && response.id === id) {
          return {
            kind: "error",
            code: response.code,
            message: response.message,
          };
        }
        incarnation.killedByUs = true;
        await incarnation.child.kill();
        return {
          kind: "terminated",
          cause: "protocol_violation",
          message: "unexpected response",
        };
      } finally {
        reservation.release();
      }
    } finally {
      this.busy = false;
      this.armIdle();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearIdle();
    await this.retire(true);
  }
}
