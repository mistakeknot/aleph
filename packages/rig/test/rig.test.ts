import { mkdtemp, mkdir, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import { applyRig, diffRig, exportRig, parseRig } from "../src/index.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "rig-"));
  const dataDir = join(root, "bb");
  const agentHome = join(dataDir, "rig-home");
  await mkdir(dataDir);
  await mkdir(join(agentHome, ".claude"), { recursive: true });
  const db = createMigratedConnection();
  await writeFile(join(dataDir, "bb.db"), db.$client.serialize());
  db.$client.close();
  return { root, dataDir, agentHome };
}
const document = () => ({
  apiVersion: "bb.rig/v1",
  kind: "Rig",
  metadata: { name: "example" },
  compatibility: { extensionPoints: [] },
  plugins: [],
  skills: [],
  agents: {
    claude: { settings: {}, hooks: {} },
    codex: { settings: {}, hooks: {} },
  },
  accountPool: { settings: {}, accounts: [] },
});

describe("rig", () => {
  it("validates the version and rejects inline sensitive fields without echoing input", () => {
    expect(() => parseRig({ ...document(), apiVersion: "other" })).toThrow();
    expect(() =>
      parseRig({
        ...document(),
        agents: {
          claude: { settings: { apiKey: "inline value" }, hooks: {} },
          codex: { settings: {}, hooks: {} },
        },
      }),
    ).toThrow("reference");
  });
  it("rejects unknown fields and duplicate identities", () => {
    expect(() => parseRig({ ...document(), extra: true })).toThrow();
    expect(() =>
      parseRig({
        ...document(),
        plugins: [
          {
            id: "one",
            source: { builtin: "one" },
            version: "1.0.0",
            enabled: true,
            settings: {},
          },
          {
            id: "one",
            source: { builtin: "one" },
            version: "1.0.0",
            enabled: true,
            settings: {},
          },
        ],
      }),
    ).toThrow();
  });
  it("exports native Claude/Codex settings and converts sensitive fields to references", async () => {
    const f = await fixture();
    await writeFile(
      join(f.agentHome, ".claude/settings.json"),
      JSON.stringify({
        apiKey: { secretRef: "env:EXAMPLE_KEY" },
        permissions: { defaultMode: "default" },
        hooks: { PreToolUse: [] },
      }),
    );
    const result = await exportRig(f);
    expect(result.rig.agents.claude.settings.apiKey).toEqual({
      secretRef: "env:EXAMPLE_KEY",
    });
    expect(result.rig.agents.claude.hooks).toEqual({ PreToolUse: [] });
    expect((await diffRig(result.rig, f)).changes).toEqual([]);
  });
  it("applies idempotently to a fresh target and dry run writes nothing", async () => {
    const f = await fixture();
    const rig = parseRig({
      ...document(),
      agents: {
        claude: {
          settings: { permissions: { defaultMode: "default" } },
          hooks: { PreToolUse: [] },
        },
        codex: { settings: { approval_policy: "on-request" }, hooks: {} },
      },
    });
    expect(
      (await applyRig(rig, { ...f, target: f.dataDir, dryRun: true })).changes
        .length,
    ).toBeGreaterThan(0);
    await expect(
      readFile(join(f.agentHome, ".claude/settings.json")),
    ).rejects.toThrow();
    await applyRig(rig, { ...f, target: f.dataDir, dryRun: false });
    expect(
      (await applyRig(rig, { ...f, target: f.dataDir, dryRun: false })).changes,
    ).toEqual([]);
    expect((await diffRig(rig, f)).changes).toEqual([]);
  });
  it("round trips named references without resolving or writing credential values", async () => {
    const f = await fixture();
    const rig = parseRig({
      ...document(),
      agents: {
        claude: {
          settings: { apiKey: { secretRef: "env:EXAMPLE_KEY" } },
          hooks: {},
        },
        codex: { settings: {}, hooks: {} },
      },
    });
    await applyRig(rig, { ...f, target: f.dataDir, dryRun: false });
    const result = await exportRig(f);
    expect(result.rig.agents.claude.settings.apiKey).toEqual({
      secretRef: "env:EXAMPLE_KEY",
    });
    await expect(
      readFile(join(f.agentHome, ".claude/settings.json")),
    ).rejects.toThrow();
    expect((await diffRig(rig, f)).changes).toEqual([]);
  });
  it("reports pool unsupported on stock bb and applies other sections", async () => {
    const f = await fixture();
    const rig = parseRig({
      ...document(),
      accountPool: { settings: { switchThreshold: 0.9 }, accounts: [] },
      agents: {
        claude: {
          settings: { permissions: { defaultMode: "default" } },
          hooks: {},
        },
        codex: { settings: {}, hooks: {} },
      },
    });
    const result = await applyRig(rig, {
      ...f,
      target: f.dataDir,
      dryRun: false,
    });
    expect(result.unsupported).toContain("accountPool");
    expect(
      JSON.parse(
        await readFile(join(f.agentHome, ".claude/settings.json"), "utf8"),
      ).permissions.defaultMode,
    ).toBe("default");
  });
  it("refuses an unnamed target and agent paths outside the target", async () => {
    const f = await fixture();
    await expect(
      applyRig(parseRig(document()), {
        ...f,
        target: join(f.root, "different"),
        dryRun: false,
      }),
    ).rejects.toThrow("target");
  });
  it("refuses symlink targets", async () => {
    const f = await fixture();
    const link = join(f.root, "link");
    await symlink(f.dataDir, link);
    await expect(
      applyRig(parseRig(document()), {
        dataDir: link,
        agentHome: f.agentHome,
        target: link,
        dryRun: false,
      }),
    ).rejects.toThrow();
  });
});

