import type { BbPluginApi } from "@get-bb/plugin-sdk";

export function oneLineOutcome(text: string): string | null {
  const line = text.split(/[\r\n\u2028\u2029]/u).find((part) => part.trim());
  return line === undefined
    ? null
    : Array.from(line.trim()).slice(0, 280).join("");
}

export function renderPreviousOutcome(
  prompt: string,
  previous: { outcome: string | null; startedAt: number } | null,
): string {
  return previous?.outcome
    ? `Previous run (${new Date(previous.startedAt).toISOString()}): ${previous.outcome}\n${prompt}`
    : prompt;
}

export async function readThreadOutcome(
  bb: Pick<BbPluginApi, "sdk" | "log">,
  threadId: string,
): Promise<string | null> {
  try {
    let beforeSeq: string | undefined;
    for (;;) {
      const events = await bb.sdk.threads.events.list({
        threadId,
        beforeSeq,
        order: "desc",
        limit: "100",
        types: ["item/completed", "client/turn/requested"],
      });
      if (events.length === 0) return null;
      for (const event of events) {
        if (event.type === "client/turn/requested") return null;
        if (event.type !== "item/completed") continue;
        const item = event.data.item;
        if (item.type === "agentMessage" && !item.parentToolCallId) {
          return oneLineOutcome(item.text);
        }
      }
      beforeSeq = String(events[events.length - 1]!.seq);
    }
  } catch {
    bb.log.warn("Could not read automation thread outcome");
    return null;
  }
}
