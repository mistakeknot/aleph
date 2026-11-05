export type Provider = "claude" | "codex" | "bb";

export interface NormalizeSource {
  provider: Provider;
  sessionId?: string | null;
  agentId?: string | null;
}

export type TouchAccess = "read" | "write" | "reference";
export type TouchConfidence = "structured" | "inferred";

export interface FileTouch {
  path: string;
  access: TouchAccess;
  confidence: TouchConfidence;
}

export interface RecordBase {
  provider: Provider;
  sessionId: string | null;
  agentId: string | null;
  sidechain: boolean;
  parentCallId: string | null;
  cwd: string | null;
  eventTimeMs: number | null;
  dedupeKey: string;
}

export interface MessageRecord extends RecordBase {
  kind: "message";
  role: "user" | "assistant";
  text: string;
}

export interface ToolCallRecord extends RecordBase {
  kind: "tool_call";
  callId: string;
  name: string;
  argumentsText: string;
  touches: FileTouch[];
  delegation: boolean;
}

export interface ToolResultRecord extends RecordBase {
  kind: "tool_result";
  callId: string;
  text: string;
}

export interface SessionRecord extends RecordBase {
  kind: "session";
  model: string | null;
}

export type UsageBasis = "delta" | "cumulative";

export type UsageOrigin =
  | "claude-message"
  | "claude-cost-state"
  | "codex-token-usage-record"
  | "codex-token-count"
  | "bb-token-usage";

export interface UsageTokens {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
}

export interface UsageRecord extends RecordBase, UsageTokens {
  kind: "usage";
  basis: UsageBasis;
  origin: UsageOrigin;
  scopeKey: string;
  model: string | null;
  inputIncludesCache: boolean | null;
  costUsd: number | null;
}

export type NormalizedRecord =
  | MessageRecord
  | ToolCallRecord
  | ToolResultRecord
  | SessionRecord
  | UsageRecord;

export interface ParsedJsonl {
  records: unknown[];
  malformedLines: number;
}

type JsonObject = Record<string, unknown>;

const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "shell_command",
  "exec_command",
  "local_shell",
  "commandexecution",
]);

const CLAUDE_READ_TOOLS = new Set(["Read"]);
const CLAUDE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
const CLAUDE_REFERENCE_TOOLS = new Set(["Grep", "Glob"]);
const CLAUDE_DELEGATION_TOOLS = new Set(["Task", "Agent"]);

const PATCH_HEADER =
  /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+?)\s*$/gm;
