import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { buildClaudeCodeModels } from "./model-list.js";

const EFFORT_LEVELS: ModelInfo["supportedEffortLevels"] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const DISCOVERED_MODELS: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Default (recommended)",
    description: "Use the default model (currently Opus 5.5 (1M context))",
    supportedEffortLevels: EFFORT_LEVELS,
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context",
    supportedEffortLevels: EFFORT_LEVELS,
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1",
    supportedEffortLevels: EFFORT_LEVELS,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5",
    supportedEffortLevels: EFFORT_LEVELS,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5",
  },
  {
    value: "claude-custom-eap[1m]",
    resolvedModel: "claude-custom-eap[1m]",
    displayName: "claude-custom-eap[1m]",
    description: "Custom model",
  },
];

describe("buildClaudeCodeModels", () => {
  it("offers exactly the models Claude Code reports, in its order", () => {
    const result = buildClaudeCodeModels(DISCOVERED_MODELS);

    expect(
      result.models.map((model) => ({
        model: model.model,
        displayName: model.displayName,
        isDefault: model.isDefault,
      })),
    ).toEqual([
      {
        model: "claude-opus-5-5[1m]",
        displayName: "Opus 5.5 (1M)",
        isDefault: true,
      },
      { model: "claude-fable-5-1", displayName: "Fable 5.1", isDefault: false },
      { model: "claude-sonnet-5", displayName: "Sonnet 5", isDefault: false },
      {
        model: "claude-haiku-4-5-20251001",
        displayName: "Haiku 4.5",
        isDefault: false,
      },
      {
        model: "claude-custom-eap[1m]",
        displayName: "claude-custom-eap[1m]",
        isDefault: false,
      },
      {
        model: "claude-fable-5-2[1m]",
        displayName: "Fable 5.2 (1M)",
        isDefault: false,
      },
    ]);
  });

  it("keeps Claude Code aliases selectable without listing them as models", () => {
    const result = buildClaudeCodeModels(DISCOVERED_MODELS);

    expect(
      result.selectedOnlyModels.map((model) => ({
        model: model.model,
        displayName: model.displayName,
      })),
    ).toEqual([
      { model: "opus[1m]", displayName: "Opus (1M context) alias" },
      { model: "claude-fable-5-1[1m]", displayName: "Fable alias" },
      { model: "sonnet", displayName: "Sonnet alias" },
      { model: "haiku", displayName: "Haiku alias" },
    ]);
  });

  it("maps reported effort levels, adding ultracode alongside xhigh", () => {
    const result = buildClaudeCodeModels(DISCOVERED_MODELS);
    const efforts = (model: string) =>
      result.models
        .find((candidate) => candidate.model === model)
        ?.supportedReasoningEfforts.map((effort) => effort.reasoningEffort);

    expect(efforts("claude-opus-5-5[1m]")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "ultracode",
      "max",
    ]);
    expect(efforts("claude-haiku-4-5-20251001")).toEqual(["low"]);
    expect(
      result.models.find((model) => model.model === "claude-opus-5-5[1m]")
        ?.defaultReasoningEffort,
    ).toBe("high");
  });

  it("marks the first model as default when Claude Code reports no default", () => {
    const result = buildClaudeCodeModels(
      DISCOVERED_MODELS.filter((model) => model.value !== "default"),
    );

    expect(result.models.filter((model) => model.isDefault)).toEqual([
      expect.objectContaining({ model: "claude-opus-5-5[1m]" }),
    ]);
  });

  it("follows Claude Code when it changes the default model", () => {
    const result = buildClaudeCodeModels([
      {
        value: "default",
        resolvedModel: "claude-sonnet-5",
        displayName: "Default (recommended)",
        description: "Sonnet 5",
      },
      ...DISCOVERED_MODELS.filter((model) => model.value !== "default"),
    ]);

    expect(result.models.find((model) => model.isDefault)?.model).toBe(
      "claude-sonnet-5",
    );
  });

  describe("Fable 5.2 fallback", () => {
    const fable52 = (models: ReturnType<typeof buildClaudeCodeModels>) =>
      models.models.filter((model) => model.model.includes("fable-5-2"));
    const reported = (value: string, resolvedModel: string): ModelInfo => ({
      value,
      resolvedModel,
      displayName: "Fable",
      description: "Fable 5.2",
      supportedEffortLevels: ["low", "high"],
    });

    it("adds the 1M variant when Claude Code does not report it", () => {
      const result = buildClaudeCodeModels(DISCOVERED_MODELS);

      expect(fable52(result)).toEqual([
        expect.objectContaining({
          id: "claude-fable-5-2[1m]",
          model: "claude-fable-5-2[1m]",
          displayName: "Fable 5.2 (1M)",
          defaultReasoningEffort: "high",
          isDefault: false,
        }),
      ]);
      expect(
        fable52(result)[0]?.supportedReasoningEfforts.map(
          (effort) => effort.reasoningEffort,
        ),
      ).toEqual(["low", "medium", "high", "xhigh", "ultracode", "max"]);
    });

    it("takes effort levels from the reported Fable 5.1 entry", () => {
      const result = buildClaudeCodeModels(
        DISCOVERED_MODELS.map((model) =>
          model.value === "claude-fable-5-1[1m]"
            ? { ...model, supportedEffortLevels: ["medium", "high"] }
            : model,
        ),
      );

      expect(
        fable52(result)[0]?.supportedReasoningEfforts.map(
          (effort) => effort.reasoningEffort,
        ),
      ).toEqual(["medium", "high"]);
    });

    it("uses a fixed effort list when Fable 5.1 is not reported", () => {
      const result = buildClaudeCodeModels(
        DISCOVERED_MODELS.filter(
          (model) => model.value !== "claude-fable-5-1[1m]",
        ),
      );

      expect(
        fable52(result)[0]?.supportedReasoningEfforts.map(
          (effort) => effort.reasoningEffort,
        ),
      ).toEqual(["low", "medium", "high", "xhigh", "ultracode", "max"]);
    });

    it.each([
      ["the 1M alias", reported("claude-fable-5-2[1m]", "claude-fable-5-2")],
      ["the bare id", reported("claude-fable-5-2", "claude-fable-5-2")],
      [
        "a 1M resolved id",
        reported("claude-fable-5-2[1m]", "claude-fable-5-2[1m]"),
      ],
    ])("adds nothing when Claude Code reports %s", (_label, info) => {
      const result = buildClaudeCodeModels([...DISCOVERED_MODELS, info]);

      expect(fable52(result)).toHaveLength(1);
      expect(fable52(result)[0]?.supportedReasoningEfforts).toHaveLength(2);
    });

    it("never becomes the default model", () => {
      const result = buildClaudeCodeModels(DISCOVERED_MODELS);

      expect(result.models.find((model) => model.isDefault)?.model).toBe(
        "claude-opus-5-5[1m]",
      );
    });
  });
});
