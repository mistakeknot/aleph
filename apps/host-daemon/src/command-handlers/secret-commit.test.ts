import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SECRET_REFUSAL_MESSAGES,
  allowlistEntrySha256,
  canonicalJson,
  commitSecretValues,
  probeSecretDestination,
  type SecretCommitStep,
  type SecretRefusalReason,
  type SecretWriterConfig,
} from "./secret-commit.js";

type Probe = Parameters<typeof probeSecretDestination>[0];
type Commit = Parameters<typeof commitSecretValues>[0];

const UID = process.getuid?.() ?? 0;
const NOW = 1_800_000_000_000;
const TTL = 3_600_000;
const CANARY_ONE = "canary-seeded-0f3a9c71d2";
const CANARY_TWO = "canary-submitted-8b41e6d05a";

interface Fixture {
  root: string;
  home: string;
  project: string;
  envPath: string;
  allowlistPath: string;
  config: SecretWriterConfig;
}

let fixture: Fixture;
let clock = NOW;

async function writeAllowlist(
  entries: unknown,
  mode = 0o644,
  at = fixture.allowlistPath,
): Promise<void> {
  await fs.writeFile(at, JSON.stringify({ entries }));
  await fs.chmod(at, mode);
}

function defaultEntry(envPath: string) {
  return {
    project: "demo",
    path: envPath,
    names: ["API_ONE", "API_TWO"],
    consumer: "demo-app",
  };
}