const PATH_WITH_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const SHELL_TOKEN_SPLIT = /[\s;&|<>()]+/;
const SHELL_TOKEN_QUOTES = /^[`'"]+|[`'",]+$/g;
const SHELL_TOKEN_EXCLUDED = /[*?${}=]|:\/\//;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseTimeMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function parseJsonObject(value: unknown): JsonObject | null {
  if (isObject(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseJsonlLine(
  line: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

export function parseJsonl(text: string): ParsedJsonl {
  const records: unknown[] = [];
  let malformedLines = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const parsed = parseJsonlLine(line);
    if (parsed.ok) {
      records.push(parsed.value);
    } else {
      malformedLines += 1;
    }
  }
  return { records, malformedLines };
}

export function dedupeByKey<T extends { dedupeKey: string }>(
  records: readonly T[],
): T[] {
  const seen = new Set<string>();
  const unique: T[] = [];
  for (const record of records) {
    if (!seen.has(record.dedupeKey)) {
      seen.add(record.dedupeKey);
      unique.push(record);
    }
  }
  return unique;
}

export interface UsageDeltaEntry {
  record: UsageRecord;
  delta: UsageTokens | null;
  reset: boolean;
}

const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

function tokenDelta(
  previous: UsageTokens,
  current: UsageTokens,
): UsageTokens | null {
  const delta: UsageTokens = {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    totalTokens: null,
  };
  for (const field of TOKEN_FIELDS) {
    const before = previous[field];
    const after = current[field];
    if (before === null || after === null) {
      continue;
    }
    if (after < before) {
      return null;
    }
    delta[field] = after - before;
  }
  return delta;
}

export function cumulativeToDeltas(
  snapshots: readonly UsageRecord[],
  baseline?: UsageRecord | null,
): UsageDeltaEntry[] {
  const entries: UsageDeltaEntry[] = [];
  let previous: UsageRecord | null = baseline ?? null;
  for (const record of snapshots) {
    if (record.basis !== "cumulative") {
      throw new Error("cumulativeToDeltas requires cumulative usage records");
    }
    if (previous !== null && previous.scopeKey !== record.scopeKey) {
      throw new Error("cumulativeToDeltas requires a single usage scope");
    }
    if (previous === null) {
      entries.push({ record, delta: null, reset: false });
    } else {
      const delta = tokenDelta(previous, record);
      entries.push({ record, delta, reset: delta === null });
    }
    previous = record;
  }
  return entries;
}

function textFromBlocks(
  content: unknown,
  textTypes: readonly string[],
): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) {
      continue;
    }
    const type = asString(block.type);
    const text = asString(block.text);
    if (type !== null && text !== null && textTypes.includes(type)) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function patchTouches(text: string): FileTouch[] {
  const touches: FileTouch[] = [];
  for (const match of text.matchAll(PATCH_HEADER)) {
    const path = match[1];
    if (path !== undefined && path.length > 0) {
      touches.push({ path, access: "write", confidence: "structured" });
    }
  }
  return touches;
}

function looksLikePath(token: string): boolean {
  if (
    token.length < 2 ||
    token.startsWith("-") ||
    SHELL_TOKEN_EXCLUDED.test(token)
  ) {
    return false;
  }
  if (!/[A-Za-z0-9]/.test(token)) {
    return false;
  }
  return token.includes("/") || PATH_WITH_EXTENSION.test(token);
}

function shellTouches(command: string): FileTouch[] {
  const touches: FileTouch[] = [];
  const seen = new Set<string>();
  for (const rawToken of command.split(SHELL_TOKEN_SPLIT)) {
    const token = rawToken.replace(SHELL_TOKEN_QUOTES, "");
    if (looksLikePath(token) && !seen.has(token)) {
      seen.add(token);
      touches.push({
        path: token,
        access: "reference",
        confidence: "inferred",
      });
    }
  }
  return touches;
}

function mergeTouches(
  structured: FileTouch[],
  inferred: FileTouch[],
): FileTouch[] {
  const known = new Set(structured.map((touch) => touch.path));
  return [...structured, ...inferred.filter((touch) => !known.has(touch.path))];
}

function isShellTool(name: string): boolean {
  return SHELL_TOOL_NAMES.has(name.toLowerCase());
}

function touchesForCommand(name: string, text: string): FileTouch[] {
  const structured = patchTouches(text);
  const inferred = isShellTool(name) ? shellTouches(text) : [];
  return mergeTouches(structured, inferred);
}

function shellCommandText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (
    !Array.isArray(value) ||
    !value.every((part): part is string => typeof part === "string")
  ) {
    return null;
  }
  const flagIndex = value.findIndex((part) => part === "-lc" || part === "-c");
  const script = flagIndex >= 0 ? value[flagIndex + 1] : undefined;
  return script !== undefined ? script : value.join(" ");
}

function eventBase(
  source: NormalizeSource,
  fields: {
    sessionId: string | null;
    agentId?: string | null;
    sidechain?: boolean;
    parentCallId?: string | null;
    cwd?: string | null;
    eventTimeMs: number | null;
    dedupeKey: string;
  },
): RecordBase {
  return {
    provider: source.provider,
    sessionId: fields.sessionId,
    agentId: fields.agentId ?? null,
    sidechain: fields.sidechain ?? false,
    parentCallId: fields.parentCallId ?? null,
    cwd: fields.cwd ?? null,
    eventTimeMs: fields.eventTimeMs,
    dedupeKey: fields.dedupeKey,
  };
}

function normalizeClaude(
  record: JsonObject,
  source: NormalizeSource,
): NormalizedRecord[] {
  const type = asString(record.type);
  const sessionId =
    asNonEmptyString(record.sessionId) ?? source.sessionId ?? null;
  const agentId = asNonEmptyString(record.agentId) ?? source.agentId ?? null;
  const sidechain = record.isSidechain === true || agentId !== null;
  const eventTimeMs = parseTimeMs(record.timestamp);
  const cwd = asNonEmptyString(record.cwd);

  if (type === "cost-state") {
    return normalizeClaudeCostState(record, source, sessionId, cwd);
  }
  if (type !== "user" && type !== "assistant") {
    return [];
  }
  const message = record.message;
  if (!isObject(message)) {
    return [];
  }
  const messageId = asNonEmptyString(message.id);
  const requestId = asNonEmptyString(record.requestId);
  const uuid =
    asNonEmptyString(record.uuid) ??
    messageId ??
    `${sessionId ?? "-"}:${asString(record.timestamp) ?? "-"}`;

  const base = (index: number) =>
    eventBase(source, {
      sessionId,
      agentId,
      sidechain,
      cwd,
      eventTimeMs,
      dedupeKey: `claude:${uuid}:${index}`,
    });

  const records: NormalizedRecord[] = [];
  const content = message.content;

  if (type === "user") {
    if (record.isMeta === true) {
      return [];
    }
    if (typeof content === "string") {
      if (content.length > 0) {
        records.push({
          ...base(0),
          kind: "message",
          role: "user",
          text: content,
        });
      }
      return records;
    }
    if (!Array.isArray(content)) {
      return [];
    }
    content.forEach((block, index) => {
      if (!isObject(block)) {
        return;
      }
      const blockType = asString(block.type);
      if (blockType === "text") {
        const text = asNonEmptyString(block.text);
        if (text !== null) {
          records.push({ ...base(index), kind: "message", role: "user", text });
        }
      } else if (blockType === "tool_result") {
        const callId = asNonEmptyString(block.tool_use_id);
        const text = textFromBlocks(block.content, ["text"]);
        if (callId !== null && text !== null) {
          records.push({ ...base(index), kind: "tool_result", callId, text });
        }
      }
    });
    return records;
  }

  if (typeof content === "string") {
    if (content.length > 0) {
      records.push({
        ...base(0),
        kind: "message",
        role: "assistant",
        text: content,
      });
    }
  } else if (Array.isArray(content)) {
    content.forEach((block, index) => {
      if (!isObject(block)) {
        return;
      }
      const blockType = asString(block.type);
      if (blockType === "text") {
        const text = asNonEmptyString(block.text);
        if (text !== null) {
          records.push({
            ...base(index),
            kind: "message",
            role: "assistant",
            text,
          });
        }
      } else if (blockType === "tool_use") {
        const call = claudeToolCall(block);
        if (call !== null) {
          records.push({ ...base(index), kind: "tool_call", ...call });
        }
      }
    });
  }

  const usage = claudeUsage(message.usage);
  if (usage !== null) {
    const usageKey = messageId ?? requestId ?? uuid;
    records.push({
      ...eventBase(source, {
        sessionId,
        agentId,
        sidechain,
        cwd,
        eventTimeMs,
        dedupeKey: `claude:usage:${usageKey}`,
      }),
      kind: "usage",
      basis: "delta",
      origin: "claude-message",
      scopeKey: `claude:${sessionId ?? "unknown"}:${agentId ?? "main"}`,
      model: asNonEmptyString(message.model),
      ...usage,
      inputIncludesCache: false,
      costUsd: null,
    });
  }
  return records;
}

function claudeUsage(value: unknown): UsageTokens | null {
  if (!isObject(value)) {
    return null;
  }
  return {
    inputTokens: asNumber(value.input_tokens),
    outputTokens: asNumber(value.output_tokens),
    cacheReadTokens: asNumber(value.cache_read_input_tokens),
    cacheWriteTokens: asNumber(value.cache_creation_input_tokens),
    reasoningTokens: null,
    totalTokens: null,
  };
}

function claudeToolCall(
  block: JsonObject,
): Pick<
  ToolCallRecord,
  "callId" | "name" | "argumentsText" | "touches" | "delegation"
> | null {
  const callId = asNonEmptyString(block.id);
  const name = asNonEmptyString(block.name);
  if (callId === null || name === null) {
    return null;
  }
  const input = isObject(block.input) ? block.input : {};
  const filePath = asNonEmptyString(input.file_path);
  const notebookPath = asNonEmptyString(input.notebook_path);
  const searchPath = asNonEmptyString(input.path);
  const command = asString(input.command);
  let touches: FileTouch[] = [];
  if (CLAUDE_READ_TOOLS.has(name) && filePath !== null) {
    touches = [{ path: filePath, access: "read", confidence: "structured" }];
  } else if (CLAUDE_WRITE_TOOLS.has(name) && filePath !== null) {
    touches = [{ path: filePath, access: "write", confidence: "structured" }];
  } else if (name === "NotebookEdit" && notebookPath !== null) {
    touches = [
      { path: notebookPath, access: "write", confidence: "structured" },
    ];
  } else if (CLAUDE_REFERENCE_TOOLS.has(name) && searchPath !== null) {
    touches = [
      { path: searchPath, access: "reference", confidence: "structured" },
    ];
  } else if (command !== null) {
    touches = touchesForCommand(name, command);
  }
  return {
    callId,
    name,
    argumentsText: command ?? JSON.stringify(input),
    touches,
    delegation: CLAUDE_DELEGATION_TOOLS.has(name),
  };
}

function normalizeClaudeCostState(
  record: JsonObject,
  source: NormalizeSource,
  sessionId: string | null,
  cwd: string | null,
): NormalizedRecord[] {
  const modelUsage = record.modelUsage;
  if (!isObject(modelUsage)) {
    return [];
  }
  const records: NormalizedRecord[] = [];
  for (const [model, entry] of Object.entries(modelUsage)) {
    if (!isObject(entry)) {
      continue;
    }
    const tokens: UsageTokens = {
      inputTokens: asNumber(entry.inputTokens),
      outputTokens: asNumber(entry.outputTokens),
      cacheReadTokens: asNumber(entry.cacheReadInputTokens),
      cacheWriteTokens: asNumber(entry.cacheCreationInputTokens),
      reasoningTokens: null,
      totalTokens: null,
    };
    const costUsd = asNumber(entry.costUSD);
    const fingerprint = [
      tokens.inputTokens,
      tokens.outputTokens,
      tokens.cacheReadTokens,
      tokens.cacheWriteTokens,
      costUsd,
    ].join(":");
    records.push({
      ...eventBase(source, {
        sessionId,
        cwd,
        eventTimeMs: null,
        dedupeKey: `claude:cost:${sessionId ?? "-"}:${model}:${fingerprint}`,
      }),
      kind: "usage",
      basis: "cumulative",
      origin: "claude-cost-state",
      scopeKey: `claude:${sessionId ?? "unknown"}`,
      model,
      ...tokens,
      inputIncludesCache: false,
      costUsd,
    });
  }
  return records;
}

function codexUsage(value: unknown): UsageTokens | null {
  if (!isObject(value)) {
    return null;
  }
  return {
    inputTokens: asNumber(value.input_tokens),
    outputTokens: asNumber(value.output_tokens),
    cacheReadTokens: asNumber(value.cached_input_tokens),
    cacheWriteTokens: asNumber(value.cache_write_input_tokens),
    reasoningTokens: asNumber(value.reasoning_output_tokens),
    totalTokens: asNumber(value.total_tokens),
  };
}

function codexOutputText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (isObject(value)) {
    return codexOutputText(value.content);
  }
  return textFromBlocks(value, ["text", "output_text", "input_text"]);
}

