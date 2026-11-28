import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import claudeCodePlugin from "../server.js";
import { buildSessionOptions } from "./bridge/session-options.js";
import { buildClaudeSessionParams } from "./session-params.js";
import { z } from "zod";

it.each(["5m", "1h", undefined] as const)(
  "derives only the current thread's cache TTL %s into Claude Settings",
  (promptCacheTtl) => {
    const host = createFakePluginHost({ pluginId: "provider-claude-code" });
    claudeCodePlugin(host.bb);
    const declaration = host.harness.registrations.providerRegistrations.find(
      (entry) => entry.id === "claude-code",
    )!;
    const derive = (ttl?: "5m" | "1h") =>
      declaration.deriveProviderOptions!({
        threadId: "thread",
        projectId: "project",
        model: "claude-sonnet-5",
        permissionMode: "full",
        settings: {},
        ...(ttl === undefined ? {} : { promptCacheTtl: ttl }),
      });
    const params = buildClaudeSessionParams({
      threadId: "thread",
      cwd: ".",
      instructionMode: "append",
      options: {
        model: "claude-sonnet-5",
        permissionMode: "full",
        permissionScope: "full",
        approvalReviewer: null,
        permissionEscalation: null,
        providerOptions: derive(promptCacheTtl),
      },
    });
    const options = buildSessionOptions(
      {
        cwd: ".",
        instructionMode: "append",
        permissionMode: "bypassPermissions",
        permissionScope: "full",
        serviceTier: "default",
        workflowsEnabled: true,
        chromeEnabled: false,
        disable1MContext: false,
        artifactsEnabled: false,
        sandboxEnabled: true,
        promptCacheTtl: z
          .enum(["5m", "1h"])
          .optional()
          .parse(params.promptCacheTtl),
      },
      {},
    );
    if (promptCacheTtl === undefined) {
      expect(options.settings).not.toHaveProperty("promptCacheTtl");
    } else {
      expect(options.settings).toHaveProperty("promptCacheTtl", promptCacheTtl);
    }
    expect(derive()).not.toHaveProperty("promptCacheTtl");
    expect(host.harness.registrations.settingsDescriptors).not.toHaveProperty(
      "promptCacheTtl",
    );
  },
);
