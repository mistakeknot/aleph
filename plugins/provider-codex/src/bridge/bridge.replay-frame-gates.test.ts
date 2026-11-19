import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  experimental_assembleCapturedThreadEvents as eventsFrom,
  experimental_createBridgeJsonRpcTestHarness as createHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import { createReplayGate } from "../../../../packages/provider-bridge-protocol/src/testing/replay-gate.js";
import type { CodexAppServerRequestResponder } from "./app-server-connection.js";

const transport = vi.hoisted(() => ({
  notify: (_method: string, _params: unknown) => {},
  request: (
    _method: string,
    _params: unknown,
    _responder: CodexAppServerRequestResponder,
  ) => {},
  start: async (): Promise<unknown> => ({}),
}));
vi.mock("./app-server-connection.js", async (original) => ({
  ...(await original<typeof import("./app-server-connection.js")>()),
  createCodexAppServerConnection: (options: {
    onNotification: typeof transport.notify;
    onRequest: typeof transport.request;
  }) => {
    transport.notify = options.onNotification;
    transport.request = options.onRequest;
    return {
      exited: false,
      kill: async () => {},
      request: async ({
        method,
        resultSchema,
      }: {
        method: string;
        resultSchema: z.ZodType;
      }) => {
        let result: unknown;
        switch (method) {
          case "initialize":
            result = { userAgent: "codex/0.140.0" };
            break;
          case "thread/start":
            result = { thread: { id: "native-frame-thread" } };
            break;
          case "model/list":
            result = { data: [] };
            break;
          case "config/read":
            result = { config: { model: null } };
            break;
          case "turn/start":
            result = await transport.start();
            break;
          case "turn/interrupt":
            transport.notify("turn/completed", {
              threadId: providerThreadId,
              turn: turn("interrupted"),
            });
            result = {};
            break;
          default:
            throw new Error(`Unmatched synthetic request ${method}`);
        }
        return resultSchema.parse(result);
      },
    };
  },
}));
import { handleLine } from "./bridge.js";

const options = {
  permissionMode: "full",
  permissionScope: "full",
  approvalReviewer: null,
  permissionEscalation: null,
};
let harness: ReturnType<typeof createHarness> | undefined;
let gate: ReturnType<typeof createReplayGate> | undefined;
const tasks: Promise<unknown>[] = [];
function track<T>(task: Promise<T>): Promise<T> {
  tasks.push(task);
  void task.catch(() => {});
  return task;
}
const threadId = "thr_frame_gates";
const providerThreadId = "native-frame-thread";
const turnId = "native-frame-turn";
const turn = (status: string) => ({
  id: turnId,
  status,
  items: [],
  error: null,
});
const events = () => eventsFrom(harness!.messages, "codex");
const terminals = () =>
  events().filter((event) => event.type === "turn/completed");
const interactions = () =>
  harness!.messages.filter(
    (message) => message.method === "interaction/request",
  );

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
    providerThreadId,
    input: [{ type: "text", text: "synthetic", mentions: [] }],
    clientRequestId: "creq_abcdefgh23",
    options,
  });
}

afterEach(async () => {
  gate?.teardown();
  await Promise.allSettled(tasks.splice(0));
  if (harness) {
    harness.sendRequest(99, "thread/stop", {
      threadId,
      providerThreadId,
      intent: "release",
      activeTurnId: null,
    });
    await harness.waitForResponse(99);
    harness.restore();
  }
  harness = undefined;
});

it("a delayed turn-start ACK after completion does not revive the Codex turn", async () => {
  gate = createReplayGate(["start-ack"]);
  transport.start = () =>
    track(
      (async () => {
        await gate!.beforeEmit("start-ack");
        return { turn: turn("inProgress") };
      })(),
    );
  await start();
  await gate.waitForReached("start-ack");
  transport.notify("turn/started", {
    threadId: providerThreadId,
    turn: turn("inProgress"),
  });
  transport.notify("turn/completed", {
    threadId: providerThreadId,
    turn: turn("completed"),
  });
  await expect.poll(() => terminals().length).toBe(1);
  const before = events().length;
  gate.release("start-ack");
  expect((await harness!.waitForResponse(2)).error).toBeUndefined();
  await harness!.flushWork();
  expect(terminals()).toHaveLength(1);
  expect(
    events()
      .slice(before)
      .filter((event) => event.type === "turn/started"),
  ).toEqual([]);
  expect(interactions()).toEqual([]);
});

it("approval replies after interrupt do not settle the Codex turn twice", async () => {
  gate = createReplayGate(["approval-reply"]);
  transport.start = async () => ({ turn: turn("inProgress") });
  await start();
  expect((await harness!.waitForResponse(2)).error).toBeUndefined();
  transport.notify("turn/started", {
    threadId: providerThreadId,
    turn: turn("inProgress"),
  });
  const settled = vi.fn();
  transport.request(
    "item/commandExecution/requestApproval",
    {
      threadId: providerThreadId,
      turnId,
      itemId: "command-frame",
      command: "git status",
      cwd: process.cwd(),
      reason: "synthetic approval",
      commandActions: [],
      availableDecisions: ["accept", "decline"],
    },
    { result: settled, error: settled },
  );
  await expect.poll(() => interactions().length).toBe(1);
  const pending = new Set(interactions().map((message) => message.id));
  const reply = track(
    (async () => {
      await gate!.beforeEmit("approval-reply");
      for (const id of pending) {
        handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: "interrupted" },
          }),
        );
        pending.delete(id);
      }
    })(),
  );
  await gate.waitForReached("approval-reply");
  harness!.sendRequest(3, "thread/stop", {
    threadId,
    providerThreadId,
    intent: "interrupt",
    activeTurnId: turnId,
  });
  await harness!.waitForResponse(3);
  await expect.poll(() => terminals().length).toBe(1);
  gate.release("approval-reply");
  await reply;
  await expect.poll(() => settled.mock.calls.length).toBe(1);
  await harness!.flushWork();
  expect(terminals()).toHaveLength(1);
  expect(pending.size).toBe(0);
  expect(interactions()).toHaveLength(1);
});