function normalizeCodex(
  record: JsonObject,
  source: NormalizeSource,
): NormalizedRecord[] {
  const type = asString(record.type);
  const payload = record.payload;
  if (type === null || !isObject(payload)) {
    return [];
  }
  const payloadType = asString(payload.type);
  const timestamp = asString(record.timestamp);
  const ordinal = asNumber(record.ordinal);
  const eventTimeMs = parseTimeMs(timestamp);
  const sessionId =
    source.sessionId ??
    asNonEmptyString(payload.session_id) ??
    (type === "session_meta" ? asNonEmptyString(payload.id) : null);
  const callId = asNonEmptyString(payload.call_id);
  const position =
    ordinal !== null
      ? String(ordinal)
      : `${timestamp ?? "-"}/${payloadType ?? type}/${callId ?? "-"}`;
  const keyFor = (index: number) =>
    `codex:${sessionId ?? "-"}:${position}:${index}`;
  const base = (index: number, cwd: string | null = null) =>
    eventBase(source, {
      sessionId,
      cwd,
      eventTimeMs,
      dedupeKey: keyFor(index),
    });

  if (type === "session_meta") {
    const metaSession =
      asNonEmptyString(payload.session_id) ??
      asNonEmptyString(payload.id) ??
      sessionId;
    return [
      {
        ...eventBase(source, {
          sessionId: source.sessionId ?? metaSession,
          cwd: asNonEmptyString(payload.cwd),
          eventTimeMs: parseTimeMs(payload.timestamp) ?? eventTimeMs,
          dedupeKey: keyFor(0),
        }),
        kind: "session",
        model: asNonEmptyString(payload.model),
      },
    ];
  }

  if (type === "turn_context") {
    return [
      {
        ...base(0, asNonEmptyString(payload.cwd)),
        kind: "session",
        model: asNonEmptyString(payload.model),
      },
    ];
  }

  if (type === "token_usage_record") {
    const tokens = codexUsage(payload.usage);
    if (tokens === null) {
      return [];
    }
    const responseId = asNonEmptyString(payload.response_id);
    return [
      {
        ...eventBase(source, {
          sessionId,
          eventTimeMs,
          dedupeKey:
            responseId !== null
              ? `codex:usage:${responseId}`
              : `codex:usage:${sessionId ?? "-"}:${position}`,
        }),
        kind: "usage",
        basis: "delta",
        origin: "codex-token-usage-record",
        scopeKey: `codex:${sessionId ?? "unknown"}`,
        model: null,
        ...tokens,
        inputIncludesCache: true,
        costUsd: null,
      },
    ];
  }

  if (type === "event_msg") {
    if (payloadType !== "token_count" || !isObject(payload.info)) {
      return [];
    }
    const tokens = codexUsage(payload.info.total_token_usage);
    if (tokens === null) {
      return [];
    }
    return [
      {
        ...eventBase(source, {
          sessionId,
          eventTimeMs,
          dedupeKey: `codex:total:${sessionId ?? "-"}:${position}`,
        }),
        kind: "usage",
        basis: "cumulative",
        origin: "codex-token-count",
        scopeKey: `codex:${sessionId ?? "unknown"}`,
        model: null,
        ...tokens,
        inputIncludesCache: true,
        costUsd: null,
      },
    ];
  }

  if (type !== "response_item") {
    return [];
  }

  if (payloadType === "message") {
    const role = payload.role;
    if (role !== "user" && role !== "assistant") {
      return [];
    }
    const text = textFromBlocks(payload.content, [
      "input_text",
      "output_text",
      "text",
    ]);
    return text === null || text.length === 0
      ? []
      : [{ ...base(0), kind: "message", role, text }];
  }

  if (payloadType === "function_call" || payloadType === "custom_tool_call") {
    const name = asNonEmptyString(payload.name);
    if (callId === null || name === null) {
      return [];
    }
    const rawArguments =
      payloadType === "function_call" ? payload.arguments : payload.input;
    const argumentsText = codexArgumentsText(rawArguments);
    return [
      {
        ...base(0),
        kind: "tool_call",
        callId,
        name,
        argumentsText,
        touches: touchesForCommand(name, argumentsText),
        delegation: false,
      },
    ];
  }

  if (
    payloadType === "function_call_output" ||
    payloadType === "custom_tool_call_output"
  ) {
    const text = codexOutputText(payload.output);
    if (callId === null || text === null) {
      return [];
    }
    return [{ ...base(0), kind: "tool_result", callId, text }];
  }

  return [];
}

