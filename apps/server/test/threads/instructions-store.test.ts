import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import {
  buildExecutionOptions,
  buildThreadStartCommand,
} from "../../src/services/threads/thread-commands.js";
import {
  INSTRUCTIONS_STUB_MARKER,
  type RulesReceipt,
} from "../../src/services/threads/instructions-store.js";
import {
  RULES_RECEIPT_FILE_NAME,
  resolveThreadRuntimeCommandConfig,
} from "../../src/services/threads/thread-runtime-config.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

const FAKE_RESOLVE_SCRIPT = `
import fs from "node:fs";
const [, , scenarioPath, ...rest] = process.argv;
const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8"));
const countPath = scenarioPath + ".count";
let count = 0;
try { count = Number(fs.readFileSync(countPath, "utf8")); } catch {}
fs.writeFileSync(countPath, String(count + 1));
fs.appendFileSync(scenarioPath + ".args", JSON.stringify(rest) + "\\n");
const step = scenario.steps[Math.min(count, scenario.steps.length - 1)];
if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs));
if (step.exit) {
  process.stderr.write(step.stderr ?? "");
  process.exit(step.exit);
}
process.stdout.write(step.raw ?? JSON.stringify(step.result));
`;

const USER_HEADER =
  "The following user instructions come from <dataDir>/AGENTS.md:";
const STORE_HEADER =
  "The following user instructions come from the instructions store (docs/AGENTS.md):";
const DARK_USER_TEXT = "# User Rules\n\nPrefer concise progress updates.\n";

function joinSections(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join("\n\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ScenarioStep {
  delayMs?: number;
  exit?: number;
  raw?: string;
  result?: unknown;
  stderr?: string;
}

interface FakeResolve {
  argsLines(): Promise<string[][]>;
  callCount(): Promise<number>;
  command: string[];
}

async function installFakeResolve(
  root: string,
  steps: ScenarioStep[],
): Promise<FakeResolve> {
  await mkdir(root, { recursive: true });
  const scriptPath = path.join(root, "fake-resolve.mjs");
  const scenarioPath = path.join(root, "scenario.json");
  await writeFile(scriptPath, FAKE_RESOLVE_SCRIPT, "utf8");
  await writeFile(scenarioPath, JSON.stringify({ steps }), "utf8");
  return {
    command: [process.execPath, scriptPath, scenarioPath],
    async callCount() {
      try {
        return Number(await readFile(`${scenarioPath}.count`, "utf8"));
      } catch {
        return 0;
      }
    },
    async argsLines() {
      try {
        const raw = await readFile(`${scenarioPath}.args`, "utf8");
        return raw
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as string[]);
      } catch {
        return [];
      }
    },
  };
}

interface WriteSnapshotArgs {
  agents: string;
  id: string;
  root: string;
}

async function writeSnapshot(
  args: WriteSnapshotArgs,
): Promise<{ directory: string; result: Record<string, unknown> }> {
  const directory = path.join(args.root, args.id);
  await mkdir(path.join(directory, "docs"), { recursive: true });
  await writeFile(path.join(directory, "docs", "AGENTS.md"), args.agents);
  return {
    directory,
    result: {
      source: "active",
      snapshotId: args.id,
      mode: "aleph-append",
      directory,
      files: [
        {
          path: "docs/AGENTS.md",
          sha256: sha256(args.agents),
          bytes: Buffer.byteLength(args.agents),
        },
      ],
    },
  };
}

interface Seeded {
  environment: {
    hostId: string;
    id: string;
    path: string | null;
    status: "ready";
  };
  hostId: string;
  projectId: string;
  thread: ReturnType<typeof seedThread>;
  writes: Map<string, string>;
}

function seedScenario(
  harness: TestAppHarness,
  providerId: "codex" | "claude-code",
  label: string,
): Seeded {
  const hostId = `host-instructions-${label}`;
  const { session } = seedHostSession(harness.deps, { id: hostId });
  const workspacePath = path.join(harness.config.dataDir, `${label}-workspace`);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId,
    path: workspacePath,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId,
    projectId: project.id,
    path: workspacePath,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId,
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    model: providerId === "codex" ? "gpt-5" : "claude-sonnet-4-5",
    providerThreadId: `provider-${label}`,
    threadId: thread.id,
  });
  const writes = new Map<string, string>();
  registerHostRpcResponder(harness, {
    hostId,
    sessionId: session.id,
    handle: ({ command }) => {
      if (command.type === "host.write_file") {
        writes.set(command.path, command.content);
        return {
          ok: true,
          result: {
            outcome: "written",
            sha256: sha256(command.content),
            sizeBytes: Buffer.byteLength(command.content),
          },
        };
      }
      if (command.type === "host.read_workspace_agent_context") {
        return {
          ok: true,
          result: {
            agentInstructions: null,
            projectSkills: [],
            projectSkillsTruncated: false,
            sharedSkills: [],
          },
        };
      }
      throw new Error(`Unexpected RPC ${command.type}`);
    },
  });
  return {
    environment: {
      hostId: environment.hostId,
      id: environment.id,
      path: environment.path,
      status: "ready",
    },
    hostId,
    projectId: project.id,
    thread,
    writes,
  };
}

