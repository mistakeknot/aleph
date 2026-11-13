import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  runPreRunCheck,
  supportsPreRunCheck,
  UNSUPPORTED_CHECK,
} from "./pre-run-check.js";
import { z } from "zod";
import {
  claimAutomationScheduledRun,
  closeAutomationRun,
  listDueAutomations,
  parseAutomationExecution,
  parseAutomationTrigger,
  type AutomationRow,
  type AutomationRunRow,
  type Db,
} from "./data.js";
import { publishAutomationChange } from "./realtime.js";
import type { ScriptRunScope } from "./script-runner.js";
import { computeNextScheduledTime } from "./schedule-helpers.js";
import {
  errorMessage,
  executeAgentRun,
  executeScriptRun,
  type AgentRunApi,
  type ScriptRunApi,
} from "./run.js";
import {
  createScriptWorkingDirectoryResolver,
  type ScriptWorkingDirectoryResolver,
} from "./working-directory.js";

const DUE_AUTOMATION_BATCH_SIZE = 100;
export const SWEEP_INTERVAL_MS = 10_000;

const hostListSchema = z.array(
  z.object({ status: z.enum(["connected", "disconnected"]) }).passthrough(),
);
type SweepApi = AgentRunApi &
  ScriptRunApi & {
    sdk: { hosts: { list(): Promise<unknown> } };
  };

function buildScheduleFailureHandler(
  db: Db,
  args: {
    run: AutomationRunRow;
  },
): (error: unknown) => void {
  return (error) => {
    closeAutomationRun(db, {
      runId: args.run.id,
      status: "failed",
      error: errorMessage(error),
      now: Date.now(),
    });
  };
}

async function processDueAutomation(
  bb: SweepApi,
  db: Db,
  args: {
    pluginDataDir: string;
    automation: AutomationRow;
    now: number;
    agentHostsAvailable: boolean;
    serverHostId: string | null;
    resolveWorkingDirectory: ScriptWorkingDirectoryResolver;
    scriptRuns: ScriptRunScope;
  },
): Promise<void> {
  if (args.automation.nextRunAt === null) return;
  const expectedNextRunAt = args.automation.nextRunAt;
  let newNextRunAt: number | null;
  let execution;
  try {
    const trigger = parseAutomationTrigger(args.automation.triggerConfig);
    execution = parseAutomationExecution(args.automation.execution);
    newNextRunAt =
      trigger.triggerType === "once"
        ? null
        : computeNextScheduledTime({
            cron: trigger.cron,
            now: args.now,
            timezone: trigger.timezone,
          });
  } catch (error) {
    bb.log.error(
      `Skipping due automation ${args.automation.id} with invalid stored configuration: ${errorMessage(error)}`,
    );
    return;
  }

  if (execution.mode === "agent" && !args.agentHostsAvailable) {
    return;
  }

  const claim = claimAutomationScheduledRun(db, {
    automationId: args.automation.id,
    expectedNextRunAt,
    newNextRunAt,
    now: args.now,
  });
  if (!claim.advanced) return;
  publishAutomationChange(bb, args.automation.projectId, [
    "automations-changed",
    "automation-runs-changed",
  ]);
  const onFailure = buildScheduleFailureHandler(db, {
    run: claim.run,
  });
  if (execution.mode === "agent") {
    if (execution.checkCommand !== undefined) {
      let reason: string | null = UNSUPPORTED_CHECK;
      let exitCode: number | null = null;
      let stderr = "";
      if (
        supportsPreRunCheck(execution, args.serverHostId) &&
        execution.environment.type === "host" &&
        execution.environment.workspace.type === "unmanaged" &&
        execution.environment.workspace.path !== null
      ) {
        try {
          const result = await runPreRunCheck({
            command: execution.checkCommand,
            cwd: execution.environment.workspace.path,
          });
          reason =
            result.reason ??
            (result.exitCode === 0
              ? null
              : `check exit ${result.exitCode ?? "unknown"}`);
          exitCode = result.exitCode;
          stderr = result.stderr;
        } catch {
          reason = "check failed to spawn";
        }
      }
      if (reason !== null) {
        closeAutomationRun(db, {
          runId: claim.run.id,
          status: "skipped",
          skipReason: reason,
          exitCode,
          output: stderr || null,
          now: Date.now(),
        });
        publishAutomationChange(bb, args.automation.projectId, [
          "automations-changed",
          "automation-runs-changed",
        ]);
        return;
      }
    }
    await executeAgentRun(bb, db, {
      automation: args.automation,
      run: claim.run,
      execution,
      onFailure,
    });
  } else {
    void executeScriptRun(bb, db, {
      pluginDataDir: args.pluginDataDir,
      automation: args.automation,
      run: claim.run,
      execution,
      onFailure,
      resolveWorkingDirectory: args.resolveWorkingDirectory,
      scriptRuns: args.scriptRuns,
    }).catch((error: unknown) => {
      bb.log.error(
        `Detached script automation ${args.automation.id} failed unexpectedly: ${errorMessage(error)}`,
      );
    });
  }
}

async function hasConnectedHost(
  bb: Pick<BbPluginApi, "log"> & {
    sdk: { hosts: { list(): Promise<unknown> } };
  },
): Promise<boolean> {
  try {
    return hostListSchema
      .parse(await bb.sdk.hosts.list())
      .some((host) => host.status === "connected");
  } catch (error) {
    bb.log.warn(
      `Failed to list hosts for automation sweep: ${errorMessage(error)}`,
    );
    return false;
  }
}

export async function sweepDueAutomations(
  bb: SweepApi,
  db: Db,
  args: {
    pluginDataDir: string;
    serverHostId: string | null;
    scriptRuns: ScriptRunScope;
    now?: number;
  },
): Promise<void> {
  const now = args.now ?? Date.now();
  const due = listDueAutomations(db, { now, limit: DUE_AUTOMATION_BATCH_SIZE });
  if (due.length === 0) return;
  const agentHostsAvailable = await hasConnectedHost(bb);
  const resolveWorkingDirectory = createScriptWorkingDirectoryResolver({
    sdk: bb.sdk,
    pluginDataDir: args.pluginDataDir,
    serverHostId: args.serverHostId,
  });
  for (const automation of due) {
    try {
      await processDueAutomation(bb, db, {
        pluginDataDir: args.pluginDataDir,
        automation,
        now,
        agentHostsAvailable,
        serverHostId: args.serverHostId,
        resolveWorkingDirectory,
        scriptRuns: args.scriptRuns,
      });
    } catch (error) {
      bb.log.error(
        `Failed to process due automation ${automation.id}: ${errorMessage(error)}`,
      );
    }
  }
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const settle = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", settle);
      resolve();
    };
    const timeout = setTimeout(settle, ms);
    signal.addEventListener("abort", settle, { once: true });
  });
}
