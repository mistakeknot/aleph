import { it, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rigRpcContract } from "./contract.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-handlers-"));
  const file = join(root, "rig.yaml"),
    target = join(root, "target");
  await writeFile(
    file,
    "apiVersion: bb.rig/v1\nkind: Rig\nmetadata: { name: test }\ncompatibility: { extensionPoints: [] }\nplugins: []\nskills: []\nagents: { claude: { settings: {}, hooks: {} }, codex: { settings: {}, hooks: {} } }\naccountPool: { settings: {}, accounts: [] }\n",
  );
  return {
    file,
    target,
    agentHome: join(target, "home"),
    sourceRoot: root,
    builtinRoot: "",
  };
}

it.each(["rpc", "cli"] as const)(
  "plans, confirms and rejects replay through %s",
  async (transport) => {
    const host = createFakePluginHost();
    plugin(host.bb);
    const c = await fixture();
    const flags = [
      "--file",
      c.file,
      "--target",
      c.target,
      "--agent-home",
      c.agentHome,
      "--source-root",
      c.sourceRoot,
    ];
    const raw =
      transport === "rpc"
        ? await host.harness.callRpc("plan", c)
        : JSON.parse(
            (await host.harness.runCli(["apply", ...flags, "--dry-run"]))
              .stdout,
          );
    const plan = rigRpcContract.plan.output.parse(raw);
    if (transport === "rpc") {
      await expect(
        host.harness.callRpc("apply", {
          ...c,
          confirmation: plan.confirmation,
        }),
      ).resolves.toHaveProperty("changes");
      await expect(
        host.harness.callRpc("apply", {
          ...c,
          confirmation: plan.confirmation,
        }),
      ).rejects.toThrow("Dry run");
    } else {
      expect(
        (
          await host.harness.runCli([
            "apply",
            ...flags,
            "--confirm",
            plan.confirmation,
          ])
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await host.harness.runCli([
            "apply",
            ...flags,
            "--confirm",
            plan.confirmation,
          ])
        ).exitCode,
      ).not.toBe(0);
    }
  },
);

it.each(["rpc", "cli"] as const)(
  "keeps runtime-marker refusal through %s",
  async (transport) => {
    const host = createFakePluginHost();
    plugin(host.bb);
    const c = await fixture();
    await mkdir(c.target);
    await writeFile(join(c.target, "bb-app-runtime.json"), "{}");
    if (transport === "rpc")
      await expect(host.harness.callRpc("plan", c)).rejects.toThrow(
        "Rig operation refused",
      );
    else
      expect(
        (
          await host.harness.runCli([
            "apply",
            "--file",
            c.file,
            "--target",
            c.target,
            "--agent-home",
            c.agentHome,
            "--dry-run",
          ])
        ).exitCode,
      ).not.toBe(0);
  },
);

it("exposes typed diff and refuses apply without a dry run through CLI and RPC", async () => {
  const host = createFakePluginHost();
  await plugin(host.bb);
  const context = {
    file: "/rig.yaml",
    target: "/target",
    agentHome: "/target/home",
    sourceRoot: "",
    builtinRoot: "",
  };
  await expect(
    host.harness.callRpc("apply", { ...context, confirmation: "unknown" }),
  ).rejects.toThrow("Dry run");
  const result = await host.harness.runCli([
    "apply",
    "--file",
    context.file,
    "--target",
    context.target,
    "--agent-home",
    context.agentHome,
  ]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Dry run");
  await expect(host.harness.callRpc("diff", context)).rejects.toThrow(
    "Rig operation refused",
  );
});
