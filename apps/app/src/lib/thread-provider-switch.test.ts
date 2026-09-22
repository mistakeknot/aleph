import { describe, expect, it, vi } from "vitest";
import {
  isThreadSwitchAvailable,
  switchThreadProvider,
  ThreadSwitchAttachmentsError,
} from "./thread-provider-switch";

const draft = (text: string, attachments: unknown[] = []) =>
  ({ text, mentions: [], attachments }) as never;

function fakeFetch(body: unknown, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

const args = {
  threadId: "thr_src",
  providerId: "codex",
  model: "gpt-6",
  reasoningLevel: "high" as const,
};

describe("isThreadSwitchAvailable", () => {
  it("needs the handoff plugin enabled and running", () => {
    expect(
      isThreadSwitchAvailable([
        { id: "handoff", enabled: true, status: "running" },
      ]),
    ).toBe(true);
    expect(
      isThreadSwitchAvailable([
        { id: "handoff", enabled: false, status: "running" },
      ]),
    ).toBe(false);
    expect(
      isThreadSwitchAvailable([
        { id: "handoff", enabled: true, status: "error" },
      ]),
    ).toBe(false);
    expect(isThreadSwitchAvailable([])).toBe(false);
  });
});

describe("switchThreadProvider", () => {
  it("asks the handoff plugin to replace the thread, with the typed message", async () => {
    const fetchImpl = fakeFetch({
      ok: true,
      result: { newThreadId: "thr_new" },
    });
    await expect(
      switchThreadProvider(fetchImpl as never, {
        ...args,
        draft: draft("  what was the codeword?  "),
      }),
    ).resolves.toEqual({ newThreadId: "thr_new" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/v1/plugins/handoff/rpc/startHandoff");
    expect(JSON.parse(init.body as string)).toEqual({
      threadId: "thr_src",
      providerId: "codex",
      model: "gpt-6",
      reasoningLevel: "high",
      workspace: "reuse",
      replace: true,
      message: "what was the codeword?",
    });
  });

  it("sends no message for an empty draft", async () => {
    const fetchImpl = fakeFetch({
      ok: true,
      result: { newThreadId: "thr_new" },
    });
    await switchThreadProvider(fetchImpl as never, {
      ...args,
      draft: draft("   "),
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)).not.toHaveProperty("message");
  });

  it("refuses attachments without calling the plugin", async () => {
    const fetchImpl = fakeFetch({});
    await expect(
      switchThreadProvider(fetchImpl as never, {
        ...args,
        draft: draft("see attached", [{ name: "a.png" }]),
      }),
    ).rejects.toBeInstanceOf(ThreadSwitchAttachmentsError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when the plugin answers without a thread", async () => {
    const fetchImpl = fakeFetch({ ok: true, result: {} });
    await expect(
      switchThreadProvider(fetchImpl as never, { ...args, draft: draft("x") }),
    ).rejects.toThrow("did not return the new thread");
  });
});