beforeEach(async () => {
  clock = NOW;
  const root = fsSync.realpathSync(
    await fs.mkdtemp(path.join(os.tmpdir(), "secret-commit-")),
  );
  const home = path.join(root, "home");
  const project = path.join(home, "proj");
  const etc = path.join(root, "etc");
  await fs.mkdir(project, { recursive: true, mode: 0o700 });
  await fs.chmod(project, 0o700);
  await fs.mkdir(etc, { mode: 0o755 });
  await fs.chmod(etc, 0o755);
  const envPath = path.join(project, ".env");
  fixture = {
    root,
    home,
    project,
    envPath,
    allowlistPath: path.join(etc, "allowlist.json"),
    config: {
      allowlistPath: path.join(etc, "allowlist.json"),
      allowlistOwnerUid: UID,
      homeDir: home,
      trustedUid: UID,
      now: () => clock,
    },
  };
  await writeAllowlist([defaultEntry(envPath)]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(fixture.root, { recursive: true, force: true });
});

function probeCommand(overrides: Partial<Probe> = {}): Probe {
  return {
    type: "host.secret_probe",
    requestId: randomUUID(),
    threadId: "thr_test",
    hostId: "host_test",
    project: "demo",
    path: fixture.envPath,
    fields: [
      { name: "API_ONE", description: "first" },
      { name: "API_TWO", description: null },
    ],
    purpose: "unit test",
    expiresAtMs: NOW + TTL,
    ...overrides,
  };
}

async function probeReady(overrides: Partial<Probe> = {}) {
  const command = probeCommand(overrides);
  const result = await probeSecretDestination(command, fixture.config);
  if (result.outcome !== "ready") {
    throw new Error(`probe refused: ${result.reason}`);
  }
  return { command, probe: result };
}

function commitFrom(
  command: Probe,
  probe: Awaited<ReturnType<typeof probeReady>>["probe"],
  values: Record<string, string>,
  overrides: Partial<Commit> = {},
): Commit {
  const { type: _type, ...binding } = command;
  void _type;
  return {
    type: "host.secret_commit",
    ...binding,
    requestDigest: probe.requestDigest,
    parent: probe.parent,
    file: probe.file,
    allowlistEntrySha256: probe.allowlistEntrySha256,
    values,
    ...overrides,
  };
}

const VALUES = { API_ONE: "fake-one-value", API_TWO: "fake-two-value" };

async function readEnv(): Promise<string> {
  return fs.readFile(fixture.envPath, "utf8");
}

async function writeEnv(content: string, mode = 0o600): Promise<void> {
  await fs.writeFile(fixture.envPath, content, { mode });
  await fs.chmod(fixture.envPath, mode);
}

async function swapEnv(content: string): Promise<void> {
  const sibling = path.join(fixture.project, "swap-sibling");
  await fs.writeFile(sibling, content, { mode: 0o600 });
  await fs.rename(sibling, fixture.envPath);
}

async function tmpOrphans(): Promise<string[]> {
  return (await fs.readdir(fixture.project)).filter((name) =>
    name.startsWith(".bb-secret-"),
  );
}

function expectRefused(
  result: { outcome: string },
  reason: SecretRefusalReason,
) {
  expect(result).toEqual({
    outcome: "refused",
    reason,
    message: SECRET_REFUSAL_MESSAGES[reason],
  });
}

function sha(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("canonical JSON and entry hash", () => {
  it("sorts keys and rejects non-integers", () => {
    expect(canonicalJson({ b: 1, a: ["x", null, true] })).toBe(
      '{"a":["x",null,true],"b":1}',
    );
    expect(() => canonicalJson(1.5)).toThrow();
  });

  it("hashes an allowlist entry independent of name order", () => {
    const a = allowlistEntrySha256({
      project: "p",
      path: "/x",
      names: ["B", "A"],
      consumer: "c",
    });
    const b = allowlistEntrySha256({
      project: "p",
      path: "/x",
      names: ["A", "B"],
      consumer: "c",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("probe (T1.2 request-time refusals)", () => {
  it("is ready for an absent file and for a present 0600 file", async () => {
    const absent = await probeReady();
    expect(absent.probe.file).toBeNull();
    expect(absent.probe.existingNames).toEqual([]);
    expect(absent.probe.consumer).toBe("demo-app");
    expect(absent.probe.requestDigest).toMatch(/^[0-9a-f]{64}$/);

    await writeEnv("API_ONE=seeded\nOTHER=1\n");
    const present = await probeReady();
    expect(present.probe.file).not.toBeNull();
    expect(present.probe.existingNames).toEqual(["API_ONE"]);
  });

  it("returns names but never values", async () => {
    await writeEnv(`API_ONE=${CANARY_ONE}\n`);
    const { probe } = await probeReady();
    expect(JSON.stringify(probe)).not.toContain(CANARY_ONE);
  });

  it("refuses a symlinked directory component", async () => {
    const real = path.join(fixture.home, "real");
    await fs.mkdir(real, { mode: 0o700 });
    const link = path.join(fixture.home, "link");
    await fs.symlink(real, link);
    const linked = path.join(link, ".env");
    await writeAllowlist([defaultEntry(linked)]);
    expectRefused(
      await probeSecretDestination(
        probeCommand({ path: linked }),
        fixture.config,
      ),
      "symlink-in-path",
    );
  });

  it("refuses a symlinked target file", async () => {
    const other = path.join(fixture.project, "other.env");
    await fs.writeFile(other, "X=1\n", { mode: 0o600 });
    await fs.symlink(other, fixture.envPath);
    expectRefused(
      await probeSecretDestination(probeCommand(), fixture.config),
      "file-ownership",
    );
  });

  it("refuses a file that is not mode 0600", async () => {
    await writeEnv("API_ONE=x\n", 0o644);
    expectRefused(
      await probeSecretDestination(probeCommand(), fixture.config),
      "file-ownership",
    );
  });

  it("refuses a hard-linked file", async () => {
    await writeEnv("API_ONE=x\n");
    await fs.link(fixture.envPath, path.join(fixture.project, "alias"));
    expectRefused(
      await probeSecretDestination(probeCommand(), fixture.config),
      "file-ownership",
    );
  });

  it("refuses a file owned by another uid", async () => {
    await writeEnv("API_ONE=x\n");
    expectRefused(
      await probeSecretDestination(probeCommand(), {
        ...fixture.config,
        trustedUid: UID + 1,
      }),
      "parent-ownership",
    );
  });

  it("refuses a parent that is not mode 0700", async () => {
    await fs.chmod(fixture.project, 0o750);
    expectRefused(
      await probeSecretDestination(probeCommand(), fixture.config),
      "parent-ownership",
    );
  });

  it("refuses a missing parent", async () => {
    const missing = path.join(fixture.home, "nope", ".env");
    await writeAllowlist([defaultEntry(missing)]);
    expectRefused(
      await probeSecretDestination(
        probeCommand({ path: missing }),
        fixture.config,
      ),
      "parent-missing",
    );
  });

  it("refuses an expired request", async () => {
    expectRefused(
      await probeSecretDestination(
        probeCommand({ expiresAtMs: NOW }),
        fixture.config,
      ),
      "expired",
    );
  });

  it("refuses a name or project that is not allowlisted", async () => {
    expectRefused(
      await probeSecretDestination(
        probeCommand({
          fields: [{ name: "NOT_LISTED", description: null }],
        }),
        fixture.config,
      ),
      "not-allowlisted",
    );
    expectRefused(
      await probeSecretDestination(
        probeCommand({ project: "other" }),
        fixture.config,
      ),
      "not-allowlisted",
    );
  });

  it("refuses a path that is not allowlisted", async () => {
    const other = path.join(fixture.project, ".env.other");
    expectRefused(
      await probeSecretDestination(
        probeCommand({ path: other }),
        fixture.config,
      ),
      "not-allowlisted",
    );
  });

  it("refuses non-normalized and relative paths", async () => {
    for (const bad of [
      "relative/.env",
      `${fixture.project}/../proj/.env`,
      `${fixture.project}//.env`,
      `${fixture.project}/./.env`,
      `${fixture.project}/.env/`,
      "/.env",
    ]) {
      expectRefused(
        await probeSecretDestination(
          probeCommand({ path: bad }),
          fixture.config,
        ),
        "path-not-normalized",
      );
    }
  });

  it("refuses a destination outside the home directory", async () => {
    const outside = path.join(fixture.root, "elsewhere", ".env");
    expectRefused(
      await probeSecretDestination(
        probeCommand({ path: outside }),
        fixture.config,
      ),
      "outside-home",
    );
  });

  it("refuses credential stores even when allowlisted", async () => {
    for (const rel of [
      ".ssh/id.env",
      ".claude/x.env",
      ".config/gh/hosts.env",
      ".config/jev/x.env",
      ".bb/x/.env",
    ]) {
      const dest = path.join(fixture.home, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await writeAllowlist([defaultEntry(dest)]);
      expectRefused(
        await probeSecretDestination(
          probeCommand({ path: dest }),
          fixture.config,
        ),
        "credential-store",
      );
    }
  });

  it("refuses duplicate field names", async () => {
    expectRefused(
      await probeSecretDestination(
        probeCommand({
          fields: [
            { name: "API_ONE", description: null },
            { name: "API_ONE", description: null },
          ],
        }),
        fixture.config,
      ),
      "invalid-request",
    );
  });

  it("refuses a file with duplicate assignments", async () => {
    await writeEnv("API_ONE=a\nAPI_ONE=b\n");
    const { command, probe } = await probeReady();
    const result = await commitSecretValues(
      commitFrom(command, probe, VALUES),
      fixture.config,
    );
    expectRefused(result, "unreconcilable-file");
    expect(await readEnv()).toBe("API_ONE=a\nAPI_ONE=b\n");
  });
});

describe("allowlist trust (D3a)", () => {
  it("refuses a group- or world-writable allowlist", async () => {
    for (const mode of [0o664, 0o666, 0o620, 0o602]) {
      await writeAllowlist([defaultEntry(fixture.envPath)], mode);
      expectRefused(
        await probeSecretDestination(probeCommand(), fixture.config),
        "allowlist-untrusted",
      );
    }
  });

  it("refuses an allowlist in a writable directory", async () => {
    await fs.chmod(path.dirname(fixture.allowlistPath), 0o777);
    expectRefused(
      await probeSecretDestination(probeCommand(), fixture.config),
      "allowlist-untrusted",
    );
  });

  it("refuses an allowlist not owned by the trusted owner", async () => {
    expectRefused(
      await probeSecretDestination(probeCommand(), {
        ...fixture.config,
        allowlistOwnerUid: UID + 1,
      }),
      "allowlist-untrusted",
    );
  });

  it("refuses a symlinked allowlist and a missing or malformed one", async () => {
    const real = path.join(fixture.root, "real-allowlist.json");
    await fs.rename(fixture.allowlistPath, real);
    await fs.symlink(real, fixture.allowlistPath);
    expectRefused(
      await probeSecretDestination(probeCommand(), fixture.config),
      "allowlist-unavailable",
    );
    await fs.rm(fixture.allowlistPath);
    expectRefused(
      await probeSecretDestination(probeCommand(), fixture.config),
      "allowlist-unavailable",
    );
    await fs.writeFile(fixture.allowlistPath, "{not json");
    await fs.chmod(fixture.allowlistPath, 0o644);
    expectRefused(
      await probeSecretDestination(probeCommand(), fixture.config),
      "allowlist-unavailable",
    );
    await fs.writeFile(
      fixture.allowlistPath,
      JSON.stringify({ entries: [], extra: 1 }),
    );
    expectRefused(
      await probeSecretDestination(probeCommand(), fixture.config),
      "allowlist-unavailable",
    );
  });

  it("the agent's own request cannot add an entry", async () => {
    const other = path.join(fixture.project, "new.env");
    expectRefused(
      await probeSecretDestination(
        probeCommand({ path: other }),
        fixture.config,
      ),
      "not-allowlisted",
    );
    const entries = JSON.parse(
      await fs.readFile(fixture.allowlistPath, "utf8"),
    ) as { entries: unknown[] };
    expect(entries.entries).toHaveLength(1);
  });
});

describe("commit (T1.4)", () => {
  it("creates an absent file with mode 0600 and leaves no tmp file", async () => {
    const { command, probe } = await probeReady();
    const result = await commitSecretValues(
      commitFrom(command, probe, VALUES),
      fixture.config,
    );
    expect(result).toEqual({
      outcome: "written",
      added: 2,
      updated: 0,
      unchanged: 0,
    });
    expect(await readEnv()).toContain("API_ONE='fake-one-value'");
    expect(await readEnv()).toContain("API_TWO='fake-two-value'");
    expect((await fs.stat(fixture.envPath)).mode & 0o777).toBe(0o600);
    expect(await tmpOrphans()).toEqual([]);
  });

  it("merges into a present file and keeps unrelated lines byte-identical", async () => {
    const original =
      "# comment\n\nUNRELATED=keep me\nexport OTHER='quoted value'\nAPI_ONE=old\n";
    await writeEnv(original);
    const { command, probe } = await probeReady();
    const result = await commitSecretValues(
      commitFrom(command, probe, VALUES),
      fixture.config,
    );
    expect(result).toEqual({
      outcome: "written",
      added: 1,
      updated: 1,
      unchanged: 0,
    });
    const after = await readEnv();
    for (const line of [
      "# comment",
      "",
      "UNRELATED=keep me",
      "export OTHER='quoted value'",
    ]) {
      expect(after.split("\n")).toContain(line);
    }
    expect(after).toContain("API_ONE='fake-one-value'");
    expect(after).not.toContain("API_ONE=old");
    expect((await fs.stat(fixture.envPath)).mode & 0o777).toBe(0o600);
    expect(await tmpOrphans()).toEqual([]);
  });

  it("writes no .env.prev backup (D4a)", async () => {
    await writeEnv("API_ONE=old\n");
    const { command, probe } = await probeReady();
    await commitSecretValues(
      commitFrom(command, probe, VALUES),
      fixture.config,
    );
    expect((await fs.readdir(fixture.project)).sort()).toEqual([".env"]);
  });

  it("replaces the file by rename, so the inode changes", async () => {
    await writeEnv("API_ONE=old\n");
    const before = (await fs.stat(fixture.envPath)).ino;
    const { command, probe } = await probeReady();
    await commitSecretValues(
      commitFrom(command, probe, VALUES),
      fixture.config,
    );
    expect((await fs.stat(fixture.envPath)).ino).not.toBe(before);
  });

  it("refuses values that do not match the requested names", async () => {
    const { command, probe } = await probeReady();
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, { API_ONE: "x" }),
        fixture.config,
      ),
      "invalid-request",
    );
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, { ...VALUES, EXTRA: "x" }),
        fixture.config,
      ),
      "invalid-request",
    );
    await expect(fs.stat(fixture.envPath)).rejects.toThrow();
  });
});

describe("commit binding (T1.2)", () => {
  it.each([
    ["purpose", { purpose: "changed" }],
    ["thread", { threadId: "thr_other" }],
    ["host", { hostId: "host_other" }],
    ["request id", { requestId: randomUUID() }],
    ["expiry", { expiresAtMs: NOW + TTL - 1 }],
    [
      "descriptions",
      {
        fields: [
          { name: "API_ONE", description: "changed" },
          { name: "API_TWO", description: null },
        ],
      },
    ],
  ] as const)("refuses a changed %s", async (_label, change) => {
    const { command, probe } = await probeReady();
    const result = await commitSecretValues(
      commitFrom(command, probe, VALUES, change as Partial<Commit>),
      fixture.config,
    );
    expectRefused(result, "digest-mismatch");
    await expect(fs.stat(fixture.envPath)).rejects.toThrow();
  });

  it("refuses a forged digest and a forged identity", async () => {
    const { command, probe } = await probeReady();
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, VALUES, { requestDigest: "0".repeat(64) }),
        fixture.config,
      ),
      "digest-mismatch",
    );
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, VALUES, {
          parent: { dev: "1", ino: "1" },
        }),
        fixture.config,
      ),
      "digest-mismatch",
    );
  });

  it("refuses when the allowlist entry changed since the request", async () => {
    const { command, probe } = await probeReady();
    await writeAllowlist([
      { ...defaultEntry(fixture.envPath), consumer: "other" },
    ]);
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, VALUES),
        fixture.config,
      ),
      "allowlist-changed",
    );
  });

  it("refuses when the file was replaced after the request", async () => {
    await writeEnv("API_ONE=old\n");
    const { command, probe } = await probeReady();
    await swapEnv("API_ONE=old\n");
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, VALUES),
        fixture.config,
      ),
      "identity-changed",
    );
    expect(await readEnv()).toBe("API_ONE=old\n");
  });

  it("refuses when the file appeared after an absent probe", async () => {
    const { command, probe } = await probeReady();
    await writeEnv("PLANTED=1\n");
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, VALUES),
        fixture.config,
      ),
      "identity-changed",
    );
    expect(await readEnv()).toBe("PLANTED=1\n");
  });

  it("refuses when the file vanished after a present probe", async () => {
    await writeEnv("API_ONE=old\n");
    const { command, probe } = await probeReady();
    await fs.rm(fixture.envPath);
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, VALUES),
        fixture.config,
      ),
      "identity-changed",
    );
    await expect(fs.stat(fixture.envPath)).rejects.toThrow();
  });

  it("refuses when the parent directory was swapped after the request", async () => {
    const { command, probe } = await probeReady();
    await fs.rename(fixture.project, `${fixture.project}.old`);
    await fs.mkdir(fixture.project, { mode: 0o700 });
    await fs.chmod(fixture.project, 0o700);
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, VALUES),
        fixture.config,
      ),
      "identity-changed",
    );
    expect(await fs.readdir(fixture.project)).toEqual([]);
  });

  it("refuses when the parent became a symlink", async () => {
    const { command, probe } = await probeReady();
    await fs.rename(fixture.project, `${fixture.project}.old`);
    await fs.symlink(`${fixture.project}.old`, fixture.project);
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, VALUES),
        fixture.config,
      ),
      "symlink-in-path",
    );
    expect(await fs.readdir(`${fixture.project}.old`)).toEqual([]);
  });

  it("refuses an expired commit and writes nothing", async () => {
    const { command, probe } = await probeReady();
    clock = NOW + TTL;
    expectRefused(
      await commitSecretValues(
        commitFrom(command, probe, VALUES),
        fixture.config,
      ),
      "expired",
    );
    await expect(fs.stat(fixture.envPath)).rejects.toThrow();
    expect(await tmpOrphans()).toEqual([]);
  });

  it("a re-ask yields a new digest, and the old digest cannot be reused", async () => {
    const first = await probeReady();
    const second = await probeReady();
    expect(second.probe.requestDigest).not.toBe(first.probe.requestDigest);
    expectRefused(
      await commitSecretValues(
        commitFrom(second.command, second.probe, VALUES, {
          requestDigest: first.probe.requestDigest,
        }),
        fixture.config,
      ),
      "digest-mismatch",
    );
  });
});

