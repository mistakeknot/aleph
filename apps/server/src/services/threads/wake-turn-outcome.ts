import {
  events as eventTable,
  type AppendStoredThreadEventArgs,
  type DbQueryConnection,
  type StoredEventRow,
} from "@bb/db";
import { turnScope, type ThreadEvent, type ThreadEventItem } from "@bb/domain";
import {
  wakeEffectKindSchema,
  type WakeTurnOutcome,
  type WakeOutcomesResponse,
} from "@bb/server-contract";
import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  lt,
  min,
  notExists,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { parseStoredEvent } from "./thread-data.js";
import { appendThreadEventInTransaction } from "./thread-events.js";

type Deps = Pick<AppDeps, "db" | "hub">;
type EffectKind = WakeTurnOutcome["effectKinds"][number];

export class InvalidWakeOutcomeCursorError extends Error {
  constructor() {
    super("Invalid wake outcome cursor");
  }
}

const cursorSchema = z
  .object({
    version: z.literal(1),
    threadId: z.string().min(1),
    sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

function decodeCursor(
  cursor: string | undefined,
  threadId: string,
): number | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
      throw new InvalidWakeOutcomeCursorError();
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor)
      throw new InvalidWakeOutcomeCursorError();
    const value = cursorSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (value.threadId !== threadId) throw new InvalidWakeOutcomeCursorError();
    return value.sequence;
  } catch {
    throw new InvalidWakeOutcomeCursorError();
  }
}

function diffHasChange(diff: string): boolean {
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) inHunk = false;
    if (line.startsWith("@@")) inHunk = true;
    if (!/^[+-]/.test(line)) continue;
    if (!inHunk && /^(---|\+\+\+)/.test(line)) continue;
    return true;
  }
  return false;
}

const toolTypes = new Set<ThreadEventItem["type"]>([
  "commandExecution",
  "fileChange",
  "fileRead",
  "search",
  "webSearch",
  "webFetch",
  "imageView",
  "imageGeneration",
  "toolCall",
]);
const readTypes = new Set<ThreadEventItem["type"]>([
  "fileRead",
  "search",
  "webSearch",
  "webFetch",
  "imageView",
]);

