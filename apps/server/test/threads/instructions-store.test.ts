import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeClientTurnRequestIdNumber } from "@bb/domain";
import { runLiveHostCommand } from "../../src/services/hosts/live-command.js";
import { setPluginAgentContributions } from "../../src/services/plugins/plugin-agent-contributions.js";
import {
  addRequestIdToTurnSubmitCommandPayload,
  buildExecutionOptions,
  buildThreadStartCommand,
  prepareTurnSubmitCommandPayload,
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
if (step.repeat) {
  process.stdout.write(step.repeat.char.repeat(step.repeat.count));
} else {
  process.stdout.write(step.raw ?? JSON.stringify(step.result));
}
`;

const CHILD_SPAWNING_SCRIPT = `
import { spawn } from "node:child_process";
const [, , pidPath] = process.argv;
const child = spawn(
  process.execPath,
  [
    "-e",
    "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);",
    pidPath,
  ],
  { stdio: "ignore" },
);
child.unref();
setInterval(() => {}, 1000);
`;

const USER_HEADER =
  "The following user instructions come from <dataDir>/AGENTS.md:";
const STORE_HEADER =
  "The following user instructions come from the instructions store (docs/AGENTS.md):";
const DARK_USER_TEXT = "# User Rules\n\nPrefer concise progress updates.\n";
const WORKSPACE_TEXT =
  "# Project Rules\n\nAlways run the smoke test before pushing.\n";
const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
const BASE_COMMIT = "ed56ed2b";

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
  repeat?: { char: string; count: number };
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

function storePath(harness: TestAppHarness): string {
  return path.join(harness.config.dataDir, "instructions-store");
}

function snapshotRoot(harness: TestAppHarness): string {
  return path.join(storePath(harness), "snapshots");
}

async function markInitialized(harness: TestAppHarness): Promise<void> {
  await writeFile(
    path.join(harness.config.dataDir, ".aleph-instructions"),
    JSON.stringify({ store_path: storePath(harness), store_id: "test" }),
  );
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
    result: snapshotResult({
      agents: args.agents,
      directory,
      id: args.id,
    }),
  };
}

interface SnapshotResultArgs {
  agents: string;
  directory: string;
  id: string;
}

function snapshotResult(args: SnapshotResultArgs): Record<string, unknown> {
  return {
    source: "active",
    snapshotId: args.id,
    mode: "aleph-append",
    directory: args.directory,
    files: [
      {
        path: "docs/AGENTS.md",
        sha256: sha256(args.agents),
        bytes: Buffer.byteLength(args.agents),
      },
    ],
  };
}

interface Seeded {
  environment: {
    hostId: string;
    id: string;
    path: string | null;
    status: "ready";
  };
  failStart: { value: boolean };
  failWrites: { value: boolean };
  hostId: string;
  projectId: string;
  providerId: "codex" | "claude-code";
  providerResumed: { value: boolean };
  requestTypes: string[];
  rootsCreated: Set<string>;
  thread: ReturnType<typeof seedThread>;
  writeRoots: Map<string, string>;
  writes: Map<string, string>;
}

interface SeedScenarioOptions {
  agentInstructions?: string;
  hostId?: string;
}

function seedScenario(
  harness: TestAppHarness,
  providerId: "codex" | "claude-code",
  label: string,
  options: SeedScenarioOptions = {},
): Seeded {
  const hostId = options.hostId ?? `host-instructions-${label}`;
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
  const writeRoots = new Map<string, string>();
  const rootsCreated = new Set<string>();
  const requestTypes: string[] = [];
  const failStart = { value: false };
  const failWrites = { value: false };
  const providerResumed = { value: false };
  registerHostRpcResponder(harness, {
    hostId,
    sessionId: session.id,
    handle: ({ command }) => {
      requestTypes.push(command.type);
      if (command.type === "thread.start") {
        if (failStart.value) {
          return {
            ok: false,
            errorCode: "provider_start_failed",
            errorMessage: "The provider refused to start",
          };
        }
        if (command.threadStoragePath !== undefined) {
          rootsCreated.add(command.threadStoragePath);
        }
        return { ok: true, result: { providerThreadId: `provider-${label}` } };
      }
      if (command.type === "turn.submit") {
        return {
          ok: true,
          result: {
            trace: { spans: [] },
            ...(providerResumed.value ? { providerResumed: true } : {}),
          },
        };
      }
      if (command.type === "host.write_file") {
        if (failWrites.value) {
          return {
            ok: false,
            errorCode: "EACCES",
            errorMessage: `Permission denied: ${command.path}`,
          };
        }
        if (
          command.rootPath !== undefined &&
          !rootsCreated.has(command.rootPath)
        ) {
          return {
            ok: false,
            errorCode: "ENOENT",
            errorMessage: `Path does not exist: ${command.rootPath}`,
          };
        }
        writes.set(command.path, command.content);
        if (command.rootPath !== undefined) {
          writeRoots.set(command.path, command.rootPath);
        }
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
            agentInstructions: options.agentInstructions ?? null,
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
    failStart,
    failWrites,
    hostId,
    projectId: project.id,
    providerId,
    providerResumed,
    requestTypes,
    rootsCreated,
    thread,
    writeRoots,
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
    instructionsStore: extra.store ?? storePath(harness),
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

function modelFor(seeded: Seeded): string {
  return seeded.providerId === "codex" ? "gpt-5" : "claude-sonnet-4-5";
}

async function buildStart(
  harness: TestAppHarness,
  seeded: Seeded,
  requestNumber: number,
) {
  const execution = await buildExecutionOptions(
    harness.deps,
    { model: modelFor(seeded) },
    { threadId: seeded.thread.id, hostId: seeded.hostId },
  );
  return buildThreadStartCommand(harness.deps, {
    environment: seeded.environment,
    execution,
    fork: null,
    permissionEscalation: "ask",
    input: textInput("hello"),
    projectId: seeded.projectId,
    providerId: seeded.providerId,
    requestId: encodeClientTurnRequestIdNumber({ value: requestNumber }),
    syncGeneratedTitle: false,
    thread: seeded.thread,
  });
}

async function buildSubmitCommand(
  harness: TestAppHarness,
  seeded: Seeded,
  requestNumber: number,
) {
  return addRequestIdToTurnSubmitCommandPayload({
    preparedCommand: await buildSubmit(harness, seeded),
    requestId: encodeClientTurnRequestIdNumber({ value: requestNumber }),
  });
}

async function buildSubmit(harness: TestAppHarness, seeded: Seeded) {
  const execution = await buildExecutionOptions(
    harness.deps,
    { model: modelFor(seeded) },
    { threadId: seeded.thread.id, hostId: seeded.hostId },
  );
  return prepareTurnSubmitCommandPayload(harness.deps, {
    environment: seeded.environment,
    execution,
    permissionEscalation: "ask",
    input: textInput("continue"),
    target: { mode: "start" },
    thread: seeded.thread,
  });
}

async function activeStore(
  harness: TestAppHarness,
  agents = "# Rules\n",
  id = "snap-live",
): Promise<FakeResolve> {
  const snapshot = await writeSnapshot({
    agents,
    id,
    root: snapshotRoot(harness),
  });
  const fake = await installFakeResolve(
    path.join(harness.config.dataDir, "fake"),
    [{ result: snapshot.result }],
  );
  configure(harness, fake);
  return fake;
}

function receiptFrom(seeded: Seeded): RulesReceipt {
  const entries = [...seeded.writes.entries()];
  expect(entries).toHaveLength(1);
  const [[writtenPath, written]] = entries;
  expect(path.basename(writtenPath!)).toBe(RULES_RECEIPT_FILE_NAME);
  return JSON.parse(written!) as RulesReceipt;
}

interface DarkCaptureArgs {
  harness: TestAppHarness;
  providerId: "codex" | "claude-code";
}

async function captureDarkPayloads(args: DarkCaptureArgs): Promise<string> {
  const { harness, providerId } = args;
  const seeded = seedScenario(harness, providerId, "golden", {
    agentInstructions: WORKSPACE_TEXT,
    hostId: "host-golden",
  });
  await writeFile(
    path.join(harness.config.dataDir, "AGENTS.md"),
    DARK_USER_TEXT,
    "utf8",
  );
  const tool = {
    pluginId: "tooldemo",
    tool: {
      name: "demo_lookup",
      description: "Look up demo data",
      inputSchema: { type: "object" as const },
    },
    instructions: "Call demo_lookup before guessing.",
  };
  setPluginAgentContributions({
    listSkillRootContributions: () => [],
    listAgentTools: () => [tool],
    listInstructionContributions: () => [
      {
        pluginId: "connect",
        provider: ({ threadId, projectId }) =>
          `Remote session for ${threadId} in ${projectId}`,
      },
    ],
    findAgentTool: () => undefined,
    invokeAgentTool: async () => ({
      success: false,
      contentItems: [{ type: "inputText", text: "unused" }],
    }),
    resolveMention: async () => ({ ok: false, error: "unused" }),
    resolveAgentConfiguration: async () => ({
      tools: [tool],
      selectedSkillIdsByPlugin: new Map(),
      dynamicInstructions: [
        { pluginId: "dyn", text: "Dynamic text for the thread." },
      ],
    }),
  });
  const start = await buildStart(harness, seeded, 301);
  const submit = await buildSubmit(harness, seeded);
  let text = JSON.stringify({ start, submit }, null, 2);
  for (const [needle, label] of [
    [seeded.thread.id, "<thread>"],
    [seeded.projectId, "<project>"],
    [seeded.environment.id, "<environment>"],
    [harness.config.dataDir, "<dataDir>"],
  ] as const) {
    text = text.split(needle).join(label);
  }
  return text;
}

async function readFixture(providerId: string): Promise<unknown> {
  return JSON.parse(
    await readFile(
      path.join(FIXTURE_DIR, `instructions-dark-golden-${providerId}.json`),
      "utf8",
    ),
  );
}

async function pidIsGone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe("instructions store resolve caller", () => {
  afterEach(() => {
    setPluginAgentContributions(undefined);
  });

  describe.each(["codex", "claude-code"] as const)(
    "dark mode on %s",
    (providerId) => {
      it(`matches the instructions and provider commands frozen from ${BASE_COMMIT} when no store is configured`, async () => {
        await withTestHarness(async (harness) => {
          const text = await captureDarkPayloads({ harness, providerId });
          expect(JSON.parse(text)).toEqual(await readFixture(providerId));
        });
      });

      it(`matches the instructions and provider commands frozen from ${BASE_COMMIT} when the uninitialized store reports dark`, async () => {
        await withTestHarness(async (harness) => {
          const fake = await installFakeResolve(
            path.join(harness.config.dataDir, "fake"),
            [{ result: { source: "dark" } }],
          );
          configure(harness, fake);
          const text = await captureDarkPayloads({ harness, providerId });
          expect(JSON.parse(text)).toEqual(await readFixture(providerId));
          expect(await fake.callCount()).toBeGreaterThan(0);
        });
      });

      it("records a dark receipt with no snapshot", async () => {
        await withTestHarness(async (harness) => {
          const seeded = seedScenario(harness, providerId, "dark-receipt");
          await writeFile(
            path.join(harness.config.dataDir, "AGENTS.md"),
            DARK_USER_TEXT,
          );
          const runtime = await resolveFor(harness, seeded);
          expect(runtime.rulesReceipt.source).toBe("dark");
          expect(runtime.rulesReceipt.snapshotId).toBeNull();
          expect(runtime.instructions).toContain(
            joinSections(USER_HEADER, DARK_USER_TEXT.trim()),
          );
          expect(seeded.writes.size).toBe(0);
        });
      });
    },
  );

  describe("dark after initialization", () => {
    it("rejects a dark result once the store is initialized", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "init-dark");
        await markInitialized(harness);
        await writeFile(
          path.join(harness.config.dataDir, "AGENTS.md"),
          DARK_USER_TEXT,
        );
        const fake = await installFakeResolve(
          path.join(harness.config.dataDir, "fake"),
          [{ result: { source: "dark" } }],
        );
        configure(harness, fake);
        const error = await rejection(resolveFor(harness, seeded));
        expect(error).toMatchObject({
          status: 409,
          body: { code: "instructions_dark_after_init" },
        });
        expect(
          (error as { body: { retryable?: boolean } }).body.retryable,
        ).not.toBe(true);
      });
    });

    it("rejects a start command build once the store is initialized and reports dark", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "claude-code", "init-dark-start");
        await markInitialized(harness);
        const fake = await installFakeResolve(
          path.join(harness.config.dataDir, "fake"),
          [{ result: { source: "dark" } }],
        );
        configure(harness, fake);
        const error = await rejection(buildStart(harness, seeded, 210));
        expect(error).toMatchObject({
          body: { code: "instructions_dark_after_init" },
        });
        expect(seeded.requestTypes).not.toContain("thread.start");
      });
    });

    it("never turns a failed digest retry into dark, initialized or not", async () => {
      for (const initialized of [false, true]) {
        await withTestHarness(async (harness) => {
          const seeded = seedScenario(
            harness,
            "codex",
            `retry-dark-${initialized ? "init" : "fresh"}`,
          );
          if (initialized) {
            await markInitialized(harness);
          }
          const snapshot = await writeSnapshot({
            agents: "# Rules\n",
            id: "snap-retry",
            root: snapshotRoot(harness),
          });
          const stale = {
            ...snapshot.result,
            files: [{ path: "docs/AGENTS.md", sha256: sha256("other") }],
          };
          const fake = await installFakeResolve(
            path.join(harness.config.dataDir, "fake"),
            [{ result: stale }, { result: { source: "dark" } }],
          );
          configure(harness, fake);
          await writeFile(
            path.join(harness.config.dataDir, "AGENTS.md"),
            DARK_USER_TEXT,
          );
          const error = await rejection(resolveFor(harness, seeded));
          expect(error).toMatchObject({
            status: 409,
            body: { code: "instructions_dark_after_init" },
          });
          expect(await fake.callCount()).toBe(2);
          expect(seeded.writes.size).toBe(0);
        });
      }
    });

    it("serves the last known good snapshot after initialization", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "claude-code", "lkg");
        await markInitialized(harness);
        const snapshot = await writeSnapshot({
          agents: "# LKG rules\n",
          id: "snap-lkg",
          root: snapshotRoot(harness),
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

    it("blocks the start when the first activation crashed with the marker written but no LKG pointer", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "r5");
        await markInitialized(harness);
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
        const error = await rejection(buildStart(harness, seeded, 202));
        expect(error).toMatchObject({ status: 503, body: { retryable: true } });
        expect(seeded.requestTypes).not.toContain("thread.start");
        expect(seeded.writes.size).toBe(0);
      });
    });
  });

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
      const error = await rejection(buildStart(harness, seeded, 201));
      expect(error).toMatchObject({
        body: { code: "instructions_store_not_configured" },
      });
    });
  });

  it("rejects the dry-run route under the same guards", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "route-guard");
      await markInitialized(harness);
      const unconfigured = await harness.app.request(
        `/api/v1/threads/${seeded.thread.id}/runtime-config`,
      );
      expect(unconfigured.status).toBe(409);
      expect(((await unconfigured.json()) as { code: string }).code).toBe(
        "instructions_store_not_configured",
      );
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: { source: "dark" } }],
      );
      configure(harness, fake);
      const dark = await harness.app.request(
        `/api/v1/threads/${seeded.thread.id}/runtime-config`,
      );
      expect(dark.status).toBe(409);
      expect(((await dark.json()) as { code: string }).code).toBe(
        "instructions_dark_after_init",
      );
      expect(seeded.writes.size).toBe(0);
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
      await activeStore(harness, `${INSTRUCTIONS_STUB_MARKER}\nmoved\n`);
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
      const baseline = await resolveFor(harness, seeded);
      const fake = await activeStore(harness, agents, "snap-1");
      const runtime = await resolveFor(harness, seeded);
      const directory = path.join(snapshotRoot(harness), "snap-1");
      const filled = `# Rules\n\nSee ${directory}/docs/more.md and ${directory}.`;
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
      expect(await fake.argsLines()).toEqual([
        ["--store", storePath(harness), "--data-dir", harness.config.dataDir],
      ]);
    });
  });

  describe("path confinement", () => {
    it("rejects a resolved directory outside the store", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "outside");
        await mkdir(storePath(harness), { recursive: true });
        const snapshot = await writeSnapshot({
          agents: "# Rules\n",
          id: "snap-outside",
          root: path.join(harness.config.dataDir, "elsewhere"),
        });
        const fake = await installFakeResolve(
          path.join(harness.config.dataDir, "fake"),
          [{ result: snapshot.result }],
        );
        configure(harness, fake);
        expect(await rejection(resolveFor(harness, seeded))).toMatchObject({
          status: 409,
          body: { code: "instructions_path_escape" },
        });
      });
    });

    it("rejects the store root itself as the snapshot directory", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "root");
        const snapshot = await writeSnapshot({
          agents: "# Rules\n",
          id: "",
          root: storePath(harness),
        });
        const fake = await installFakeResolve(
          path.join(harness.config.dataDir, "fake"),
          [{ result: { ...snapshot.result, snapshotId: "snap-root" } }],
        );
        configure(harness, fake);
        expect(await rejection(resolveFor(harness, seeded))).toMatchObject({
          body: { code: "instructions_path_escape" },
        });
      });
    });

    it("rejects a snapshot directory that is a symlink out of the store", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "dir-link");
        const target = await writeSnapshot({
          agents: "# Escaped\n",
          id: "real",
          root: path.join(harness.config.dataDir, "escape-target"),
        });
        await mkdir(snapshotRoot(harness), { recursive: true });
        const link = path.join(snapshotRoot(harness), "snap-link");
        await symlink(target.directory, link, "dir");
        const fake = await installFakeResolve(
          path.join(harness.config.dataDir, "fake"),
          [
            {
              result: snapshotResult({
                agents: "# Escaped\n",
                directory: link,
                id: "snap-link",
              }),
            },
          ],
        );
        configure(harness, fake);
        expect(await rejection(resolveFor(harness, seeded))).toMatchObject({
          body: { code: "instructions_path_escape" },
        });
        expect(seeded.writes.size).toBe(0);
      });
    });

    it("rejects a docs/AGENTS.md that is a symlink out of the snapshot", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "file-link");
        const outside = path.join(harness.config.dataDir, "outside.md");
        await writeFile(outside, "# Outside\n");
        const directory = path.join(snapshotRoot(harness), "snap-file-link");
        await mkdir(path.join(directory, "docs"), { recursive: true });
        await symlink(outside, path.join(directory, "docs", "AGENTS.md"));
        const fake = await installFakeResolve(
          path.join(harness.config.dataDir, "fake"),
          [
            {
              result: snapshotResult({
                agents: "# Outside\n",
                directory,
                id: "snap-file-link",
              }),
            },
          ],
        );
        configure(harness, fake);
        expect(await rejection(resolveFor(harness, seeded))).toMatchObject({
          body: { code: "instructions_path_escape" },
        });
      });
    });

    it.skipIf(process.getuid?.() === 0)(
      "treats an unreadable docs/AGENTS.md as a digest mismatch",
      async () => {
        await withTestHarness(async (harness) => {
          const seeded = seedScenario(harness, "codex", "unreadable");
          const fake = await activeStore(harness, "# Rules\n", "snap-denied");
          const file = path.join(
            snapshotRoot(harness),
            "snap-denied",
            "docs",
            "AGENTS.md",
          );
          await chmod(file, 0o000);
          try {
            expect(await rejection(resolveFor(harness, seeded))).toMatchObject({
              status: 409,
              body: { code: "instructions_digest_mismatch" },
            });
            expect(await fake.callCount()).toBe(2);
          } finally {
            await chmod(file, 0o644);
          }
        });
      },
    );
  });

  describe("receipts follow delivery", () => {
    it("writes the receipt only after the provider accepts a fresh thread's start", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "receipt");
        await activeStore(harness);
        const command = await buildStart(harness, seeded, 220);
        expect(seeded.writes.size).toBe(0);
        expect(seeded.requestTypes).not.toContain("host.write_file");
        await runLiveHostCommand(harness.deps, {
          command,
          hostId: seeded.hostId,
          timeoutMs: 5_000,
        });
        expect(seeded.requestTypes.indexOf("thread.start")).toBeLessThan(
          seeded.requestTypes.indexOf("host.write_file"),
        );
        const written = receiptFrom(seeded);
        const [writtenPath] = [...seeded.writes.keys()];
        const storageRoot = command.threadStoragePath ?? "";
        expect(storageRoot).not.toBe("");
        expect(seeded.writeRoots.get(writtenPath!)).toBe(storageRoot);
        expect(writtenPath).toBe(
          path.posix.join(storageRoot, RULES_RECEIPT_FILE_NAME),
        );
        expect(written.delivery).toBe("delivered");
        const dryRun = await resolveFor(harness, seeded, "dry-run");
        expect(dryRun.rulesReceipt.delivery).toBe("dry-run");
        expect({ ...dryRun.rulesReceipt, delivery: "delivered" }).toEqual(
          written,
        );
        expect(dryRun.instructions).toBe(command.instructions);
        expect(seeded.writes.size).toBe(1);
      });
    });

    it("writes no receipt when the provider refuses the start", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "failed-start");
        await activeStore(harness);
        seeded.failStart.value = true;
        const command = await buildStart(harness, seeded, 221);
        await rejection(
          runLiveHostCommand(harness.deps, {
            command,
            hostId: seeded.hostId,
            timeoutMs: 5_000,
          }),
        );
        expect(seeded.requestTypes).toContain("thread.start");
        expect(seeded.requestTypes).not.toContain("host.write_file");
        expect(seeded.writes.size).toBe(0);
      });
    });

    it("keeps the last delivered receipt across an ordinary submit", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "claude-code", "ordinary");
        await activeStore(harness);
        await runLiveHostCommand(harness.deps, {
          command: await buildStart(harness, seeded, 222),
          hostId: seeded.hostId,
          timeoutMs: 5_000,
        });
        const before = receiptFrom(seeded);
        const writesBefore = seeded.requestTypes.filter(
          (type) => type === "host.write_file",
        ).length;
        await runLiveHostCommand(harness.deps, {
          command: await buildSubmitCommand(harness, seeded, 230),
          hostId: seeded.hostId,
          timeoutMs: 5_000,
        });
        expect(
          seeded.requestTypes.filter((type) => type === "host.write_file"),
        ).toHaveLength(writesBefore);
        expect(receiptFrom(seeded)).toEqual(before);
        expect(before.delivery).toBe("delivered");
      });
    });

    it("records a resumed delivery when the daemon reports a provider resume", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "resumed");
        await activeStore(harness);
        await runLiveHostCommand(harness.deps, {
          command: await buildStart(harness, seeded, 223),
          hostId: seeded.hostId,
          timeoutMs: 5_000,
        });
        const delivered = receiptFrom(seeded);
        seeded.providerResumed.value = true;
        await runLiveHostCommand(harness.deps, {
          command: await buildSubmitCommand(harness, seeded, 230),
          hostId: seeded.hostId,
          timeoutMs: 5_000,
        });
        const resumed = receiptFrom(seeded);
        expect(resumed.delivery).toBe("resumed");
        expect({ ...resumed, delivery: "delivered" }).toEqual(delivered);
      });
    });

    it("logs and does not fail the command when the receipt write fails", async () => {
      await withTestHarness(async (harness) => {
        const logger = {
          debug: vi.fn(),
          error: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
        };
        harness.deps.logger = logger;
        const seeded = seedScenario(harness, "codex", "write-fails");
        await activeStore(harness);
        seeded.failWrites.value = true;
        const result = await runLiveHostCommand(harness.deps, {
          command: await buildStart(harness, seeded, 224),
          hostId: seeded.hostId,
          timeoutMs: 5_000,
        });
        expect(result).toMatchObject({ providerThreadId: expect.any(String) });
        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            delivery: "delivered",
            rulesReceiptWriteFailed: true,
            threadId: seeded.thread.id,
          }),
          expect.stringContaining("rules receipt could not be written"),
        );
        expect(seeded.writes.size).toBe(0);
      });
    });

    it("writes no receipt in dark mode", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "dark-no-receipt");
        await runLiveHostCommand(harness.deps, {
          command: await buildStart(harness, seeded, 225),
          hostId: seeded.hostId,
          timeoutMs: 5_000,
        });
        expect(seeded.requestTypes).toContain("thread.start");
        expect(seeded.requestTypes).not.toContain("host.write_file");
      });
    });

    it("serves the dry-run receipt over the public route without writing", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "route");
        await activeStore(harness, "# Rules\n", "snap-route");
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
  });

  describe("resolver process", () => {
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

    it("kills the whole process tree when the resolver times out", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "tree");
        const root = path.join(harness.config.dataDir, "tree");
        await mkdir(root, { recursive: true });
        const script = path.join(root, "spawner.mjs");
        const pidPath = path.join(root, "child.pid");
        await writeFile(script, CHILD_SPAWNING_SCRIPT, "utf8");
        harness.deps.config.orchestration = {
          instructionsStore: storePath(harness),
          resolveCommand: [process.execPath, script, pidPath],
          resolveTimeoutMs: 1_500,
        };
        const error = await rejection(resolveFor(harness, seeded));
        expect(error).toMatchObject({
          body: { code: "instructions_resolve_timeout" },
        });
        const pid = Number(await readFile(pidPath, "utf8"));
        expect(Number.isInteger(pid) && pid > 0).toBe(true);
        expect(await pidIsGone(pid)).toBe(true);
      });
    });

    it("fails retryably when the resolver prints more than the output cap", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "overflow");
        const fake = await installFakeResolve(
          path.join(harness.config.dataDir, "fake"),
          [{ repeat: { char: "x", count: 5 * 1024 * 1024 } }],
        );
        configure(harness, fake);
        const error = await rejection(resolveFor(harness, seeded));
        expect(error).toMatchObject({
          status: 503,
          body: {
            code: "instructions_resolve_failed",
            retryable: true,
            details: { outputOverflow: true },
          },
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
  });

  describe("digest verification", () => {
    it("re-resolves once on a digest mismatch and then succeeds", async () => {
      await withTestHarness(async (harness) => {
        const seeded = seedScenario(harness, "codex", "mismatch-ok");
        const snapshot = await writeSnapshot({
          agents: "# Rules\n",
          id: "snap-m",
          root: snapshotRoot(harness),
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
          root: snapshotRoot(harness),
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
          root: snapshotRoot(harness),
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

  it("does not create the store directory itself", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedScenario(harness, "codex", "no-create");
      const fake = await installFakeResolve(
        path.join(harness.config.dataDir, "fake"),
        [{ result: { source: "dark" } }],
      );
      configure(harness, fake);
      await resolveFor(harness, seeded);
      await expect(stat(storePath(harness))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
