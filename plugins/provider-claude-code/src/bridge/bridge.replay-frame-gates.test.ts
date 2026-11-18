import { afterEach, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { SdkSessionOptions } from "./sdk-session.js";
import {
  experimental_assembleCapturedThreadEvents as eventsFrom,
  experimental_createBridgeJsonRpcTestHarness as createHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createReplayGate } from "../../../../packages/provider-bridge-protocol/src/testing/replay-gate.js";

const transport = vi.hoisted(() => ({
  emit: (_message: SDKMessage) => {},
  options: undefined as SdkSessionOptions | undefined,
  consume: async () => {},
  promptId: "",
}));
vi.mock("./sdk-session.js", () => ({
  isBypassPermissionsAvailable: () => true,
  SdkSession: class {
    constructor(
      options: SdkSessionOptions,
      onMessage: (message: SDKMessage) => void,
      private onDone: () => void,
    ) {
      transport.options = options;
      transport.emit = onMessage;
    }
    start() {}
    getSessionId() {
      return transport.options?.sessionId;
    }
    canPushInput() {
      return true;
    }
    pushInput(_text: string, promptId: string) {
      transport.promptId = promptId;
      return transport.consume();
    }
    async supportedCommands() {
      return [];
    }
    async setModel() {}
    async setPermissionMode() {}
    async applyPermissionSettings() {}
    async applyMutableSettings() {}
    stop() {
      this.onDone();
    }
    async closeGracefully() {
      this.onDone();
    }
  },
}));
import { handleLine } from "./bridge.js";

const threadId = "thr_claude_frame";
const options = {
  permissionMode: "accept-edits",
  permissionScope: "workspace",
  approvalReviewer: "user",
  permissionEscalation: "ask",
};
let harness: ReturnType<typeof createHarness> | undefined;
let gate: ReturnType<typeof createReplayGate> | undefined;
const tasks: Promise<unknown>[] = [];
function track<T>(task: Promise<T>): Promise<T> {
  tasks.push(task);
  void task.catch(() => {});
  return task;
}
const events = () => eventsFrom(harness!.messages, "claude-code");
const terminals = () =>
  events().filter((event) => event.type === "turn/completed");
const interactions = () =>
  harness!.messages.filter(
    (message) => message.method === "interaction/request",
  );

function init(): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "2.1.322",
    cwd: process.cwd(),
    tools: [],
    mcp_servers: [],
    model: "synthetic",
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "00000000-0000-4000-8000-000000000003",
    session_id: threadId,
  };
}
async function start() {
  harness = createHarness(handleLine);
  harness.sendRequest(1, "thread/start", {
    threadId,
    cwd: process.cwd(),
    instructionMode: "append",
    options,
  });
  expect((await harness.waitForResponse(1)).error).toBeUndefined();
  harness.sendRequest(2, "turn/start", {
    threadId,
    providerThreadId: threadId,
    clientRequestId: "creq_abcdefgh23",
    input: [{ type: "text", text: "synthetic", mentions: [] }],
    options,
  });
}
afterEach(async () => {
  gate?.teardown();
  await Promise.allSettled(tasks.splice(0));
  if (harness) {
    harness.sendRequest(99, "thread/stop", {
      threadId,
      providerThreadId: threadId,
      intent: "release",
      activeTurnId: null,
    });
    await harness.waitForResponse(99);
    harness.restore();
  }
  harness = undefined;
});

it("approval replies after interrupt do not settle the Claude turn twice", async () => {
  gate = createReplayGate(["approval-reply"]);
  transport.consume = async () => {};
  await start();
  expect((await harness!.waitForResponse(2)).error).toBeUndefined();
  transport.emit(init());
  const canUseTool = transport.options?.canUseTool;
  if (!canUseTool) throw new Error("Missing Claude approval handler");
  let pending = 1;
  const approval = track(
    canUseTool(
      "Bash",
      { command: "git status" },
      {
        requestId: "control-request",
        toolUseID: "synthetic-command",
        signal: new AbortController().signal,
      },
    ).finally(() => {
      pending -= 1;
    }),
  );
  await expect.poll(() => interactions().length).toBe(1);
  const request = interactions()[0];
  const reply = track(
    (async () => {
      await gate!.beforeEmit("approval-reply");
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { decision: "deny", grantedPermissions: null },
        }),
      );
    })(),
  );
  await gate.waitForReached("approval-reply");
  harness!.sendRequest(3, "thread/stop", {
    threadId,
    providerThreadId: threadId,
    intent: "interrupt",
    activeTurnId: null,
  });
  expect((await harness!.waitForResponse(3)).error).toBeUndefined();
  await expect.poll(() => terminals().length).toBe(1);
  gate.release("approval-reply");
  await reply;
  await expect(approval).resolves.toMatchObject({ behavior: "deny" });
  await harness!.flushWork();
  expect(terminals()).toHaveLength(1);
  expect(pending).toBe(0);
  expect(interactions()).toHaveLength(1);
});