function codexArgumentsText(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  const parsed = parseJsonObject(raw);
  if (parsed === null) {
    return raw;
  }
  const command = shellCommandText(parsed.command ?? parsed.cmd);
  if (command !== null) {
    return command;
  }
  return asString(parsed.input) ?? raw;
}

function normalizeBb(
  record: JsonObject,
  source: NormalizeSource,
): NormalizedRecord[] {
  const type = asString(record.type);
  const data = parseJsonObject(record.data);
  if (type === null || data === null) {
    return [];
  }
  const threadId = asNonEmptyString(record.thread_id);
  const sessionId = threadId ?? source.sessionId ?? null;
  const rowId =
    asNonEmptyString(record.id) ??
    `${threadId ?? "-"}:${asNumber(record.sequence) ?? "-"}`;
  const eventTimeMs = parseTimeMs(record.created_at);
  const parentCallId = asNonEmptyString(record.parent_tool_call_id);
  const sidechain = parentCallId !== null;
  const base = (index: number, cwd: string | null = null) =>
    eventBase(source, {
      sessionId,
      sidechain,
      parentCallId,
      cwd,
      eventTimeMs,
      dedupeKey: `bb:${rowId}:${index}`,
    });

  if (type === "client/turn/requested") {
    const input = data.input;
    if (!Array.isArray(input)) {
      return [];
    }
    const records: NormalizedRecord[] = [];
    input.forEach((part, index) => {
      const text = isObject(part) ? asNonEmptyString(part.text) : null;
      if (text !== null) {
        records.push({ ...base(index), kind: "message", role: "user", text });
      }
    });
    return records;
  }

  if (type === "thread/tokenUsage/updated") {
    const tokenUsage = data.tokenUsage;
    const total =
      isObject(tokenUsage) && isObject(tokenUsage.total)
        ? tokenUsage.total
        : null;
    if (total === null) {
      return [];
    }
    const providerThreadId =
      asNonEmptyString(record.provider_thread_id) ??
      asNonEmptyString(data.providerThreadId) ??
      "-";
    return [
      {
        ...base(0),
        kind: "usage",
        basis: "cumulative",
        origin: "bb-token-usage",
        scopeKey: `bb:${threadId ?? source.sessionId ?? "unknown"}:${providerThreadId}`,
        model: null,
        inputTokens: asNumber(total.inputTokens),
        outputTokens: asNumber(total.outputTokens),
        cacheReadTokens:
          asNumber(total.cacheReadInputTokens) ??
          asNumber(total.cachedInputTokens),
        cacheWriteTokens: asNumber(total.cacheWriteInputTokens),
        reasoningTokens: asNumber(total.reasoningOutputTokens),
        totalTokens: asNumber(total.totalTokens),
        inputIncludesCache: null,
        costUsd: null,
      },
    ];
  }

  if (type !== "item/completed") {
    return [];
  }
  const item = data.item;
  if (!isObject(item)) {
    return [];
  }
  const itemType = asNonEmptyString(record.item_kind) ?? asString(item.type);
  const callId = asNonEmptyString(item.id);

  if (itemType === "agentMessage") {
    const text = asNonEmptyString(item.text);
    return text === null
      ? []
      : [{ ...base(0), kind: "message", role: "assistant", text }];
  }

  if (callId === null) {
    return [];
  }

  if (itemType === "commandExecution") {
    const command = asString(item.command) ?? "";
    const output = asString(item.aggregatedOutput);
    const cwd = asNonEmptyString(item.cwd);
    const records: NormalizedRecord[] = [
      {
        ...base(0, cwd),
        kind: "tool_call",
        callId,
        name: "commandExecution",
        argumentsText: command,
        touches: touchesForCommand("commandExecution", command),
        delegation: false,
      },
    ];
    if (output !== null) {
      records.push({
        ...base(1, cwd),
        kind: "tool_result",
        callId,
        text: output,
      });
    }
    return records;
  }

  if (itemType === "fileRead") {
    const path = asNonEmptyString(item.path);
    return path === null
      ? []
      : [
          {
            ...base(0),
            kind: "tool_call",
            callId,
            name: "fileRead",
            argumentsText: path,
            touches: [{ path, access: "read", confidence: "structured" }],
            delegation: false,
          },
        ];
  }

  if (itemType === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const touches: FileTouch[] = [];
    const lines: string[] = [];
    for (const change of changes) {
      const path = isObject(change) ? asNonEmptyString(change.path) : null;
      if (path !== null) {
        touches.push({ path, access: "write", confidence: "structured" });
        lines.push(
          `${isObject(change) ? (asString(change.kind) ?? "change") : "change"} ${path}`,
        );
      }
    }
    return touches.length === 0
      ? []
      : [
          {
            ...base(0),
            kind: "tool_call",
            callId,
            name: "fileChange",
            argumentsText: lines.join("\n"),
            touches,
            delegation: false,
          },
        ];
  }

  if (itemType === "toolCall") {
    const name = asNonEmptyString(item.tool);
    if (name === null) {
      return [];
    }
    const rawArguments = item.arguments;
    const argumentsText =
      typeof rawArguments === "string"
        ? rawArguments
        : rawArguments === undefined || rawArguments === null
          ? ""
          : JSON.stringify(rawArguments);
    const commandSource = isObject(rawArguments)
      ? asString(rawArguments.command)
      : null;
    const records: NormalizedRecord[] = [
      {
        ...base(0),
        kind: "tool_call",
        callId,
        name,
        argumentsText: commandSource ?? argumentsText,
        touches: touchesForCommand(name, commandSource ?? argumentsText),
        delegation: false,
      },
    ];
    const result = asString(item.result);
    if (result !== null) {
      records.push({ ...base(1), kind: "tool_result", callId, text: result });
    }
    return records;
  }

  if (itemType === "delegation") {
    const records: NormalizedRecord[] = [
      {
        ...base(0),
        kind: "tool_call",
        callId,
        name: "delegation",
        argumentsText: asString(item.label) ?? "",
        touches: [],
        delegation: true,
      },
    ];
    const summary = asString(item.summary);
    if (summary !== null) {
      records.push({ ...base(1), kind: "tool_result", callId, text: summary });
    }
    return records;
  }

  return [];
}

export function normalize(
  record: unknown,
  source: NormalizeSource,
): NormalizedRecord[] {
  if (!isObject(record)) {
    return [];
  }
  switch (source.provider) {
    case "claude":
      return normalizeClaude(record, source);
    case "codex":
      return normalizeCodex(record, source);
    case "bb":
      return normalizeBb(record, source);
    default:
      return [];
  }
}
