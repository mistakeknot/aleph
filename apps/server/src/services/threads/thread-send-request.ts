import { getThread } from "@bb/db";
import { isStandaloneBuiltinClearCommand, type Thread } from "@bb/domain";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { sendThreadMessage } from "./thread-send.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import {
  RetirementAppearedError,
  resolveRetiredIngress,
} from "./retired-ingress.js";
import { throwThreadNotWritable } from "../lib/lifecycle-api-errors.js";

interface AcceptThreadSendRequestArgs {
  payload: SendMessageRequest;
  thread: Thread;
}

export async function acceptThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  let thread = args.thread;
  for (let attempt = 0; ; attempt += 1) {
    const resolution = resolveRetiredIngress(deps.db, thread, {
      refuseUserPosts: true,
    });
    if (resolution.kind === "unavailable") {
      throwThreadNotWritable(thread, resolution.reason, "Thread is retired");
    }
    try {
      return await acceptResolvedThreadSendRequest(deps, {
        payload: args.payload,
        thread: resolution.thread,
      });
    } catch (error) {
      if (!(error instanceof RetirementAppearedError) || attempt > 0) {
        throw error;
      }
      thread = getThread(deps.db, thread.id) ?? thread;
    }
  }
}

async function acceptResolvedThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  assertThreadHostAcceptsWork(deps.db, args.thread);
  if (isStandaloneBuiltinClearCommand(args.payload.input)) {
    const environment = await requireThreadCommandEnvironment(deps, {
      thread: args.thread,
    });
    await sendThreadMessage(deps, {
      environment,
      payload: args.payload,
      thread: args.thread,
      trigger: "user",
    });
    return { ok: true, delivery: "sent" };
  }

  const outcome = await attemptDispatch(deps, {
    thread: args.thread,
    payload: args.payload,
    source: { kind: "inline" },
    queuePayload: { kind: "inline" },
    pluginSubmission: args.payload.pluginSubmission ?? null,
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    trigger: "user",
  });
  if (outcome.kind === "dispatched") {
    return { ok: true, delivery: "sent" };
  }
  return {
    ok: true,
    delivery: "queued",
    queuedMessage: outcome.entry,
  };
}