it("installs a local plugin and skill into a fresh fixture and converges", async () => {
  const f = await fixture();
  const source = join(f.root, "sources", "plugin");
  const skill = join(f.root, "sources", "skill");
  await mkdir(source, { recursive: true });
  await mkdir(skill, { recursive: true });
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "bb-plugin-example", version: "1.0.0", bb: {} }),
  );
  await writeFile(
    join(skill, "SKILL.md"),
    "---\nname: example\ndescription: A fixture skill.\n---\nUse fixture data.\n",
  );
  const rig = parseRig({
    ...document(),
    plugins: [
      {
        id: "example",
        source: { path: "sources/plugin" },
        version: "1.0.0",
        enabled: true,
        settings: { mode: "local" },
      },
    ],
    skills: [
      {
        id: "example",
        source: { path: "sources/skill" },
        targets: ["claude", "codex"],
      },
    ],
  });
  const install = { ...f, rigDir: f.root, target: f.dataDir, dryRun: false };
  await applyRig(rig, install);
  expect((await diffRig(rig, install)).changes).toEqual([]);
  expect((await applyRig(rig, install)).changes).toEqual([]);
  expect(
    await readFile(
      join(f.agentHome, ".claude/skills/example/SKILL.md"),
      "utf8",
    ),
  ).toContain("fixture data");
});
it("removes native settings drift and reports added and removed entries", async () => {
  const f = await fixture();
  await writeFile(
    join(f.agentHome, ".claude/settings.json"),
    JSON.stringify({ permissions: { defaultMode: "default" } }),
  );
  const rig = parseRig(document());
  await applyRig(rig, { ...f, target: f.dataDir, dryRun: false });
  expect((await diffRig(rig, f)).changes).toEqual([]);
});
it("plans an absent target without writes, then initializes and converges", async () => {
  const root = await mkdtemp(join(tmpdir(), "rig-new-"));
  const dataDir = join(root, "bb");
  const agentHome = join(dataDir, "rig-home");
  const rig = parseRig({
    ...document(),
    agents: {
      claude: {
        settings: { permissions: { defaultMode: "default" } },
        hooks: {},
      },
      codex: { settings: {}, hooks: {} },
    },
  });
  expect(
    (await applyRig(rig, { dataDir, agentHome, target: dataDir, dryRun: true }))
      .changes.length,
  ).toBeGreaterThan(0);
  await expect(readFile(join(dataDir, "bb.db"))).rejects.toThrow();
  await applyRig(rig, { dataDir, agentHome, target: dataDir, dryRun: false });
  expect((await diffRig(rig, { dataDir, agentHome })).changes).toEqual([]);
});
it("refuses external provider homes and symlinked database paths", async () => {
  const f = await fixture();
  const rig = parseRig(document());
  await expect(
    applyRig(rig, {
      ...f,
      agentHome: join(f.root, "outside"),
      target: f.dataDir,
      dryRun: false,
    }),
  ).rejects.toThrow("outside");
  const other = join(f.root, "other");
  await mkdir(other);
  await symlink(join(f.dataDir, "bb.db"), join(other, "bb.db"));
  await expect(
    applyRig(rig, {
      dataDir: other,
      agentHome: join(other, "rig-home"),
      target: other,
      dryRun: false,
    }),
  ).rejects.toThrow();
});
it("exports native pool settings and account metadata without opening credential files", async () => {
  const f = await fixture();
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(f.dataDir, "bb.db"));
  db.prepare(
    "INSERT INTO plugins(id,source,source_kind,source_builtin_name,root_dir,version,enabled,installed_at,updated_at) VALUES('account-pool','builtin:account-pool','builtin','account-pool',?,'1.0.0',1,0,0)",
  ).run(f.dataDir);
  db.prepare(
    "INSERT INTO plugin_kv(plugin_id,key,value,updated_at) VALUES('account-pool','config',?,0)",
  ).run(JSON.stringify({ switchThreshold: 0.9 }));
  const id = "11111111-1111-4111-8111-111111111111";
  db.prepare(
    "INSERT INTO plugin_kv(plugin_id,key,value,updated_at) VALUES('account-pool','accounts:v1',?,0)",
  ).run(
    JSON.stringify([
      {
        id,
        provider: "claude",
        kind: "api-key",
        label: "example",
        enabled: true,
        priority: 0,
        createdAt: 0,
        lastUsedAt: null,
        lastUsedHostId: null,
        email: null,
        subscriptionType: null,
        rateLimitTier: null,
      },
    ]),
  );
  db.close();
  const rig = (await exportRig(f)).rig;
  expect(rig.accountPool.accounts[0]?.credential.secretRef).toMatch(/^store:/u);
  expect(rig.accountPool.settings.switchThreshold).toBe(0.9);
  rig.accountPool.settings.switchThreshold = 0.8;
  await applyRig(rig, { ...f, target: f.dataDir, dryRun: false });
  expect((await diffRig(rig, f)).changes).toEqual([]);
});
it("rejects unverified extension requirements", async () => {
  const f = await fixture();
  await expect(
    applyRig(
      parseRig({
        ...document(),
        compatibility: { extensionPoints: ["example@1"] },
      }),
      { ...f, target: f.dataDir, dryRun: true },
    ),
  ).rejects.toThrow("extension points");
});
it("refuses dangling symlinks and hard links before any target write", async () => {
  const f = await fixture();
  await symlink(
    join(f.root, "missing"),
    join(f.agentHome, ".claude/settings.json"),
  );
  const rig = parseRig({
    ...document(),
    agents: {
      claude: {
        settings: { permissions: { defaultMode: "default" } },
        hooks: {},
      },
      codex: { settings: {}, hooks: {} },
    },
  });
  await expect(
    applyRig(rig, { ...f, target: f.dataDir, dryRun: false }),
  ).rejects.toThrow();
});
it("exports nested global skills as source entries", async () => {
  const f = await fixture();
  await mkdir(join(f.agentHome, ".agents/skills/collection/example"), {
    recursive: true,
  });
  await writeFile(
    join(f.agentHome, ".agents/skills/collection/example/SKILL.md"),
    "Fixture instructions.",
  );
  const result = await exportRig({ ...f, rigDir: f.root });
  expect(
    result.rig.skills.some((s) => s.id === "agents.collection.example"),
  ).toBe(true);
});
it("does not let a secret binding hide unrelated native plugin drift", async () => {
  const f = await fixture();
  const source = join(f.root, "plugin");
  await mkdir(source);
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "bb-plugin-example", version: "1.0.0", bb: {} }),
  );
  const rig = parseRig({
    ...document(),
    plugins: [
      {
        id: "example",
        source: { path: "plugin" },
        version: "1.0.0",
        enabled: true,
        settings: { apiKey: { secretRef: "env:EXAMPLE_KEY" }, mode: "local" },
      },
    ],
  });
  const install = { ...f, rigDir: f.root, target: f.dataDir, dryRun: false };
  await applyRig(rig, install);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(f.dataDir, "bb.db"));
  db.prepare("UPDATE plugins SET enabled=0 WHERE id='example'").run();
  db.close();
  expect(
    (await diffRig(rig, install)).changes.some((c) => c.section === "plugins"),
  ).toBe(true);
});
it("archives removed skills and removes plugin settings drift", async () => {
  const f = await fixture();
  const skill = join(f.root, "skill");
  const source = join(f.root, "plugin");
  await mkdir(skill);
  await mkdir(source);
  await writeFile(join(skill, "SKILL.md"), "Fixture skill.");
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({ name: "bb-plugin-example", version: "1.0.0", bb: {} }),
  );
  const first = parseRig({
    ...document(),
    skills: [{ id: "example", source: { path: "skill" }, targets: ["claude"] }],
    plugins: [
      {
        id: "example",
        source: { path: "plugin" },
        version: "1.0.0",
        enabled: true,
        settings: { mode: "local" },
      },
    ],
  });
  const install = { ...f, rigDir: f.root, target: f.dataDir, dryRun: false };
  await applyRig(first, install);
  const next = parseRig(document());
  await applyRig(next, install);
  expect((await diffRig(next, install)).changes).toEqual([]);
  expect((await applyRig(next, install)).changes).toEqual([]);
});
it("detects edited managed skill content and repairs it", async () => {
  const f = await fixture();
  const source = join(f.root, "skill");
  await mkdir(source);
  await writeFile(join(source, "SKILL.md"), "Original fixture instructions.");
  const rig = parseRig({
    ...document(),
    skills: [{ id: "example", source: { path: "skill" }, targets: ["claude"] }],
  });
  const install = { ...f, rigDir: f.root, target: f.dataDir, dryRun: false };
  await applyRig(rig, install);
  await writeFile(
    join(f.agentHome, ".claude/skills/example/SKILL.md"),
    "Edited fixture instructions.",
  );
  expect(
    (await diffRig(rig, install)).changes.some((c) => c.section === "skills"),
  ).toBe(true);
  await applyRig(rig, install);
  expect((await diffRig(rig, install)).changes).toEqual([]);
});
it("CLI export and diff expose 0, 1 and 2 exit statuses on fixtures", async () => {
  const f = await fixture();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const cli = new URL("../src/cli.ts", import.meta.url).pathname;
  const invoke = (args: string[]) =>
    run(process.execPath, ["--import", "tsx", cli, ...args], {
      env: {
        ...process.env,
        HOME: f.root,
        CODEX_HOME: join(f.agentHome, ".codex"),
        CLAUDE_CONFIG_DIR: join(f.agentHome, ".claude"),
      },
    });
  const file = join(f.root, "rig.yaml");
  const paths = ["--data-dir", f.dataDir, "--agent-home", f.agentHome];
  await invoke(["export", ...paths, "--output", file]);
  expect((await invoke(["diff", file, ...paths])).stdout).toContain(
    "No changes",
  );
  await writeFile(
    join(f.agentHome, ".claude/settings.json"),
    JSON.stringify({ permissions: { defaultMode: "default" } }),
  );
  await expect(invoke(["diff", file, ...paths])).rejects.toMatchObject({
    code: 1,
  });
  await expect(
    invoke(["diff", join(f.root, "absent.yaml"), ...paths]),
  ).rejects.toMatchObject({ code: 2 });
});
it("rejects source traversal and unresolved hook placeholders", () => {
  expect(() =>
    parseRig({
      ...document(),
      plugins: [
        {
          id: "example",
          source: {
            git: "https://example.test/source.git",
            ref: "a".repeat(40),
            subdir: "../escape",
          },
          version: "1.0.0",
          enabled: true,
          settings: {},
        },
      ],
    }),
  ).toThrow();
});
it("refuses a placeholder Codex hook event during validation", () => {
  expect(() =>
    parseRig({
      ...document(),
      agents: {
        claude: { settings: {}, hooks: {} },
        codex: { settings: {}, hooks: { "<supported-event>": [] } },
      },
    }),
  ).toThrow("reference");
});

