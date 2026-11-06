import { FramedChild, type ChildExit } from "../ipc/framed-child.js";
import type {
  MemorySupervisor,
  WatchedChild,
} from "../ipc/memory-supervisor.js";
import type { TerminationCause } from "../parser/parser-process.js";
import type { SourceRef } from "../storage.js";
import {
  parseWriterResponse,
  type WriterRequestBody,
  type WriterResponse,
} from "./protocol.js";

export type WriterTerminationCause = TerminationCause | "stalled";

export type WriterOutcome =
  | { kind: "response"; response: WriterResponse }
  | { kind: "error"; message: string }
  | { kind: "terminated"; cause: WriterTerminationCause; message: string }
  | { kind: "refused"; message: string };

export interface WriterClientOptions {
  label: string;
  supervisor: MemorySupervisor;
  args: readonly string[];
  command?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  initialize?: () => WriterRequestBody | null;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeGraceMs?: number;
  maxConsecutiveFailures?: number;
  cooldownMs?: number;
  clock?: () => number;
}

interface Incarnation {
  child: FramedChild;
  watched: WatchedChild;
  label: string;
  killedByUs: boolean;
  accounted: boolean;
  exit: ChildExit | null;
  waiter: ((response: WriterResponse | null) => void) | null;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;
const DEFAULT_COOLDOWN_MS = 1_000;

const STORE_SOURCE: SourceRef = {
  key: "writer:store",
  generation: 0,
  discoveredAtMs: 0,
};

function sourceOf(body: WriterRequestBody): SourceRef | null {
  switch (body.t) {
    case "commit":
      return body.batch.source;
    case "cursor":
    case "pressure":
      return body.source;
    default:
      return null;
  }
}

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

export class WriterClient {
  readonly label: string;

  private current: Incarnation | null = null;
  private spawns = 0;
  private nextRequestId = 1;
  private chain: Promise<unknown> = Promise.resolve();
  private consecutiveFailures = 0;
  private blockedUntilMs = 0;
  private closed = false;
  private activeSource: SourceRef | null = null;
  private readonly owed: Array<SourceRef | null> = [];

  constructor(private readonly options: WriterClientOptions) {
    this.label = options.label;
  }

  get pid(): number | null {
    return this.current?.child.pid ?? null;
  }

  get pressureOwed(): boolean {
    return this.owed.length > 0;
  }

  get incarnations(): number {
    return this.spawns;
  }

  private now(): number {
    return (this.options.clock ?? Date.now)();
  }

  private spawn(): Incarnation {
    this.spawns += 1;
    const label = `${this.label}#${this.spawns}`;
    const holder: { incarnation: Incarnation | null } = { incarnation: null };
    const settle = (response: WriterResponse | null): void => {
      const incarnation = holder.incarnation;
      if (incarnation === null) return;
      const waiter = incarnation.waiter;
      incarnation.waiter = null;
      waiter?.(response);
    };
    const child = new FramedChild({
      args: this.options.args,
      command: this.options.command,
      cwd: this.options.cwd,
      env: this.options.env,
      onFrame: (payload) => {
        const incarnation = holder.incarnation;
        if (incarnation === null) return;
        const response = parseWriterResponse(payload);
        if (response === null) {
          incarnation.killedByUs = true;
          void incarnation.child.kill();
        }
        settle(response);
      },
      onViolation: () => settle(null),
    });
    const watched = this.options.supervisor.watch(child, label);
    const incarnation: Incarnation = {
      child,
      watched,
      label,
      killedByUs: false,
      accounted: false,
      exit: null,
      waiter: null,
    };
    holder.incarnation = incarnation;
    void child.exited.then((exit) => {
      incarnation.exit = exit;
      settle(null);
    });
    return incarnation;
  }

  private awaitResponse(
    incarnation: Incarnation,
  ): Promise<WriterResponse | null> {
    return new Promise((resolve) => {
      if (incarnation.exit !== null || !incarnation.child.alive) {
        resolve(null);
        return;
      }
      incarnation.waiter = resolve;
    });
  }

  private recordMemoryKill(
    incarnation: Incarnation,
    source: SourceRef | null,
  ): boolean {
    const killed = this.options.supervisor
      .kills()
      .some((record) => record.label === incarnation.label);
    if (killed && !incarnation.accounted) {
      incarnation.accounted = true;
      this.owed.push(source);
    }
    return killed;
  }

