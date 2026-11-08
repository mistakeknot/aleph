import {
  resolveHostEnvironment,
  mergeHostAndProviderEnvironment,
} from "../hosts/host-environment.js";
import { getEnvironment, getHost, getProject } from "@bb/db";
import { PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS } from "@get-bb/plugin-sdk/internal/host-policy";
import type {
  DynamicTool,
  InstructionMode,
  PermissionEscalation,
  Thread,
  ThreadTurnInitiator,
  EnvironmentStatus,
} from "@bb/domain";
import type {
  HostDaemonContributedEnvEntry,
  HostDaemonInjectedSkillSource,
} from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import { throwEnvironmentNotReady } from "../lib/lifecycle-api-errors.js";
import {
  buildRulesReceipt,
  type RulesReceiptPurpose,
  isInstructionsStoreConfigured,
  resolveUserInstructionsSection,
  type RecordedInstructionsSection,
  type RulesReceipt,
} from "./instructions-store.js";
import {
  RULES_RECEIPT_FILE_NAME,
  type PendingRulesReceipt,
} from "./rules-receipt-delivery.js";
import { requireLiveThreadStoragePath } from "./thread-storage.js";
import {
  listPluginAgentTools,
  listPluginInstructionContributions,
  getPluginSkillRootContributions,
  resolvePluginAgentConfiguration,
  resolvePluginProviderEnv,
} from "../plugins/plugin-agent-contributions.js";
import { resolveSkillCatalog } from "../skills/skill-catalog.js";
import { discoverPluginSkillIds } from "../skills/injected-skills.js";
import { UPDATE_ENVIRONMENT_DIRECTORY_TOOL } from "./thread-environment-directory.js";
import { WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH } from "./workspace-agent-instructions.js";
import { readWorkspaceAgentContext } from "./workspace-agent-context.js";
import { resolveDeprecatedWorkspaceProvisionType } from "../environments/environment-response.js";
import { markTurnTraceSpan } from "../system/turn-trace.js";

const UPDATE_ENVIRONMENT_DIRECTORY_INSTRUCTIONS =
  "If the user asks you to move this thread to another checkout, worktree, or directory, make sure the target directory exists, then call `update_environment_directory` with its absolute path. After it succeeds, end the current turn; bb starts the next turn in the updated environment automatically so you can continue there.";

export { RULES_RECEIPT_FILE_NAME };

export interface ThreadRuntimeCommandEnvironment {
  hostId: string;
  id: string;
  path: string | null;
  status: EnvironmentStatus;
}

interface ResolveThreadRuntimeCommandConfigArgs {
  environment: ThreadRuntimeCommandEnvironment;
  model: string;
  purpose?: RulesReceiptPurpose;
  thread: Thread;
}

interface ResolvePermissionEscalationArgs {
  initiator: ThreadTurnInitiator;
}

export interface ResolvedThreadRuntimeCommandConfig {
  contributedEnv: HostDaemonContributedEnvEntry[];
  dynamicTools: DynamicTool[];
  injectedSkillSources: HostDaemonInjectedSkillSource[];
  instructionMode: InstructionMode;
  instructions: string;
  projectId: string;
  providerId: string;
  pendingRulesReceipt: PendingRulesReceipt | null;
  rulesReceipt: RulesReceipt;
  threadStoragePath: string;
  workspacePath: string;
}

function requireWorkspacePath(
  environment: ThreadRuntimeCommandEnvironment,
): string {
  if (!environment.path) {
    throwEnvironmentNotReady(environment);
  }

  return environment.path;
}

interface DynamicToolContribution {
  tool: DynamicTool;
  instructions: string | null;
  pluginId: string | null;
}

function resolveDynamicTools(
  pluginTools: ReturnType<typeof listPluginAgentTools>,
): DynamicToolContribution[] {
  return [
    {
      tool: UPDATE_ENVIRONMENT_DIRECTORY_TOOL,
      instructions: UPDATE_ENVIRONMENT_DIRECTORY_INSTRUCTIONS,
      pluginId: null,
    },
    ...pluginTools.map((contribution) => ({
      tool: contribution.tool,
      instructions: contribution.instructions,
      pluginId: contribution.pluginId,
    })),
  ];
}

export function resolvePermissionEscalation(
  args: ResolvePermissionEscalationArgs,
): PermissionEscalation {
  if (args.initiator !== "user") {
    return "deny";
  }

  return "ask";
}

