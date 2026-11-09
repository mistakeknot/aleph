import {
  HIGH_REASONING_EFFORT,
  LOW_REASONING_EFFORT,
  MAX_REASONING_EFFORT,
  MEDIUM_REASONING_EFFORT,
  ULTRACODE_REASONING_EFFORT,
  XHIGH_REASONING_EFFORT,
  type AvailableModel,
  type ModelReasoningEffort,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

const CLAUDE_MODEL_ID_PATTERN =
  /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[1m\])?$/;

function deriveClaudeModelDisplayName(model: string): string | null {
  const match = CLAUDE_MODEL_ID_PATTERN.exec(model);
  if (!match) {
    return null;
  }
  const [, family = "", major, minor, oneMillionContext] = match;
  const name = `${family.charAt(0).toUpperCase()}${family.slice(1)}`;
  const version = minor === undefined ? major : `${major}.${minor}`;
  return `${name} ${version}${oneMillionContext ? " (1M)" : ""}`;
}

function buildReasoningEfforts(modelInfo: ModelInfo): ModelReasoningEffort[] {
  const efforts: readonly ModelReasoningEffort[] = modelInfo
    .supportedEffortLevels?.length
    ? modelInfo.supportedEffortLevels.flatMap((level) => {
        switch (level) {
          case "low":
            return [LOW_REASONING_EFFORT];
          case "medium":
            return [MEDIUM_REASONING_EFFORT];
          case "high":
            return [HIGH_REASONING_EFFORT];
          case "xhigh":
            return [XHIGH_REASONING_EFFORT, ULTRACODE_REASONING_EFFORT];
          case "max":
            return [MAX_REASONING_EFFORT];
        }
      })
    : [LOW_REASONING_EFFORT];
  return efforts.map((effort) => ({ ...effort }));
}

function buildModel(
  modelInfo: ModelInfo,
  model: string,
  displayName: string,
): AvailableModel {
  const supportedReasoningEfforts = buildReasoningEfforts(modelInfo);
  const supportedLevels = supportedReasoningEfforts.map(
    (effort) => effort.reasoningEffort,
  );
  const defaultReasoningEffort = supportedLevels.includes("high")
    ? "high"
    : supportedLevels.includes("medium")
      ? "medium"
      : (supportedLevels[0] ?? "low");
  return {
    id: model,
    model,
    displayName,
    description: modelInfo.description,
    reasoningDiscovery: "known",
    supportedReasoningEfforts,
    defaultReasoningEffort,
    isDefault: false,
  };
}

const FABLE_5_2_MODEL = "claude-fable-5-2";
const FABLE_5_2_ONE_MILLION_MODEL = `${FABLE_5_2_MODEL}[1m]`;
const FABLE_5_1_MODEL = "claude-fable-5-1";
const FABLE_5_2_FALLBACK_EFFORT_LEVELS: ModelInfo["supportedEffortLevels"] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

function stripOneMillionSuffix(model: string): string {
  return model.endsWith("[1m]") ? model.slice(0, -"[1m]".length) : model;
}

function reportsModel(modelInfo: ModelInfo, model: string): boolean {
  return (
    stripOneMillionSuffix(modelInfo.value) === model ||
    stripOneMillionSuffix(modelInfo.resolvedModel ?? "") === model
  );
}

function buildFable52Fallback(
  discoveredModels: readonly ModelInfo[],
): AvailableModel | null {
  if (discoveredModels.some((info) => reportsModel(info, FABLE_5_2_MODEL))) {
    return null;
  }
  const fable51 = discoveredModels.find((info) =>
    reportsModel(info, FABLE_5_1_MODEL),
  );
  return buildModel(
    {
      value: FABLE_5_2_ONE_MILLION_MODEL,
      resolvedModel: FABLE_5_2_MODEL,
      displayName: "Fable",
      description: "Fable 5.2",
      supportedEffortLevels:
        fable51?.supportedEffortLevels ?? FABLE_5_2_FALLBACK_EFFORT_LEVELS,
    },
    FABLE_5_2_ONE_MILLION_MODEL,
    deriveClaudeModelDisplayName(FABLE_5_2_ONE_MILLION_MODEL) ?? "Fable 5.2",
  );
}

interface ListClaudeCodeModelsResult {
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

export function buildClaudeCodeModels(
  discoveredModels: readonly ModelInfo[],
): ListClaudeCodeModelsResult {
  const defaultModel =
    discoveredModels.find((modelInfo) => modelInfo.value === "default")
      ?.resolvedModel ?? null;
  const models: AvailableModel[] = [];
  for (const modelInfo of [
    ...discoveredModels.filter((candidate) => candidate.value !== "default"),
    ...discoveredModels.filter((candidate) => candidate.value === "default"),
  ]) {
    const model = modelInfo.resolvedModel ?? modelInfo.value;
    if (models.some((candidate) => candidate.model === model)) {
      continue;
    }
    models.push(
      buildModel(
        modelInfo,
        model,
        deriveClaudeModelDisplayName(model) ?? modelInfo.displayName,
      ),
    );
  }
  const fable52Fallback = buildFable52Fallback(discoveredModels);
  if (fable52Fallback !== null) {
    models.push(fable52Fallback);
  }
  const selectedOnlyModels: AvailableModel[] = [];
  for (const modelInfo of discoveredModels) {
    const alias = modelInfo.value;
    if (
      alias === "default" ||
      models.some((candidate) => candidate.model === alias) ||
      selectedOnlyModels.some((candidate) => candidate.model === alias)
    ) {
      continue;
    }
    selectedOnlyModels.push(
      buildModel(modelInfo, alias, `${modelInfo.displayName} alias`),
    );
  }
  const resolvedDefault =
    defaultModel !== null &&
    models.some((candidate) => candidate.model === defaultModel)
      ? defaultModel
      : models[0]?.model;
  return {
    models: models.map((model) =>
      model.model === resolvedDefault ? { ...model, isDefault: true } : model,
    ),
    selectedOnlyModels,
  };
}
