import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { CommitFence, CommitSink } from "../parser/scheduler.js";
import type {
  CommitBatch,
  CommitResult,
  CursorUpdate,
  FenceEntry,
  RefusalCode,
  SourceRef,
} from "../storage.js";
import type { WriterRequestBody, WriterStoreState } from "./protocol.js";
import {
  WriterClient,
  type WriterClientOptions,
  type WriterOutcome,
  type WriterTerminationCause,
} from "./writer-process.js";

export type ReconciliationOutcome = "committed" | "rolled_back" | "unknown";

export interface ReconciliationRecord {
  key: string;
  cause: WriterTerminationCause;
  outcome: ReconciliationOutcome;
  pressureRecorded: boolean;
}

export interface WriterSinkOptions
  extends Omit<WriterClientOptions, "initialize"> {
  cursorWaitMs?: number;
  cursorRetryMs?: number;
}

const DEFAULT_CURSOR_WAIT_MS = 5_000;
const DEFAULT_CURSOR_RETRY_MS = 50;

export class WriterSink implements CommitSink {
  readonly client: WriterClient;

  private readonly fences = new Map<string, FenceEntry>();
  private readonly records: ReconciliationRecord[] = [];
  private lastEpoch = 0;

  constructor(private readonly options: WriterSinkOptions) {
    this.client = new WriterClient({
      ...options,
      initialize: () => ({ t: "sync", fences: [...this.fences.values()] }),
    });
  }

  reconciliations(): readonly ReconciliationRecord[] {
    return this.records;
  }

  adopt(ref: SourceRef): string {
    const entry: FenceEntry = {
      key: ref.key,
      generation: ref.generation,
      token: randomUUID(),
    };
    this.fences.set(ref.key, entry);
    void this.client.request({ t: "fence", entry });
    return entry.token;
  }

  retire(key: string): void {
    this.fences.delete(key);
    void this.client.request({ t: "unfence", key });
  }

  async cursor(ref: SourceRef): Promise<string | null> {
    const deadline = Date.now() + (this.options.cursorWaitMs ?? DEFAULT_CURSOR_WAIT_MS);
    for (;;) {
      const outcome = await this.client.request({ t: "cursor", source: ref });
      if (outcome.kind === "response" && outcome.response.t === "cursor") {
        return outcome.response.cursor;
      }
      if (Date.now() >= deadline) {
        throw new Error(`writer unavailable: ${describe(outcome)}`);
      }
      await sleep(this.options.cursorRetryMs ?? DEFAULT_CURSOR_RETRY_MS);
    }
  }

  async commit(
    batch: CommitBatch,
    update: CursorUpdate,
    fence: CommitFence,
    fenceToken?: string | null,
  ): Promise<CommitResult> {
    if (!fence()) {
      return this.refusal(
        "stale_generation",
        "source generation is no longer current",
      );
    }
    const outcome = await this.client.request({
      t: "commit",
      batch,
      cursor: update,
      token: fenceToken ?? null,
    });
    if (outcome.kind === "response" && outcome.response.t === "commit") {
      this.lastEpoch = outcome.response.result.epoch;
      return outcome.response.result;
    }
    if (outcome.kind === "terminated") {
      return await this.reconcile(batch, update, outcome.cause);
    }
    return this.refusal(
      "suspended",
      `writer unavailable: ${describe(outcome)}`,
    );
  }

  private async reconcile(
    batch: CommitBatch,
    update: CursorUpdate,
    cause: WriterTerminationCause,
  ): Promise<CommitResult> {
    const read = await this.client.request({
      t: "cursor",
      source: batch.source,
    });
    const stored =
      read.kind === "response" && read.response.t === "cursor"
        ? read.response.cursor
        : undefined;
    const memory = cause === "memory_kill";
    let pressureRecorded = false;
    if (memory) {
      const recorded = await this.client.request({
        t: "pressure",
        source: batch.source,
        mergePossible: true,
      });
      pressureRecorded =
        recorded.kind === "response" && recorded.response.t === "pressure";
    }
    const outcome: ReconciliationOutcome =
      stored === undefined
        ? "unknown"
        : stored === update.next
          ? "committed"
          : stored === update.expected
            ? "rolled_back"
            : "unknown";
    this.records.push({
      key: batch.source.key,
      cause,
      outcome,
      pressureRecorded,
    });
    if (stored === undefined) {
      return this.refusal(
        "suspended",
        `writer unavailable after ${cause}: ${describe(read)}`,
      );
    }
    if (outcome === "committed") {
      return this.refusal(
        "cursor_conflict",
        "the commit was durable before the writer terminated; no replay",
      );
    }
    if (outcome === "rolled_back" && memory) {
      return this.refusal(
        "memory_pressure",
        "the writer was stopped for memory; the commit was rolled back",
        true,
      );
    }
    return this.refusal(
      "cursor_conflict",
      outcome === "rolled_back"
        ? `the writer terminated (${cause}) before the commit; replay`
        : `the writer terminated (${cause}); the stored cursor moved`,
    );
  }

  private refusal(
    code: RefusalCode,
    message: string,
    mergePossible = false,
  ): CommitResult {
    return {
      committed: false,
      refusal: { code, message },
      cursor: null,
      epoch: this.lastEpoch,
      inserted: 0,
      replayed: 0,
      updated: 0,
      corrected: 0,
      quarantined: 0,
      unindexed: 0,
      estimatedDirtyPages: 0,
      mergePossible,
      entries: [],
    };
  }

  private async call(body: WriterRequestBody): Promise<WriterOutcome> {
    return await this.client.request(body);
  }

  async removeSource(key: string, chunkRows?: number): Promise<number> {
    const outcome = await this.call({
      t: "remove",
      key,
      ...(chunkRows === undefined ? {} : { chunkRows }),
    });
    if (outcome.kind === "response" && outcome.response.t === "removed") {
      return outcome.response.rows;
    }
    throw new Error(`writer unavailable: ${describe(outcome)}`);
  }

  async state(): Promise<WriterStoreState> {
    const outcome = await this.call({ t: "state" });
    if (outcome.kind === "response" && outcome.response.t === "state") {
      return outcome.response.state;
    }
    throw new Error(`writer unavailable: ${describe(outcome)}`);
  }

  async beginControlledRetry(
    mitigation: string,
  ): Promise<{ ok: boolean; reason: string | null }> {
    const outcome = await this.call({ t: "retry", mitigation });
    if (outcome.kind === "response" && outcome.response.t === "retry") {
      return { ok: outcome.response.ok, reason: outcome.response.reason };
    }
    return { ok: false, reason: `writer unavailable: ${describe(outcome)}` };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function describe(outcome: WriterOutcome): string {
  switch (outcome.kind) {
    case "response":
      return `unexpected ${outcome.response.t} response`;
    case "error":
      return outcome.message;
    case "terminated":
    case "refused":
      return outcome.message;
  }
}