export async function resolveThreadRuntimeCommandConfig(
  deps: LoggedWorkSessionDeps,
  args: ResolveThreadRuntimeCommandConfigArgs,
): Promise<ResolvedThreadRuntimeCommandConfig> {
  markTurnTraceSpan("runtimeConfig.started");
  const workspacePath = requireWorkspacePath(args.environment);
  const project = getProject(deps.db, args.thread.projectId);
  if (!project) {
    throw new ApiError(404, "project_not_found", "Project not found");
  }
  const environment = getEnvironment(deps.db, args.environment.id);
  if (!environment) {
    throw new ApiError(404, "environment_not_found", "Environment not found");
  }
  const host = getHost(deps.db, args.environment.hostId);
  if (!host) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }

  const workspaceAgentContext = await readWorkspaceAgentContext(deps, {
    includeAgentInstructions: true,
    hostId: args.environment.hostId,
    workspacePath,
  });
  markTurnTraceSpan("runtimeConfig.workspaceRead");
  const pluginSkillRoots = getPluginSkillRootContributions();
  const skillIdsByPlugin = await discoverPluginSkillIds(deps.logger, {
    pluginSkillRoots,
    skillTreeRegistry: deps.skillTreeRegistry,
  });
  const conditionalConfiguration = await resolvePluginAgentConfiguration({
    context: {
      thread: {
        id: args.thread.id,
        title: args.thread.title,
        parentThreadId: args.thread.parentThreadId,
        sourceThreadId: args.thread.sourceThreadId,
      },
      project: {
        id: project.id,
        kind: project.kind,
        name: project.name,
        gitRemoteUrl: project.gitRemoteUrl,
      },
      environment: {
        id: environment.id,
        name: environment.name,
        path: environment.path,
        branchName: environment.branchName,
        workspaceProvisionType: resolveDeprecatedWorkspaceProvisionType(
          environment.environmentProviderId,
        ),
      },
      host: { id: host.id, name: host.name },
      provider: {
        id: args.thread.providerId,
        model: args.model,
        capabilities: {
          supportsNativeUserQuestion:
            deps.providerRegistry.get(args.thread.providerId)?.info.capabilities
              .supportsNativeUserQuestion ?? false,
        },
      },
      origin: {
        kind: args.thread.originKind,
        pluginId: args.thread.originPluginId,
      },
    },
    skillIdsByPlugin,
  });
  markTurnTraceSpan("runtimeConfig.pluginConfig");
  const contributedEnv = mergeHostAndProviderEnvironment(
    await resolveHostEnvironment(deps, {
      hostId: host.id,
      projectId: project.id,
    }),
    await resolvePluginProviderEnv({
      providerId: args.thread.providerId,
      context: {
        threadId: args.thread.id,
        projectId: project.id,
        hostId: host.id,
      },
    }),
  );
  markTurnTraceSpan("runtimeConfig.env");
  const injectedSkillSources = (
    await resolveSkillCatalog(deps, {
      projectSkillSources: workspaceAgentContext.projectSkillSources,
      sharedSkillSources: workspaceAgentContext.sharedSkills.runtimeSources,
      pluginSkillSelections: conditionalConfiguration.selectedSkillIdsByPlugin,
    })
  ).map((entry) => entry.runtimeSource);
  const userInstructions = await resolveUserInstructionsSection(deps);
  const dynamicToolContributions = resolveDynamicTools(
    conditionalConfiguration.tools,
  );
  const dynamicTools = dynamicToolContributions.map(
    (contribution) => contribution.tool,
  );
  const instructionSections: RecordedInstructionsSection[] = [];
  for (const contribution of dynamicToolContributions) {
    if (!contribution.instructions) continue;
    if (contribution.pluginId === null) {
      instructionSections.push({
        header: null,
        text: contribution.instructions,
      });
    } else {
      instructionSections.push({
        header: `The following instructions come from the BB plugin "${contribution.pluginId}" for its tool "${contribution.tool.name}":`,
        text: contribution.instructions,
      });
    }
  }
  for (const contribution of listPluginInstructionContributions()) {
    let text: string | null;
    try {
      text = contribution.provider({
        threadId: args.thread.id,
        projectId: args.thread.projectId,
      });
    } catch (error) {
      deps.logger.warn(
        {
          err: error,
          pluginId: contribution.pluginId,
          threadId: args.thread.id,
        },
        "Plugin instruction contribution threw; skipping",
      );
      continue;
    }
    if (text === null || text.trim().length === 0) continue;
    if (text.length > PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS) {
      text = text.slice(0, PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS);
    }
    instructionSections.push({
      header: `The following instructions come from the BB plugin "${contribution.pluginId}":`,
      text,
    });
  }
  for (const contribution of conditionalConfiguration.dynamicInstructions) {
    instructionSections.push({
      header: `The following dynamic instructions come from the BB plugin "${contribution.pluginId}":`,
      text: contribution.text,
    });
  }
  if (userInstructions) {
    instructionSections.push({
      header: userInstructions.header,
      text: userInstructions.text,
    });
  }
  if (workspaceAgentContext.agentInstructions) {
    instructionSections.push({
      header: `The following workspace instructions come from ${WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH}:`,
      text: workspaceAgentContext.agentInstructions,
    });
  }
  const instructions = instructionSections
    .flatMap((section) =>
      section.header === null ? [section.text] : [section.header, section.text],
    )
    .join("\n\n");
  const purpose = args.purpose ?? "start";
  const rulesReceipt = buildRulesReceipt({
    delivery: purpose === "dry-run" ? "dry-run" : "delivered",
    instructions,
    origin: userInstructions ?? {
      mode: null,
      snapshotId: null,
      source: "dark",
    },
    sections: instructionSections,
    threadId: args.thread.id,
  });
  const threadStoragePath = await requireLiveThreadStoragePath(deps, {
    hostId: args.environment.hostId,
    threadId: args.thread.id,
  });
  const pendingRulesReceipt: PendingRulesReceipt | null =
    purpose === "start" &&
    isInstructionsStoreConfigured(deps.config.orchestration)
      ? { receipt: rulesReceipt, threadStoragePath }
      : null;
  markTurnTraceSpan("runtimeConfig.built");
  return {
    contributedEnv,
    dynamicTools,
    injectedSkillSources,
    instructionMode: "append",
    instructions,
    projectId: args.thread.projectId,
    providerId: args.thread.providerId,
    pendingRulesReceipt,
    rulesReceipt,
    threadStoragePath,
    workspacePath,
  };
}
