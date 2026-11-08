import { z } from "zod";

import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { callHostOnlineRpcForWork } from "../hosts/online-rpc.js";
import { joinHostPathSegments } from "../lib/host-path.js";
import type { RulesReceipt } from "./instructions-store.js";

export const RULES_RECEIPT_FILE_NAME = "rules-receipt.json";

const PENDING_RULES_RECEIPT = Symbol("pendingRulesReceipt");

const instructionsSourceSchema = z.enum(["dark", "active", "lkg"]);

const instructionsTokenSchema = z
  .object({
    version: z.literal(1),
    threadId: z.string().min(1),
    snapshotId: z.string().nullable(),
    mode: z.string().nullable(),
    source: instructionsSourceSchema,
    instructionsSha256: z.string().min(1),
    instructionsBytes: z.number().int().nonnegative(),
    sections: z.array(
      z.object({
        header: z.string().nullable(),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().min(1),
      }),
    ),
  })
  .strict();

export function encodeInstructionsToken(
  receipt: Omit<RulesReceipt, "delivery">,
): string {
  const { version, threadId, snapshotId, mode, source } = receipt;
  const body = {
    version,
    threadId,
    snapshotId,
    mode,
    source,
    instructionsSha256: receipt.instructionsSha256,
    instructionsBytes: receipt.instructionsBytes,
    sections: receipt.sections,
  };
  return Buffer.from(JSON.stringify(body), "utf8").toString("base64url");
}

export function decodeInstructionsToken(
  token: unknown,
  threadId: string,
): Omit<RulesReceipt, "delivery"> | null {
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  try {
    const json: unknown = JSON.parse(
      Buffer.from(token, "base64url").toString("utf8"),
    );
    const parsed = instructionsTokenSchema.safeParse(json);
    if (!parsed.success || parsed.data.threadId !== threadId) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

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

function resultInstalledInstructionsToken(result: unknown): unknown {
  return typeof result === "object" && result !== null
    ? Reflect.get(result, "installedInstructionsToken")
    : undefined;
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
  const installed =
    delivery === "resumed"
      ? decodeInstructionsToken(
          resultInstalledInstructionsToken(args.result),
          pending.receipt.threadId,
        )
      : null;
  const receipt: RulesReceipt = {
    ...(installed ?? pending.receipt),
    delivery,
  };
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