export function reduceWakeTurnOutcome({
  threadId,
  turnId,
  events,
  telemetry,
}: {
  threadId: string;
  turnId: string;
  events: readonly ThreadEvent[];
  telemetry: "complete" | "unknown";
}): WakeTurnOutcome {
  const all = events.filter((event) => event.threadId === threadId);
  const turn = all.filter(
    (event) => event.scope.kind === "turn" && event.scope.turnId === turnId,
  );
  const completed = turn.some(
    (event) => event.type === "turn/completed" && event.status === "completed",
  );
  const tools = new Map<
    string,
    { item: ThreadEventItem; terminal: boolean; first: number }
  >();
  const effects = new Set<EffectKind>();
  let partial = false;
  for (const [index, event] of all.entries()) {
    if (event.scope.kind !== "turn" || event.scope.turnId !== turnId) continue;
    if (
      event.type === "system/operation" &&
      event.operation === "wake.effect.v1" &&
      event.status === "completed" &&
      event.metadata?.changed === true
    ) {
      const kind = wakeEffectKindSchema.safeParse(event.metadata.effectKind);
      if (kind.success) effects.add(kind.data);
    }
    if (event.type !== "item/started" && event.type !== "item/completed")
      continue;
    if (
      !event.item.parentToolCallId &&
      ["backgroundTask", "delegation", "extension"].includes(event.item.type)
    )
      partial = true;
    if (event.item.parentToolCallId || !toolTypes.has(event.item.type))
      continue;
    const previous = tools.get(event.item.id);
    if (previous?.terminal && event.type === "item/started") continue;
    tools.set(event.item.id, {
      item: event.item,
      terminal: event.type === "item/completed",
      first: previous?.first ?? index,
    });
  }
  for (const { item, terminal } of tools.values()) {
    if (
      !terminal ||
      !("status" in item) ||
      item.status === "pending" ||
      item.status === "interrupted"
    ) {
      partial = true;
      continue;
    }
    if (item.type === "fileChange") {
      if (item.status !== "completed") continue;
      if (
        item.changes.some(
          (change) => change.diff !== undefined && diffHasChange(change.diff),
        )
      )
        effects.add("file");
      if (item.changes.some((change) => change.diff === undefined))
        partial = true;
    } else if (!readTypes.has(item.type)) partial = true;
  }
  const completeTools =
    completed &&
    telemetry === "complete" &&
    !turn.some((event) => event.type === "provider/unhandled");
  const requestsById = new Map(
    all.flatMap((event) =>
      event.type === "client/turn/requested"
        ? [[event.requestId, event] as const]
        : [],
    ),
  );
  const firstTurns = new Map<string, string>();
  const accepted = new Map<string, number>();
  for (const [index, event] of all.entries()) {
    if (event.type !== "turn/input/accepted" || event.scope.kind !== "turn")
      continue;
    if (!firstTurns.has(event.clientRequestId))
      firstTurns.set(event.clientRequestId, event.scope.turnId);
    if (event.scope.turnId === turnId && !accepted.has(event.clientRequestId))
      accepted.set(event.clientRequestId, index);
  }
  const sources: WakeTurnOutcome["wakeSources"] = [];
  let sourcesTruncated = false;
  const requests: WakeTurnOutcome["requests"] = [];
  for (const [requestId, index] of accepted) {
    const request = requestsById.get(requestId);
    const wake = {
      wakeCause: request?.wakeCause ?? "unknown",
      wakeRef: request?.wakeRef ?? null,
    } as const;
    const incoming = request?.wakeSources?.length
      ? request.wakeSources
      : [wake];
    sourcesTruncated ||=
      request?.wakeSourcesTruncated === true ||
      sources.length + incoming.length > 32;
    sources.push(...incoming.slice(0, Math.max(0, 32 - sources.length)));
    if (requests.length === 32) continue;
    requests.push({
      requestId,
      ...wake,
      postAcceptToolCount: completeTools
        ? [...tools.values()].filter((tool) => tool.first > index).length
        : null,
      partialObservationWindow:
        requests.length > 0 ||
        all
          .slice(0, index)
          .some(
            (event) =>
              event.scope.kind === "turn" &&
              event.scope.turnId === turnId &&
              (event.type === "item/started" ||
                event.type === "item/completed") &&
              !event.item.parentToolCallId,
          ) ||
        request?.target.kind === "steer" ||
        (request?.target.kind === "auto" &&
          request.target.expectedTurnId === turnId),
      firstAcceptingTurnId: firstTurns.get(requestId)!,
      retryOfRequestId: request?.retryOfRequestId ?? null,
      retryAttempt: request?.retryAttempt ?? null,
      retainedCause: request?.retainedCause ?? null,
    });
  }
  const requestsTruncated = accepted.size > 32;
  const knownAttribution =
    sources.length > 0 &&
    !sourcesTruncated &&
    !requestsTruncated &&
    sources.every((source) => source.wakeCause !== "unknown");
  return {
    turnId,
    completed,
    wakeCause:
      knownAttribution &&
      new Set(sources.map((source) => source.wakeCause)).size === 1
        ? sources[0]!.wakeCause
        : "unknown",
    wakeRef: requests[0]?.wakeRef ?? null,
    wakeSources: sources,
    wakeSourcesTruncated: sourcesTruncated,
    requestsTruncated,
    requests,
    toolCount: completeTools ? tools.size : null,
    changedAnything: effects.size
      ? true
      : !completeTools || partial
        ? "unknown"
        : false,
    effectKinds: [...effects].sort(),
    coverage: {
      tools: completeTools ? "complete" : "unknown",
      effects: !completeTools ? "unknown" : partial ? "partial" : "complete",
      attribution: knownAttribution ? "complete" : "unknown",
    },
  };
}

function hasOperation(
  db: DbQueryConnection,
  threadId: string,
  turnId: string,
  operation: string,
  operationId: string,
) {
  return (
    db
      .select({ id: eventTable.id })
      .from(eventTable)
      .where(
        and(
          eq(eventTable.threadId, threadId),
          eq(eventTable.turnId, turnId),
          eq(eventTable.type, "system/operation"),
          sql`CASE WHEN json_valid(${eventTable.data}) THEN json_extract(${eventTable.data}, '$.operation') END = ${operation}`,
          sql`CASE WHEN json_valid(${eventTable.data}) THEN json_extract(${eventTable.data}, '$.operationId') END = ${operationId}`,
        ),
      )
      .get() !== undefined
  );
}

function appendOperationOnce(
  deps: Deps,
  turnId: string,
  args: AppendStoredThreadEventArgs<"system/operation">,
): void {
  const sequence = deps.db.transaction(
    (tx) => {
      if (
        hasOperation(
          tx,
          args.threadId,
          turnId,
          args.data.operation,
          args.data.operationId,
        )
      )
        return null;
      return appendThreadEventInTransaction(tx, args);
    },
    { behavior: "immediate" },
  );
  if (sequence !== null)
    deps.hub.notifyThread(args.threadId, ["events-appended"], {
      timelineSequence: sequence,
    });
}