  private async payPressure(
    incarnation: Incarnation,
  ): Promise<WriterOutcome | null> {
    while (this.owed.length > 0) {
      const result = await this.exchange(
        incarnation,
        {
          t: "pressure",
          source: this.owed[0] ?? STORE_SOURCE,
          mergePossible: true,
        },
        this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if ("kind" in result) return result;
      if (result.t !== "pressure") {
        incarnation.killedByUs = true;
        await incarnation.child.kill();
        return await this.terminated(incarnation, false);
      }
      this.owed.shift();
    }
    return null;
  }

  private async terminated(
    incarnation: Incarnation,
    stalled: boolean,
  ): Promise<WriterOutcome> {
    const exit = incarnation.exit ?? (await incarnation.child.exited);
    if (this.current === incarnation) this.current = null;
    const memoryKill = this.recordMemoryKill(incarnation, this.activeSource);
    let cause: WriterTerminationCause;
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
          : stalled
            ? "stalled"
            : incarnation.killedByUs
              ? "protocol_violation"
              : "external_kill";
        break;
      default:
        cause = "crash";
    }
    this.consecutiveFailures += 1;
    if (
      this.consecutiveFailures >=
      (this.options.maxConsecutiveFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES)
    ) {
      this.blockedUntilMs =
        this.now() + (this.options.cooldownMs ?? DEFAULT_COOLDOWN_MS);
      this.consecutiveFailures = 0;
    }
    return {
      kind: "terminated",
      cause,
      message: `${cause}: code ${exit.code ?? "none"} signal ${exit.signal ?? "none"}${exit.detail ? ` (${exit.detail})` : ""}`,
    };
  }

  private async exchange(
    incarnation: Incarnation,
    body: WriterRequestBody,
    limitMs: number,
  ): Promise<WriterResponse | WriterOutcome> {
    const id = this.nextRequestId++;
    const pending = this.awaitResponse(incarnation);
    try {
      await incarnation.child.sendJson({ ...body, id });
    } catch {
      incarnation.waiter = null;
      if (incarnation.exit === null) {
        incarnation.killedByUs = true;
        await incarnation.child.kill();
      }
      return await this.terminated(incarnation, false);
    }
    const deadline = timeout<"stalled">(limitMs, "stalled");
    const response = await Promise.race([pending, deadline.promise]);
    deadline.cancel();
    if (response === "stalled") {
      incarnation.waiter = null;
      await incarnation.child.kill();
      return await this.terminated(incarnation, true);
    }
    if (response === null) return await this.terminated(incarnation, false);
    if (response.t === "ready" || !("id" in response) || response.id !== id) {
      incarnation.killedByUs = true;
      await incarnation.child.kill();
      return await this.terminated(incarnation, false);
    }
    return response;
  }

  private async ensureReady(): Promise<
    { incarnation: Incarnation } | { outcome: WriterOutcome }
  > {
    if (this.closed) {
      return { outcome: { kind: "refused", message: "writer is closed" } };
    }
    const existing = this.current;
    if (existing !== null && existing.child.alive && existing.exit === null) {
      return { incarnation: existing };
    }
    if (existing !== null) {
      await existing.child.exited;
      this.recordMemoryKill(existing, null);
    }
    this.current = null;
    if (this.now() < this.blockedUntilMs) {
      return {
        outcome: {
          kind: "refused",
          message: "writer restarts are cooling down after repeated failures",
        },
      };
    }
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
      incarnation.waiter = null;
      await incarnation.child.kill();
      return { outcome: await this.terminated(incarnation, true) };
    }
    if (response === null || response.t !== "ready") {
      if (incarnation.exit === null && incarnation.child.alive) {
        incarnation.killedByUs = true;
        await incarnation.child.kill();
      }
      return { outcome: await this.terminated(incarnation, false) };
    }
    const initial = this.options.initialize?.() ?? null;
    if (initial !== null) {
      const result = await this.exchange(
        incarnation,
        initial,
        this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if ("kind" in result) return { outcome: result };
      if (result.t !== "done") {
        incarnation.killedByUs = true;
        await incarnation.child.kill();
        return { outcome: await this.terminated(incarnation, false) };
      }
    }
    const unpaid = await this.payPressure(incarnation);
    if (unpaid !== null) return { outcome: unpaid };
    return { incarnation };
  }

  private async run(body: WriterRequestBody): Promise<WriterOutcome> {
    this.activeSource = sourceOf(body);
    try {
      return await this.runActive(body);
    } finally {
      this.activeSource = null;
    }
  }

  private async runActive(body: WriterRequestBody): Promise<WriterOutcome> {
    const ready = await this.ensureReady();
    if ("outcome" in ready) return ready.outcome;
    const result = await this.exchange(
      ready.incarnation,
      body,
      this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
    if ("kind" in result) return result;
    this.consecutiveFailures = 0;
    if (result.t === "error") return { kind: "error", message: result.message };
    return { kind: "response", response: result };
  }

  request(body: WriterRequestBody): Promise<WriterOutcome> {
    const outcome = this.chain.then(() => this.run(body));
    this.chain = outcome.then(
      () => undefined,
      () => undefined,
    );
    return outcome;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.chain.catch(() => undefined);
    const incarnation = this.current;
    this.current = null;
    if (incarnation === null) return;
    await incarnation.child
      .close(this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS)
      .catch(() => undefined);
  }
}
