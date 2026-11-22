import { mkdtemp, writeFile, mkdir, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createConnection, migrate } from "@bb/db";
import { createRigAdapter } from "./adapter.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-wrapper-"));
  const file = join(root, "rig.yaml"),
    target = join(root, "target"),
    agentHome = join(target, "rig-home");
  await writeFile(
    file,
    "apiVersion: bb.rig/v1\nkind: Rig\nmetadata: { name: test }\ncompatibility: { extensionPoints: [] }\nplugins: []\nskills: []\nagents: { claude: { settings: {}, hooks: {} }, codex: { settings: {}, hooks: {} } }\naccountPool: { settings: {}, accounts: [] }\n",
  );
  return { root, file, target, agentHome, sourceRoot: root, builtinRoot: "" };
}
describe("shared rig adapter", () => {
  it("requires a dry run token and consumes confirmation once", async () => {
    const input = await fixture(),
      a = createRigAdapter();
    await expect(
      a.apply({ ...input, confirmation: "invented" }),
    ).rejects.toThrow("Dry run");
    const plan = await a.plan(input);
    expect(plan.confirmation).not.toBe("");
    await expect(
      a.apply({ ...input, confirmation: plan.confirmation }),
    ).resolves.toHaveProperty("unsupported");
    await expect(
      a.apply({ ...input, confirmation: plan.confirmation }),
    ).rejects.toThrow("Dry run");
  });
  it("invalidates confirmation when rig bytes change", async () => {
    const input = await fixture(),
      a = createRigAdapter(),
      plan = await a.plan(input);
    await writeFile(
      input.file,
      (await readFile(input.file, "utf8")).replace(
        "name: test",
        "name: changed",
      ),
    );
    await expect(
      a.apply({ ...input, confirmation: plan.confirmation }),
    ).rejects.toThrow("changed");
  });
  it.each(["runtime", "threads", "escape"])(
    "preserves %s refusal",
    async (kind) => {
      const input = await fixture();
      await mkdir(input.target);
      if (kind === "runtime")
        await writeFile(join(input.target, "bb-app-runtime.json"), "{}");
      if (kind === "threads") {
        const db = createConnection(join(input.target, "bb.db"));
        migrate(db);
        db.$client.exec(
          "INSERT INTO projects (id,name,created_at,updated_at) VALUES ('p','test',0,0)",
        );
        db.$client.exec(
          "INSERT INTO threads (id,project_id,provider_id,title,latest_attention_at,created_at,updated_at) VALUES ('t','p','test','test',0,0,0)",
        );
        db.$client.close();
      }
      if (kind === "escape") input.agentHome = input.root;
      await expect(createRigAdapter().plan(input)).rejects.toThrow(
        "Rig operation refused",
      );
    },
  );
  it("does not overwrite exports", async () => {
    const input = await fixture(),
      a = createRigAdapter();
    await expect(a.export({ ...input, output: input.file })).rejects.toThrow(
      "Rig operation refused",
    );
  });
  it("rechecks freshness after the dry run", async () => {
    const input = await fixture(),
      a = createRigAdapter();
    const plan = await a.plan(input);
    await mkdir(input.target);
    await writeFile(join(input.target, "bb-app-runtime.json"), "{}");
    await expect(
      a.apply({ ...input, confirmation: plan.confirmation }),
    ).rejects.toThrow("Rig operation refused");
  });
  it("refuses a linked target", async () => {
    const input = await fixture();
    const elsewhere = join(input.root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, input.target);
    await expect(createRigAdapter().plan(input)).rejects.toThrow(
      "Rig operation refused",
    );
  });
  it("exports opaque warnings without the unknown scalar", async () => {
    const input = await fixture();
    await mkdir(join(input.agentHome, ".claude"), { recursive: true });
    await writeFile(
      join(input.agentHome, ".claude/settings.json"),
      JSON.stringify({ unknownSetting: "fixture-private-scalar" }),
    );
    const output = join(input.root, "export.yaml");
    const result = await createRigAdapter().export({ ...input, output });
    expect(result.notices.join("\n")).toContain("warning:");
    expect(JSON.stringify(result)).not.toContain("fixture-private-scalar");
    expect(await readFile(output, "utf8")).not.toContain(
      "fixture-private-scalar",
    );
  });
});
