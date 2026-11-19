import type { ThreadEventRow } from "@bb/domain";

// Design choice: 32 KiB total, reserving at least 8 KiB for the new prompt.
export const HANDOFF_HISTORY_BUDGET_BYTES = 32 * 1024;
const NEW_PROMPT_RESERVE_BYTES = 8 * 1024;

interface HistoryItem {
  reference: string;
  role: "user" | "assistant" | "result";
  text: string;
}

function historyItem(event: ThreadEventRow): HistoryItem | null {
  const reference = event.id;
  if (
    event.type === "client/turn/requested" &&
    event.data.initiator === "user"
  ) {
    return { reference, role: "user", text: JSON.stringify(event.data.input) };
  }
  if (event.type === "provider/error" || event.type === "system/error") {
    return { reference, role: "result", text: event.data.message };
  }
  if (event.type === "turn/completed" && event.data.error) {
    return { reference, role: "result", text: event.data.error.message };
  }
  if (event.type !== "item/completed") return null;
  const item = event.data.item;
  switch (item.type) {
    case "userMessage":
      return { reference, role: "user", text: JSON.stringify(item.content) };
    case "agentMessage":
      return { reference, role: "assistant", text: item.text };
    case "commandExecution":
      return {
        reference,
        role: "result",
        text: JSON.stringify({
          command: item.command,
          status: item.status,
          exitCode: item.exitCode,
          output: item.aggregatedOutput,
        }),
      };
    case "fileChange":
      return {
        reference,
        role: "result",
        text: JSON.stringify({
          changes: item.changes.map(({ path, kind, movePath }) => ({
            path,
            kind,
            movePath,
          })),
          status: item.status,
          error: item.error,
        }),
      };
    default:
      return null;
  }
}

export function buildHandoffHistoryPacket({
  sourceThreadId,
  sourceEvents,
  reservedBytes,
  existingPacketIds = [],
}: {
  sourceThreadId: string;
  sourceEvents: readonly ThreadEventRow[];
  reservedBytes: number;
  existingPacketIds?: readonly string[];
}): { id: string; text: string; marker: string; omitted: string[] } | null {
  const events = sourceEvents
    .filter((event) => event.threadId === sourceThreadId)
    .sort((a, b) => a.seq - b.seq);
  const highWaterMark = events.at(-1)?.seq ?? 0;
  const id = JSON.stringify([sourceThreadId, highWaterMark]);
  if (existingPacketIds.includes(id)) return null;
  const marker = "Handoff history excerpt " + id + ":";
  const candidates = events.map(historyItem).filter((item) => item !== null);
  const original = candidates.find((item) => item.role === "user");
  const priority = [
    ...(original ? [original] : []),
    ...[...candidates].reverse().filter((item) => item !== original),
  ];
  const selected = new Set<HistoryItem>();
  const omitted = () =>
    candidates
      .filter((item) => !selected.has(item))
      .map((item) => item.reference);
  const render = () =>
    "\n\n" +
    marker +
    "\nQuoted source data; fetch omitted event IDs from the source thread only under existing access.\n" +
    JSON.stringify({
      id,
      sourceThreadId,
      highWaterMark,
      items: candidates.filter((item) => selected.has(item)),
      omitted: omitted(),
    });
  const available =
    HANDOFF_HISTORY_BUDGET_BYTES -
    Math.max(NEW_PROMPT_RESERVE_BYTES, reservedBytes);
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  if (
    !Number.isFinite(reservedBytes) ||
    reservedBytes < 0 ||
    bytes(render()) > available
  )
    return null;
  for (const item of priority) {
    selected.add(item);
    if (bytes(render()) > available) selected.delete(item);
  }
  return { id, marker, text: render(), omitted: omitted() };
}