export function recordAcknowledgedWakeEffect(
  deps: Deps,
  input: {
    caller: { threadId: string; turnId: string } | null;
    operationId: string;
    effectKind: EffectKind;
    acknowledged: boolean;
    changed: boolean;
  },
): void {
  if (!input.caller || !input.acknowledged || !input.changed) return;
  const { threadId, turnId } = input.caller;
  appendOperationOnce(deps, turnId, {
    threadId,
    scope: turnScope(turnId),
    type: "system/operation",
    data: {
      operation: "wake.effect.v1",
      operationId: input.operationId,
      status: "completed",
      message: "Effect acknowledged",
      metadata: { effectKind: input.effectKind, changed: true },
    },
  });
}

export function readWakeOutcomes(
  deps: Deps,
  input: { threadId: string; snapshotTurnId?: string; cursor?: string },
): WakeOutcomesResponse {
  return collectWakeOutcomes(deps, input, false);
}

export function recordSettledWakeOutcome(
  deps: Deps,
  input: { threadId: string; snapshotTurnId: string },
): void {
  collectWakeOutcomes(deps, input, true);
}

function collectWakeOutcomes(
  deps: Deps,
  {
    threadId,
    snapshotTurnId,
    cursor,
  }: {
    threadId: string;
    snapshotTurnId?: string;
    cursor?: string;
  },
  settlement: boolean,
): WakeOutcomesResponse {
  const beforeSequence = decodeCursor(cursor, threadId);
  const types = [
    "turn/started",
    "turn/completed",
    "turn/input/accepted",
    "item/started",
    "item/completed",
    "system/operation",
    "provider/unhandled",
  ] as const;
  const starts = alias(eventTable, "wake_turn_starts");
  const earlier = alias(eventTable, "wake_turn_earlier");
  const candidates =
    snapshotTurnId === undefined
      ? types.flatMap((type) =>
          deps.db
            .select({
              turnId: eventTable.turnId,
              sequence: min(eventTable.sequence),
            })
            .from(eventTable)
            .where(
              and(
                eq(eventTable.threadId, threadId),
                eq(eventTable.type, type),
                eq(eventTable.scopeKind, "turn"),
                isNotNull(eventTable.turnId),
                beforeSequence === null
                  ? undefined
                  : lt(eventTable.sequence, beforeSequence),
                ...types.map((earlierType) =>
                  notExists(
                    deps.db
                      .select({ id: earlier.id })
                      .from(earlier)
                      .where(
                        and(
                          eq(earlier.threadId, threadId),
                          eq(earlier.turnId, eventTable.turnId),
                          eq(earlier.type, earlierType),
                          eq(earlier.scopeKind, "turn"),
                          lt(earlier.sequence, eventTable.sequence),
                        ),
                      ),
                  ),
                ),
                notExists(
                  deps.db
                    .select({ id: starts.id })
                    .from(starts)
                    .where(
                      and(
                        eq(starts.threadId, threadId),
                        eq(starts.turnId, eventTable.turnId),
                        eq(starts.type, "turn/started"),
                        isNotNull(starts.parentToolCallId),
                      ),
                    ),
                ),
              ),
            )
            .groupBy(eventTable.turnId)
            .orderBy(desc(min(eventTable.sequence)))
            .limit(101)
            .all(),
        )
      : [];
  candidates.sort((a, b) => b.sequence! - a.sequence!);
  const turnIds = [
    ...new Set(
      candidates.flatMap((row) => (row.turnId === null ? [] : [row.turnId])),
    ),
  ];
  const selectedTurnIds =
    snapshotTurnId === undefined ? turnIds.slice(0, 100) : [snapshotTurnId];
  const rows = selectedTurnIds.flatMap((turnId) =>
    types.flatMap((type) =>
      deps.db
        .select({
          id: sql<StoredEventRow["id"]>`${eventTable.id}`,
          threadId: sql<StoredEventRow["threadId"]>`${eventTable.threadId}`,
          scopeKind: sql<StoredEventRow["scopeKind"]>`${eventTable.scopeKind}`,
          turnId: sql<StoredEventRow["turnId"]>`${eventTable.turnId}`,
          providerThreadId: sql<
            StoredEventRow["providerThreadId"]
          >`${eventTable.providerThreadId}`,
          sequence: sql<StoredEventRow["sequence"]>`${eventTable.sequence}`,
          type: sql<StoredEventRow["type"]>`${eventTable.type}`,
          itemId: sql<StoredEventRow["itemId"]>`${eventTable.itemId}`,
          itemKind: sql<StoredEventRow["itemKind"]>`${eventTable.itemKind}`,
          parentToolCallId: sql<
            StoredEventRow["parentToolCallId"]
          >`${eventTable.parentToolCallId}`,
          data: sql<StoredEventRow["data"]>`${eventTable.data}`,
          createdAt: sql<StoredEventRow["createdAt"]>`${eventTable.createdAt}`,
        })
        .from(
          sql`${eventTable} INDEXED BY events_thread_turn_type_item_sequence_idx`,
        )
        .where(
          and(
            eq(eventTable.threadId, threadId),
            eq(eventTable.turnId, turnId),
            eq(eventTable.type, type),
          ),
        )
        .orderBy(asc(eventTable.sequence))
        .all(),
    ),
  );
  const incompleteDecode = new Set<string>();
  const criticalDecode = new Set<string>();
  const unknownFirstAcceptance = new Set<string>();
  const decoded = new Map<number, ThreadEvent>();
  const decode = (row: StoredEventRow, targets: readonly string[]): boolean => {
    if (decoded.has(row.sequence)) return true;
    try {
      decoded.set(row.sequence, parseStoredEvent(row));
      return true;
    } catch {
      for (const turnId of targets) incompleteDecode.add(turnId);
      if (
        row.type === "turn/started" ||
        row.type === "turn/completed" ||
        row.type === "turn/input/accepted"
      ) {
        for (const turnId of targets) criticalDecode.add(turnId);
      }
      return false;
    }
  };
  for (const row of rows) decode(row, row.turnId === null ? [] : [row.turnId]);
  const requestIds = new Set(
    [...decoded.values()].flatMap((event) =>
      event.type === "turn/input/accepted" ? [event.clientRequestId] : [],
    ),
  );
  for (const requestId of requestIds) {
    const targets = [...decoded.values()].flatMap((event) =>
      event.type === "turn/input/accepted" &&
      event.clientRequestId === requestId &&
      event.scope.kind === "turn"
        ? [event.scope.turnId]
        : [],
    );
    const request = deps.db
      .select()
      .from(eventTable)
      .where(
        and(
          eq(eventTable.threadId, threadId),
          eq(eventTable.type, "client/turn/requested"),
          sql`CASE WHEN json_valid(${eventTable.data}) THEN json_extract(${eventTable.data}, '$.requestId') END = ${requestId}`,
        ),
      )
      .orderBy(asc(eventTable.sequence))
      .limit(1)
      .get();
    if (request) decode(request, targets);
    const firstAcceptance = deps.db
      .select()
      .from(eventTable)
      .where(
        and(
          eq(eventTable.threadId, threadId),
          eq(eventTable.type, "turn/input/accepted"),
          eq(eventTable.scopeKind, "turn"),
          sql`CASE WHEN json_valid(${eventTable.data}) THEN json_extract(${eventTable.data}, '$.clientRequestId') END = ${requestId}`,
        ),
      )
      .orderBy(asc(eventTable.sequence))
      .limit(1)
      .get();
    if (!firstAcceptance || !decode(firstAcceptance, targets)) {
      unknownFirstAcceptance.add(requestId);
      for (const turnId of targets) {
        incompleteDecode.add(turnId);
        criticalDecode.add(turnId);
      }
    }
  }
  const events = [...decoded.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, event]) => event);
  const outcomes = selectedTurnIds.map((turnId) => {
    const outcome = reduceWakeTurnOutcome({
      threadId,
      turnId,
      events,
      telemetry: "unknown",
    });
    if (incompleteDecode.has(turnId)) {
      outcome.wakeCause = "unknown";
      outcome.coverage.attribution = "unknown";
    }
    if (criticalDecode.has(turnId)) outcome.completed = false;
    outcome.requests = outcome.requests.filter(
      (request) => !unknownFirstAcceptance.has(request.requestId),
    );
    const hasStart = events.some(
      (event) =>
        event.type === "turn/started" &&
        !event.parentToolCallId &&
        event.scope.kind === "turn" &&
        event.scope.turnId === turnId,
    );
    if (
      settlement &&
      outcome.completed &&
      hasStart &&
      !criticalDecode.has(turnId)
    ) {
      appendOperationOnce(deps, turnId, {
        threadId,
        scope: turnScope(turnId),
        type: "system/operation",
        data: {
          operation: "wake.turn-outcome.v1",
          operationId: turnId,
          status: "completed",
          message: "Observed turn outcome",
          metadata: { ...outcome, origin: "settlement" },
        },
      });
    }
    return outcome;
  });
  const complete = outcomes.filter((outcome) => outcome.completed);
  return {
    outcomes,
    nextCursor:
      snapshotTurnId === undefined && turnIds.length > 100
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              threadId,
              sequence: candidates[99]!.sequence,
            }),
          ).toString("base64url")
        : null,
    truncated: snapshotTurnId === undefined && turnIds.length > 100,
    summary: {
      completedTurns: complete.length,
      unknownCauseRate: complete.length
        ? complete.filter((outcome) => outcome.wakeCause === "unknown").length /
          complete.length
        : null,
      unknownEffectRate: complete.length
        ? complete.filter((outcome) => outcome.changedAnything === "unknown")
            .length / complete.length
        : null,
    },
  };
}