it("skips dangling skill aliases and aliases to ordinary files", async () => {
  const f = await fixture();
  const root = join(f.agentHome, ".agents/skills");
  await mkdir(root, { recursive: true });
  await symlink(join(f.root, "missing"), join(root, "dangling"));
  await writeFile(join(f.root, "ordinary.txt"), "Fixture text.");
  await symlink(join(f.root, "ordinary.txt"), join(root, "ordinary"));
  expect((await exportRig(f)).rig.skills).toEqual([]);
});

it("omits unrecognized scalar settings without copying their values", async () => {
  const f = await fixture();
  const marker = "fixture-private";
  await writeFile(
    join(f.agentHome, ".claude/settings.json"),
    JSON.stringify({
      unrecognizedOption: marker,
      permissions: { defaultMode: "default" },
    }),
  );
  const result = await exportRig(f);
  expect(JSON.stringify(result.rig)).not.toContain(marker);
  expect(result.rig.agents.claude.settings.permissions).toEqual({
    defaultMode: "default",
  });
  expect(
    result.references.some(
      (r) => r.includes("warning") && r.includes("store:rig/"),
    ),
  ).toBe(true);
});
it("references argv and command payloads with unknown or sensitive arguments", async () => {
  const f = await fixture();
  const marker = "fixture-private";
  await writeFile(
    join(f.agentHome, ".claude/settings.json"),
    JSON.stringify({
      args: ["--x", marker],
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: "command", command: `tool --password ${marker}` }],
          },
        ],
      },
    }),
  );
  const result = await exportRig(f);
  expect(JSON.stringify(result.rig)).not.toContain(marker);
  expect(result.rig.agents.claude.settings.args).toMatchObject({
    secretRef: expect.any(String),
  });
  expect(result.references.length).toBeGreaterThanOrEqual(2);
});
it("lists unsafe native map keys as skipped while exporting supported settings", async () => {
  const f = await fixture();
  const unsafe = "K".repeat(64);
  await writeFile(
    join(f.agentHome, ".claude/settings.json"),
    JSON.stringify({
      [unsafe]: "fixture-private",
      permissions: { defaultMode: "default" },
    }),
  );
  const result = await exportRig(f);
  expect(JSON.stringify(result)).not.toContain(unsafe);
  expect(JSON.stringify(result)).not.toContain("fixture-private");
  expect(result.rig.agents.claude.settings.permissions).toEqual({
    defaultMode: "default",
  });
  expect(result.references.some((r) => r.includes("warning"))).toBe(true);
});
it("keeps a long executable path and known boolean command flags", async () => {
  const f = await fixture();
  const command =
    "/usr/local/lib/node_modules/example-package/scripts/check-policy";
  await writeFile(
    join(f.agentHome, ".claude/settings.json"),
    JSON.stringify({ command, args: ["--check", "--json"] }),
  );
  const result = await exportRig(f);
  expect(result.rig.agents.claude.settings.command).toBe(command);
  expect(result.rig.agents.claude.settings.args).toEqual(["--check", "--json"]);
});
it("refuses unknown raw scalar and argv values in a hand-authored rig", () => {
  for (const settings of [
    { unrecognizedOption: "fixture-private" },
    { args: ["--x", "fixture-private"] },
  ]) {
    expect(() =>
      parseRig({
        ...document(),
        agents: {
          claude: { settings, hooks: {} },
          codex: { settings: {}, hooks: {} },
        },
      }),
    ).toThrow();
  }
});
it("does not reuse account metadata keys as trusted agent settings", async () => {
  const f = await fixture();
  await writeFile(
    join(f.agentHome, ".claude/settings.json"),
    JSON.stringify({
      label: "fixture-private",
      permissions: "fixture-private",
    }),
  );
  const result = await exportRig(f);
  expect(JSON.stringify(result.rig)).not.toContain("fixture-private");
  expect(result.rig.agents.claude.settings.permissions).toMatchObject({
    secretRef: expect.any(String),
  });
});
it("suppresses an unsafe secret filename in reference diagnostics", async () => {
  const f = await fixture();
  const unsafe = "K".repeat(64);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(f.dataDir, "bb.db"));
  db.prepare(
    "INSERT INTO plugins(id,source,source_kind,source_builtin_name,root_dir,version,enabled,installed_at,updated_at) VALUES('example','builtin:example','builtin','example',?,'1.0.0',1,0,0)",
  ).run(f.dataDir);
  db.close();
  const secrets = join(f.dataDir, "plugins/example/secrets");
  await mkdir(secrets, { recursive: true });
  await writeFile(join(secrets, unsafe), "");
  await writeFile(join(secrets, "fixture unsafe name"), "");
  const result = JSON.stringify(await exportRig(f));
  expect(result).not.toContain("fixture unsafe name");
  expect(result).not.toContain(unsafe);
});
it("round trips an explicit unknown-key reference through its dormant binding", async () => {
  const f = await fixture();
  const rig = parseRig({
    ...document(),
    agents: {
      claude: {
        settings: { customOption: { secretRef: "env:EXAMPLE_KEY" } },
        hooks: {},
      },
      codex: { settings: {}, hooks: {} },
    },
  });
  await applyRig(rig, { ...f, target: f.dataDir, dryRun: false });
  expect((await exportRig(f)).rig.agents.claude.settings.customOption).toEqual({
    secretRef: "env:EXAMPLE_KEY",
  });
  expect((await diffRig(rig, f)).changes).toEqual([]);
});
