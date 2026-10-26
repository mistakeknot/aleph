import { listThreadIdsInEnvironment, type DbQueryConnection } from "@bb/db";
import type {
  HostDaemonCommand,
  HostDaemonSettledCommandType,
} from "@bb/host-daemon-contract";
import {
  emptyCommandResultSideEffects,
  type CommandResultReportForType,
  type CommandResultSettlementDeps,
  type CommandResultSideEffectsResult,
  type HostDaemonCommandExecutionRecord,
} from "./command-result-side-effects.js";
import {
  settleEnvironmentProvisionCancelCommandResult,
  settleEnvironmentProvisionCommandResult,
} from "../services/environments/environment-engine.js";
import {
  settleThreadPlanCancelCommandResult,
  settleThreadStartCommandResult,
  settleThreadStorageDeleteCommandResult,
  settleThreadStopCommandResult,
  settleTurnSubmitCommandResult,
} from "../services/threads/thread-lifecycle.js";
import { notifyWorkspaceMutationResult } from "./environment-changes.js";

type ParsedCommandType = HostDaemonSettledCommandType;
type ParsedCommandForType<TType extends ParsedCommandType> = Extract<
  HostDaemonCommand,
  { type: TType }
>;

interface ApplyCommandResultSideEffectsArgs<TType extends ParsedCommandType> {
  command: ParsedCommandForType<TType>;
  deps: CommandResultSettlementDeps;
  execution: HostDaemonCommandExecutionRecord;
  report: CommandResultReportForType<TType>;
}

type CommandResultSideEffectHandlers = {
  [TType in ParsedCommandType]?: (
    args: ApplyCommandResultSideEffectsArgs<TType>,
  ) => CommandResultSideEffectsResult | void;
};

const commandResultSideEffectHandlers: CommandResultSideEffectHandlers = {
  "environment.attach": settleEnvironmentProvisionCommandResult,
  "environment.attach.cancel": settleEnvironmentProvisionCancelCommandResult,
  "interactive.resolve": ({ deps, command, report }) => {
    deps.pendingInteractions.settleInteractiveResolveCommandResultInTransaction(
      {
        command,
        deps,
        report,
      },
    );
  },
  "thread.start": settleThreadStartCommandResult,
  "thread.stop": settleThreadStopCommandResult,
  "thread.storage.delete": settleThreadStorageDeleteCommandResult,
  "thread.plan.cancel": settleThreadPlanCancelCommandResult,
  "turn.submit": settleTurnSubmitCommandResult,
  "workspace.commit": ({ deps, command, report }) => {
    notifyWorkspaceMutationResult(deps, {
      environmentId: command.environmentId,
      ok: report.ok,
    });
  },
} satisfies CommandResultSideEffectHandlers;

export interface SettlementThreadSelection {
  deletedFastPath: boolean;
  select: (db: DbQueryConnection) => readonly string[];
}

const DELETED_FAST_PATH_COMMAND_TYPES: ReadonlySet<ParsedCommandType> = new Set(
  ["environment.attach", "thread.storage.delete", "thread.plan.cancel"],
);

export function selectSettlementThreads(
  command: HostDaemonCommand,
): SettlementThreadSelection {
  const deletedFastPath = DELETED_FAST_PATH_COMMAND_TYPES.has(
    command.type as ParsedCommandType,
  );
  if (
    command.type === "environment.attach" ||
    command.type === "environment.attach.cancel"
  ) {
    const environmentId = command.environmentId;
    return {
      deletedFastPath,
      select: (db) => listThreadIdsInEnvironment(db, environmentId),
    };
  }
  if ("threadId" in command && typeof command.threadId === "string") {
    const threadId = command.threadId;
    return { deletedFastPath, select: () => [threadId] };
  }
  return { deletedFastPath, select: () => [] };
}

export function handleLiveCommandResultSideEffects<
  TType extends ParsedCommandType,
>(
  deps: CommandResultSettlementDeps,
  args: {
    command: ParsedCommandForType<TType>;
    execution: HostDaemonCommandExecutionRecord;
    report: CommandResultReportForType<TType>;
  },
): CommandResultSideEffectsResult {
  const handler = commandResultSideEffectHandlers[args.command.type];
  if (!handler) {
    return emptyCommandResultSideEffects();
  }

  return (
    handler({
      deps,
      report: args.report,
      command: args.command,
      execution: args.execution,
    }) ?? emptyCommandResultSideEffects()
  );
}
