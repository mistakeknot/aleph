import { getThread } from "@bb/db";
import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  type Thread,
} from "@bb/domain";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { sendThreadMessage } from "./thread-send.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import {
  INGRESS_ADMISSION_ATTEMPTS,
  RetirementAppearedError,
  resolveRetiredIngress,
} from "./retired-ingress.js";
import { throwThreadNotWritable } from "../lib/lifecycle-api-errors.js";
import { runWithTurnTrace } from "../system/turn-trace.js";

interface AcceptThreadSendRequestArgs {
  payload: SendMessageRequest;
  thread: Thread;
  requestedThreadId?: string;
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
        requestedThreadId: thread.id,
      });
    } catch (error) {
      if (
        !(error instanceof RetirementAppearedError) ||
        attempt + 1 >= INGRESS_ADMISSION_ATTEMPTS
      ) {
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
  const { compactFirst, ...request } = args.payload;
  if (isStandaloneBuiltinClearCommand(request.input)) {
    if (compactFirst) throwInvalidCompactFirst("cannot clear the context");
    const environment = await requireThreadCommandEnvironment(deps, {
      thread: args.thread,
    });
    await sendThreadMessage(deps, {
      environment,
      payload: request,
      requestedThreadId: args.requestedThreadId ?? args.thread.id,
      thread: args.thread,
      trigger: "user",
    });
    return { ok: true, delivery: "sent" };
  }

  if (compactFirst) {
    if (isStandaloneBuiltinCompactCommand(request.input)) {
      throwInvalidCompactFirst("needs a message to send after compacting");
    }
    if (request.sendAt !== undefined) {
      throwInvalidCompactFirst("cannot be scheduled with sendAt");
    }
    if (request.mode === "steer") {
      throwInvalidCompactFirst("cannot steer a turn");
    }
  }
  const payload: SendMessageRequest = compactFirst
    ? { ...request, mode: "queue-if-active", compactFirst }
    : request;

  const outcome = await runWithTurnTrace(
    deps,
    { threadId: args.thread.id },
    () =>
      attemptDispatch(deps, {
        thread: args.thread,
        requestedThreadId: args.requestedThreadId,
        payload,
        source: { kind: "inline" },
        queuePayload: { kind: "inline" },
        pluginSubmission: payload.pluginSubmission ?? null,
        origin: payload.originPluginId === undefined ? null : "plugin",
        originPluginId: payload.originPluginId ?? null,
        startedOnBehalfOf: null,
        trigger: "user",
      }),
  );
  if (outcome.kind === "dispatched") {
    return { ok: true, delivery: "sent" };
  }
  return {
    ok: true,
    delivery: "queued",
    queuedMessage: outcome.entry,
  };
}

function throwInvalidCompactFirst(reason: string): never {
  throw new ApiError(400, "invalid_request", `compactFirst ${reason}`);
}
