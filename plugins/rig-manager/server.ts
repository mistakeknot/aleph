import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createRigAdapter, type RigContext } from "./adapter.js";
import { rigRpcContract } from "./contract.js";

export default function rigManager(bb: BbPluginApi) {
  bb.settings.define({
    rigPath: {
      type: "string",
      label: "Rig file path",
      description: "Absolute path on the server host. Aleph only.",
    },
    targetPath: {
      type: "string",
      label: "Target data directory",
      description:
        "Separate installation to inspect. Apply requires a fresh stopped target.",
    },
    agentHome: {
      type: "string",
      label: "Provider home",
      description:
        "Absolute provider home; apply confines it inside the target.",
    },
    sourceRoot: { type: "string", label: "Source root", default: "" },
    builtinRoot: { type: "string", label: "Builtin plugin root", default: "" },
  });
  const adapter = createRigAdapter();
  bb.rpc.register(rigRpcContract, {
    diff: adapter.diff,
    export: adapter.export,
    plan: adapter.plan,
    apply: adapter.apply,
  });
  const paths = {
    file: { type: "string", description: "Absolute rig path", required: true },
    target: {
      type: "string",
      description: "Explicit absolute data directory",
      required: true,
    },
    "agent-home": {
      type: "string",
      description: "Absolute provider home",
      required: true,
    },
    "source-root": { type: "string", description: "Absolute source root" },
    "builtin-root": {
      type: "string",
      description: "Absolute target builtin root",
    },
  } as const;
  function context(
    options: Record<string, string | boolean | string[] | undefined>,
  ): RigContext {
    const text = (key: string) =>
      typeof options[key] === "string" ? options[key] : "";
    return {
      file: text("file"),
      target: text("target"),
      agentHome: text("agent-home"),
      sourceRoot: text("source-root"),
      builtinRoot: text("builtin-root"),
    };
  }
  bb.cli.register(
    defineCli({
      name: "rig",
      summary: "Inspect and transfer rigs on Aleph only",
      commands: {
        diff: cliCommand({
          summary: "Compare without exposing settings values",
          options: paths,
          async run(input) {
            const result = await adapter.diff(context(input.options));
            return {
              exitCode:
                result.changes.length || result.unsupported.length ? 1 : 0,
              stdout: JSON.stringify(result),
            };
          },
        }),
        export: cliCommand({
          summary: "Export to an explicit new file",
          options: {
            ...paths,
            output: {
              type: "string",
              required: true,
              description: "Absolute new output path",
            },
          },
          async run(input) {
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                await adapter.export({
                  ...context(input.options),
                  output: input.options.output,
                }),
              ),
            };
          },
        }),
        apply: cliCommand({
          summary:
            "Dry run first, then confirm the returned token within five minutes",
          options: {
            ...paths,
            "dry-run": { type: "boolean", description: "Plan without writes" },
            confirm: {
              type: "string",
              description: "One-use confirmation from dry run",
            },
          },
          async run(input) {
            const c = context(input.options);
            if (input.options["dry-run"] && input.options.confirm)
              throw new Error("Choose dry run or confirmation");
            const result = input.options["dry-run"]
              ? await adapter.plan(c)
              : await adapter.apply({
                  ...c,
                  confirmation: input.options.confirm ?? "",
                });
            return { exitCode: 0, stdout: JSON.stringify(result) };
          },
        }),
      },
    }),
  );
}