async function resolveFor(
  harness: TestAppHarness,
  seeded: Seeded,
  purpose?: "start" | "turn" | "dry-run",
) {
  return resolveThreadRuntimeCommandConfig(harness.deps, {
    thread: seeded.thread,
    model: "test-model",
    environment: seeded.environment,
    ...(purpose !== undefined ? { purpose } : {}),
  });
}

function configure(
  harness: TestAppHarness,
  fake: FakeResolve,
  extra: { resolveTimeoutMs?: number; store?: string } = {},
): void {
  harness.deps.config.orchestration = {
    instructionsStore:
      extra.store ?? path.join(harness.config.dataDir, "instructions-store"),
    resolveCommand: fake.command,
    ...(extra.resolveTimeoutMs !== undefined
      ? { resolveTimeoutMs: extra.resolveTimeoutMs }
      : {}),
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("instructions store resolve caller", () => {
  describe.each(["codex", "claude-code"] as const)(
    "dark mode on %s",
    (providerId) => {
      it("assembles byte-identical instructions to the pre-store golden", async () => {
        await withTestHarness(async (harness) => {
          const seeded = seedScenario(harness, providerId, "dark-golden");
          const baseline = await resolveFor(harness, seeded);
          await writeFile(
            path.join(harness.config.dataDir, "AGENTS.md"),
            DARK_USER_TEXT,
          );
          const runtime = await resolveFor(harness, seeded);
          expect(runtime.instructions).toBe(
            joinSections(
              baseline.instructions,
              USER_HEADER,
              DARK_USER_TEXT.trim(),
            ),
          );
          expect(runtime.rulesReceipt.source).toBe("dark");
          expect(runtime.rulesReceipt.snapshotId).toBeNull();
          expect(seeded.writes.size).toBe(0);
        });
      });

      it("matches the golden when the store is configured but reports dark", async () => {
        await withTestHarness(async (harness) => {
          const seeded = seedScenario(harness, providerId, "dark-store");
          const baseline = await resolveFor(harness, seeded);
          await writeFile(
            path.join(harness.config.dataDir, "AGENTS.md"),
            DARK_USER_TEXT,
          );
          const fake = await installFakeResolve(
            path.join(harness.config.dataDir, "fake"),
            [{ result: { source: "dark" } }],
          );
          configure(harness, fake);
          const runtime = await resolveFor(harness, seeded);
          expect(runtime.instructions).toBe(
            joinSections(
              baseline.instructions,
              USER_HEADER,
              DARK_USER_TEXT.trim(),
            ),
          );
          expect(runtime.rulesReceipt.source).toBe("dark");
        });
      });
    },
  );

  it("blocks the start when the data-dir marker is present and the config is unset", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "marker");
      await writeFile(
        path.join(harness.config.dataDir, ".aleph-instructions"),
        JSON.stringify({ store_path: "/x", store_id: "y" }),
      );
      const error = await rejection(resolveFor(harness, seeded));
      expect(error).toMatchObject({
        status: 409,
        body: { code: "instructions_store_not_configured" },
      });
    });
  });

  it("blocks buildThreadStartCommand when the marker is present and the config is unset", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "marker-start");
      await writeFile(
        path.join(harness.config.dataDir, ".aleph-instructions"),
        "{}",
      );
      const execution = await buildExecutionOptions(
        harness.deps,
        { model: "gpt-5" },
        { threadId: seeded.thread.id, hostId: seeded.hostId },
      );
      const error = await rejection(
        buildThreadStartCommand(harness.deps, {
          environment: seeded.environment,
          execution,
          fork: null,
          permissionEscalation: "ask",
          input: textInput("hello"),
          projectId: seeded.projectId,
          providerId: "codex",
          requestId: encodeClientTurnRequestIdNumber({ value: 201 }),
          syncGeneratedTitle: false,
          thread: seeded.thread,
        }),
      );
      expect(error).toMatchObject({
        body: { code: "instructions_store_not_configured" },
      });
    });
  });

  it("refuses a stub data-dir AGENTS.md in dark mode", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "stub-dark");
      await writeFile(
        path.join(harness.config.dataDir, "AGENTS.md"),
        `\n${INSTRUCTIONS_STUB_MARKER}\nThis file moved.\n`,
      );
      const error = await rejection(resolveFor(harness, seeded));
      expect(error).toMatchObject({
        status: 409,
        body: { code: "instructions_stub_refused" },
      });
    });
  });

  it("refuses a stub docs/AGENTS.md in an active snapshot", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "stub-store");
      const snapshot = await writeSnapshot({
        agents: `${INSTRUCTIONS_STUB_MARKER}\nmoved\n`,
        id: "snap-stub",
        root: path.join(harness.config.dataDir, "snaps"),
      });
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: snapshot.result }],
      );
      configure(harness, fake);
      const error = await rejection(resolveFor(harness, seeded));
      expect(error).toMatchObject({
        body: { code: "instructions_stub_refused" },
      });
    });
  });

  it("uses the resolved snapshot, fills {instructions_dir} and records the receipt", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "active");
      const agents =
        "# Rules\n\nSee {instructions_dir}/docs/more.md and {instructions_dir}.\n";
      const snapshot = await writeSnapshot({
        agents,
        id: "snap-1",
        root: path.join(harness.config.dataDir, "snaps"),
      });
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: snapshot.result }],
      );
      const baseline = await resolveFor(harness, seeded);
      configure(harness, fake);
      const runtime = await resolveFor(harness, seeded);
      const filled = `# Rules\n\nSee ${snapshot.directory}/docs/more.md and ${snapshot.directory}.`;
      expect(runtime.instructions).toBe(
        joinSections(baseline.instructions, STORE_HEADER, filled),
      );
      expect(runtime.rulesReceipt).toMatchObject({
        snapshotId: "snap-1",
        mode: "aleph-append",
        source: "active",
        instructionsSha256: sha256(runtime.instructions),
      });
      expect(runtime.rulesReceipt.sections).toEqual([
        ...baseline.rulesReceipt.sections,
        {
          header: STORE_HEADER,
          bytes: Buffer.byteLength(filled),
          sha256: sha256(filled),
        },
      ]);
      const args = await fake.argsLines();
      expect(args).toEqual([
        [
          "--store",
          path.join(harness.config.dataDir, "instructions-store"),
          "--data-dir",
          harness.config.dataDir,
        ],
      ]);
    });
  });

  it("serves an LKG snapshot and records the source", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "claude-code", "lkg");
      const snapshot = await writeSnapshot({
        agents: "# LKG rules\n",
        id: "snap-lkg",
        root: path.join(harness.config.dataDir, "snaps"),
      });
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: { ...snapshot.result, source: "lkg", mode: "legacy" } }],
      );
      configure(harness, fake);
      const runtime = await resolveFor(harness, seeded);
      expect(runtime.rulesReceipt).toMatchObject({
        source: "lkg",
        mode: "legacy",
        snapshotId: "snap-lkg",
      });
    });
  });

  it("writes a receipt equal to the dry-run receipt", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "receipt");
      const snapshot = await writeSnapshot({
        agents: "# Rules\n",
        id: "snap-r",
        root: path.join(harness.config.dataDir, "snaps"),
      });
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: snapshot.result }],
      );
      configure(harness, fake);
      const started = await resolveFor(harness, seeded, "start");
      expect(seeded.writes.size).toBe(1);
      const [[writtenPath, written]] = [...seeded.writes.entries()];
      expect(path.basename(writtenPath!)).toBe(RULES_RECEIPT_FILE_NAME);
      const dryRun = await resolveFor(harness, seeded, "dry-run");
      expect(seeded.writes.size).toBe(1);
      const writtenReceipt = JSON.parse(written!) as RulesReceipt;
      expect(writtenReceipt).toEqual(started.rulesReceipt);
      expect(writtenReceipt.delivery).toBe("delivered");
      expect(dryRun.rulesReceipt.delivery).toBe("dry-run");
      expect({ ...dryRun.rulesReceipt, delivery: "delivered" }).toEqual(
        writtenReceipt,
      );
      expect(dryRun.instructions).toBe(started.instructions);
    });
  });

  it("marks a turn-time resolve as resolved-only", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "claude-code", "turn");
      const snapshot = await writeSnapshot({
        agents: "# Rules\n",
        id: "snap-turn",
        root: path.join(harness.config.dataDir, "snaps"),
      });
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: snapshot.result }],
      );
      configure(harness, fake);
      await resolveFor(harness, seeded, "turn");
      const [[, written]] = [...seeded.writes.entries()];
      expect((JSON.parse(written!) as RulesReceipt).delivery).toBe(
        "resolved-only",
      );
    });
  });

  it("serves the dry-run receipt over the public route without writing", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "route");
      const snapshot = await writeSnapshot({
        agents: "# Rules\n",
        id: "snap-route",
        root: path.join(harness.config.dataDir, "snaps"),
      });
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: snapshot.result }],
      );
      configure(harness, fake);
      const response = await harness.app.request(
        `/api/v1/threads/${seeded.thread.id}/runtime-config`,
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { rulesReceipt: RulesReceipt };
      const direct = await resolveFor(harness, seeded, "dry-run");
      expect(body.rulesReceipt.delivery).toBe("dry-run");
      expect(body.rulesReceipt).toEqual(direct.rulesReceipt);
      expect(seeded.writes.size).toBe(0);
    });
  });

  it("fails retryably on timeout", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "timeout");
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ delayMs: 5_000, result: { source: "dark" } }],
      );
      configure(harness, fake, { resolveTimeoutMs: 300 });
      const error = await rejection(resolveFor(harness, seeded));
      expect(error).toMatchObject({
        status: 503,
        body: { code: "instructions_resolve_timeout", retryable: true },
      });
    });
  });

  it("fails retryably on a nonzero exit and on malformed output", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "failure");
      const failing = await installFakeResolve(
        path.join(harness.config.dataDir, "fake-fail"),
        [{ exit: 3, stderr: "boom" }],
      );
      configure(harness, failing);
      expect(await rejection(resolveFor(harness, seeded))).toMatchObject({
        status: 503,
        body: { code: "instructions_resolve_failed", retryable: true },
      });
      const garbage = await installFakeResolve(
        path.join(harness.config.dataDir, "fake-garbage"),
        [{ raw: "not json" }],
      );
      configure(harness, garbage);
      expect(await rejection(resolveFor(harness, seeded))).toMatchObject({
        body: { code: "instructions_resolve_invalid", retryable: true },
      });
      const shape = await installFakeResolve(
        path.join(harness.config.dataDir, "fake-shape"),
        [{ result: { source: "active" } }],
      );
      configure(harness, shape);
      expect(await rejection(resolveFor(harness, seeded))).toMatchObject({
        body: { code: "instructions_resolve_invalid" },
      });
    });
  });

  it("blocks the start when the first activation crashed before the LKG pointer exists", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "r5");
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [
          {
            exit: 4,
            stderr: "initialization incomplete: lkg-current pointer missing",
          },
        ],
      );
      configure(harness, fake);
      await writeFile(
        path.join(harness.config.dataDir, "AGENTS.md"),
        DARK_USER_TEXT,
      );
      const execution = await buildExecutionOptions(
        harness.deps,
        { model: "gpt-5" },
        { threadId: seeded.thread.id, hostId: seeded.hostId },
      );
      const error = await rejection(
        buildThreadStartCommand(harness.deps, {
          environment: seeded.environment,
          execution,
          fork: null,
          permissionEscalation: "ask",
          input: textInput("hello"),
          projectId: seeded.projectId,
          providerId: "codex",
          requestId: encodeClientTurnRequestIdNumber({ value: 202 }),
          syncGeneratedTitle: false,
          thread: seeded.thread,
        }),
      );
      expect(error).toMatchObject({ status: 503, body: { retryable: true } });
      expect(seeded.writes.size).toBe(0);
    });
  });

  it("re-resolves once on a digest mismatch and then succeeds", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "mismatch-ok");
      const snapshot = await writeSnapshot({
        agents: "# Rules\n",
        id: "snap-m",
        root: path.join(harness.config.dataDir, "snaps"),
      });
      const stale = {
        ...snapshot.result,
        files: [{ path: "docs/AGENTS.md", sha256: sha256("other") }],
      };
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: stale }, { result: snapshot.result }],
      );
      configure(harness, fake);
      const runtime = await resolveFor(harness, seeded);
      expect(runtime.rulesReceipt.snapshotId).toBe("snap-m");
      expect(await fake.callCount()).toBe(2);
    });
  });

  it("fails after a second digest mismatch", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "mismatch-fail");
      const snapshot = await writeSnapshot({
        agents: "# Rules\n",
        id: "snap-bad",
        root: path.join(harness.config.dataDir, "snaps"),
      });
      const stale = {
        ...snapshot.result,
        files: [{ path: "docs/AGENTS.md", sha256: sha256("other") }],
      };
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: stale }],
      );
      configure(harness, fake);
      const error = await rejection(resolveFor(harness, seeded));
      expect(error).toMatchObject({
        status: 409,
        body: { code: "instructions_digest_mismatch" },
      });
      expect(await fake.callCount()).toBe(2);
    });
  });

  it("blocks a snapshot that does not list docs/AGENTS.md", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "unlisted");
      const snapshot = await writeSnapshot({
        agents: "# Rules\n",
        id: "snap-u",
        root: path.join(harness.config.dataDir, "snaps"),
      });
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: { ...snapshot.result, files: [] } }],
      );
      configure(harness, fake);
      expect(await rejection(resolveFor(harness, seeded))).toMatchObject({
        body: { code: "instructions_agents_missing" },
      });
    });
  });
});
