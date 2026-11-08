import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { joinHostPathSegments } from "../lib/host-path.js";
import type { RulesReceipt } from "./instructions-store.js";

export const RULES_RECEIPT_FILE_NAME = "rules-receipt.json";

const PENDING_RULES_RECEIPT = Symbol("pendingRulesReceipt");

export interface PendingRulesReceipt {
  receipt: RulesReceipt;
  threadStoragePath: string;
}

export function attachPendingRulesReceipt<TCommand extends object>(
  command: TCommand,
  pending: PendingRulesReceipt | null,
): TCommand {
  if (pending === null) {
    return command;
  }
  Object.defineProperty(command, PENDING_RULES_RECEIPT, {
    configurable: true,
    enumerable: true,
    value: pending,
    writable: true,
  });
  return command;
}

function readPendingRulesReceipt(command: object): PendingRulesReceipt | null {
  const value: unknown = Reflect.get(command, PENDING_RULES_RECEIPT);
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const receipt: unknown = Reflect.get(value, "receipt");
  const threadStoragePath: unknown = Reflect.get(value, "threadStoragePath");
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    typeof threadStoragePath !== "string"
  ) {
    return null;
  }
  return value as PendingRulesReceipt;
}

interface RecordAcceptedRulesReceiptArgs {
  command: { type: string };
  hostId: string;
  result: unknown;
}

function resultProviderResumed(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    Reflect.get(result, "providerResumed") === true
  );
}

export async function recordAcceptedRulesReceipt(
  deps: LoggedWorkSessionDeps,
  args: RecordAcceptedRulesReceiptArgs,
): Promise<void> {
  const pending = readPendingRulesReceipt(args.command);
  if (pending === null) {
    return;
  }
  let delivery: "delivered" | "resumed";
  if (args.command.type === "thread.start") {
    delivery = "delivered";
  } else if (
    args.command.type === "turn.submit" &&
    resultProviderResumed(args.result)
  ) {
    delivery = "resumed";
  } else {
    return;
  }
  const receipt: RulesReceipt = { ...pending.receipt, delivery };
  try {
    await callHostOnlineRpcForWork(deps, {
      hostId: args.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.write_file",
        path: joinHostPathSegments(
          pending.threadStoragePath,
          RULES_RECEIPT_FILE_NAME,
        ),
        rootPath: pending.threadStoragePath,
        content: `${JSON.stringify(receipt, null, 2)}\n`,
        contentEncoding: "utf8",
        createParents: true,
      },
    });
  } catch (error) {
    deps.logger.error(
      {
        err: error,
        threadId: receipt.threadId,
        delivery,
        rulesReceiptWriteFailed: true,
      },
      "The provider accepted the instructions but the rules receipt could not be written",
    );
  }
}