describe("commit-time substitutions (T1.2)", () => {
  async function runWithHook(
    action: Partial<Record<SecretCommitStep, () => Promise<void>>>,
    seed?: string,
  ) {
    if (seed !== undefined) await writeEnv(seed);
    const { command, probe } = await probeReady();
    const config: SecretWriterConfig = {
      ...fixture.config,
      afterStep: async (step) => {
        await action[step]?.();
      },
    };
    return commitSecretValues(commitFrom(command, probe, VALUES), config);
  }

  it("aborts when an equal-content sibling takes the name before the check", async () => {
    const seed = "API_ONE=old\nKEEP=1\n";
    const result = await runWithHook(
      {
        "tmp-written": async () => {
          await swapEnv(seed);
        },
      },
      seed,
    );
    expectRefused(result, "identity-changed");
    expect(await readEnv()).toBe(seed);
    expect(await tmpOrphans()).toEqual([]);
  });

  it("aborts when the target becomes a symlink before the check", async () => {
    const victim = path.join(fixture.project, "victim.txt");
    await fs.writeFile(victim, "victim\n", { mode: 0o600 });
    const result = await runWithHook(
      {
        "tmp-written": async () => {
          await fs.rm(fixture.envPath);
          await fs.symlink(victim, fixture.envPath);
        },
      },
      "API_ONE=old\n",
    );
    expectRefused(result, "file-ownership");
    expect(await fs.readFile(victim, "utf8")).toBe("victim\n");
    expect(await tmpOrphans()).toEqual([]);
  });

  it("fails with target-appeared when an absent target is created meanwhile", async () => {
    const result = await runWithHook({
      "tmp-written": async () => {
        await writeEnv("PLANTED=1\n");
      },
    });
    expect(result.outcome).toBe("refused");
    expect(await readEnv()).toBe("PLANTED=1\n");
    expect(await tmpOrphans()).toEqual([]);
  });

  it("reports target-appeared when the file appears between the check and the link", async () => {
    const result = await runWithHook({
      "pre-rename-check": async () => {
        await writeEnv("PLANTED=1\n");
      },
    });
    expectRefused(result, "target-appeared");
    expect(await readEnv()).toBe("PLANTED=1\n");
    expect(await tmpOrphans()).toEqual([]);
  });

  it("reports committed-elsewhere when the parent is renamed after the fd was held", async () => {
    const result = await runWithHook({
      "parent-open": async () => {
        await fs.rename(fixture.project, `${fixture.project}.moved`);
        await fs.mkdir(fixture.project, { mode: 0o700 });
        await fs.chmod(fixture.project, 0o700);
      },
    });
    expect(result.outcome).toBe("committed-elsewhere");
    expect(await fs.readdir(fixture.project)).toEqual([]);
    expect(
      await fs.readFile(`${fixture.project}.moved/.env`, "utf8"),
    ).toContain("API_ONE='fake-one-value'");
  });

  it("reports committed-elsewhere when the parent path becomes a symlink", async () => {
    const result = await runWithHook({
      "parent-open": async () => {
        await fs.rename(fixture.project, `${fixture.project}.moved`);
        await fs.symlink(`${fixture.project}.moved`, fixture.project);
      },
    });
    expect(result.outcome).toBe("committed-elsewhere");
  });

  it("reports replaced-after-commit when the entry is replaced after the rename", async () => {
    const result = await runWithHook(
      {
        renamed: async () => {
          await fs.rm(fixture.envPath);
          await writeEnv("API_ONE=attacker\n");
        },
      },
      "API_ONE=old\n",
    );
    expect(result.outcome).toBe("replaced-after-commit");
  });

  it("reports replaced-after-commit when the entry disappears after the rename", async () => {
    const result = await runWithHook({
      renamed: async () => {
        await fs.rm(fixture.envPath);
      },
    });
    expect(result.outcome).toBe("replaced-after-commit");
  });

  it("documents the residual: a swap between the check and the rename is overwritten", async () => {
    const result = await runWithHook(
      {
        "pre-rename-check": async () => {
          await swapEnv("API_ONE=swapped\n");
        },
      },
      "API_ONE=old\n",
    );
    expect(result.outcome).toBe("written");
    expect(await readEnv()).toContain("API_ONE='fake-one-value'");
    expect(await readEnv()).not.toContain("swapped");
  });

  it("serializes concurrent commits to one path", async () => {
    await writeEnv("API_ONE=old\n");
    const first = await probeReady();
    const second = await probeReady();
    const results = await Promise.all([
      commitSecretValues(
        commitFrom(first.command, first.probe, VALUES),
        fixture.config,
      ),
      commitSecretValues(
        commitFrom(second.command, second.probe, VALUES),
        fixture.config,
      ),
    ]);
    const outcomes = results.map((result) => result.outcome).sort();
    expect(outcomes).toEqual(["refused", "written"]);
    expect(await tmpOrphans()).toEqual([]);
  });
});

describe("no leak of existing or submitted values (T1.3)", () => {
  async function listAll(dir: string): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await listAll(full)));
      else out.push(full);
    }
    return out;
  }

  it("keeps canaries out of results, errors, logs, env and other files", async () => {
    const writes: string[] = [];
    for (const stream of [process.stdout, process.stderr] as const) {
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof stream.write);
    }
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        writes.push(args.map(String).join(" "));
      }),
    );
    await writeEnv(`UNRELATED=${CANARY_ONE}\nAPI_ONE=${CANARY_ONE}\n`);
    const { command, probe } = await probeReady();
    const results: unknown[] = [probe];
    results.push(
      await commitSecretValues(
        commitFrom(command, probe, {
          API_ONE: CANARY_TWO,
          API_TWO: `${CANARY_TWO}-2`,
        }),
        fixture.config,
      ),
    );
    await writeEnv(`API_ONE=${CANARY_ONE}\nAPI_ONE=${CANARY_ONE}-b\n`);
    const conflict = await probeReady();
    results.push(
      await commitSecretValues(
        commitFrom(conflict.command, conflict.probe, {
          API_ONE: CANARY_TWO,
          API_TWO: CANARY_TWO,
        }),
        fixture.config,
      ),
    );
    results.push(
      await commitSecretValues(
        commitFrom(conflict.command, conflict.probe, VALUES, {
          requestDigest: "f".repeat(64),
        }),
        fixture.config,
      ),
    );
    clock = NOW + TTL;
    results.push(
      await commitSecretValues(
        commitFrom(conflict.command, conflict.probe, {
          API_ONE: CANARY_TWO,
          API_TWO: CANARY_TWO,
        }),
        fixture.config,
      ),
    );
    consoleSpies.forEach((spy) => spy.mockRestore());

    const serialized = JSON.stringify(results);
    for (const canary of [CANARY_ONE, CANARY_TWO]) {
      expect(serialized).not.toContain(canary);
      expect(writes.join("\n")).not.toContain(canary);
      expect(JSON.stringify(process.env)).not.toContain(canary);
    }
    for (const file of await listAll(fixture.root)) {
      if (file === fixture.envPath) continue;
      const text = await fs.readFile(file, "utf8");
      expect(text).not.toContain(CANARY_ONE);
      expect(text).not.toContain(CANARY_TWO);
    }
    expect(await tmpOrphans()).toEqual([]);
  });

  it("a hard failure surfaces only a fixed internal-error message", async () => {
    const { command, probe } = await probeReady();
    const result = await commitSecretValues(
      commitFrom(command, probe, VALUES),
      {
        ...fixture.config,
        afterStep: () => {
          throw new Error(`boom ${CANARY_TWO}`);
        },
      },
    );
    expectRefused(result, "internal-error");
    expect(JSON.stringify(result)).not.toContain(CANARY_TWO);
    expect(await tmpOrphans()).toEqual([]);
  });
});

describe("digest shape", () => {
  it("is a 64 hex digest that binds the canonical fields", async () => {
    const { command, probe } = await probeReady();
    const expected = sha(
      canonicalJson({
        allowlist_entry_sha256: probe.allowlistEntrySha256,
        dest_realpath: fixture.envPath,
        descriptions: { API_ONE: "first", API_TWO: null },
        expires_at: command.expiresAtMs,
        file: null,
        host_id: command.hostId,
        names: ["API_ONE", "API_TWO"],
        parent: probe.parent,
        purpose: command.purpose,
        request_id: command.requestId,
        thread_id: command.threadId,
      }),
    );
    expect(probe.requestDigest).toBe(expected);
  });
});
