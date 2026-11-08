import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_INSTRUCTIONS_RESOLVE_TIMEOUT_MS } from "@bb/config/bb-app-managed-config";
import {
  isPathWithinDirectory,
  killProcessGroup,
  spawnPortableOutputProcess,
} from "@bb/process-utils";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { OrchestrationRuntimeConfig, ServerLogger } from "../../types.js";
import { isFsErrorWithCode } from "../lib/fs-errors.js";
import { readDataDirAgentInstructions } from "./workspace-agent-instructions.js";

export const INSTRUCTIONS_STUB_MARKER = "<!-- aleph-instructions-stub v1 -->";

export const INSTRUCTIONS_DIR_PLACEHOLDER = "{instructions_dir}";

export const DATA_DIR_INSTRUCTIONS_MARKER_FILE = ".aleph-instructions";

export const INSTRUCTIONS_STORE_AGENTS_RELATIVE_PATH = "docs/AGENTS.md";

export const DEFAULT_INSTRUCTIONS_RESOLVE_COMMAND: readonly string[] = [
  "orch",
  "instructions",
  "resolve",
  "--json",
];

const RESOLVE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const instructionsResolveFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  bytes: z.number().int().nonnegative().optional(),
});

export const instructionsResolveResultSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("dark") }),
  z.object({
    source: z.enum(["active", "lkg"]),
    snapshotId: z.string().min(1),
    mode: z.enum(["legacy", "aleph-append"]),
    directory: z.string().refine((value) => path.isAbsolute(value), {
      message: "directory must be an absolute path",
    }),
    files: z.array(instructionsResolveFileSchema),
  }),
]);

export type InstructionsResolveResult = z.infer<
  typeof instructionsResolveResultSchema
>;

export type InstructionsSource = "dark" | "active" | "lkg";

export interface InstructionsSectionRecord {
  header: string | null;
  bytes: number;
  sha256: string;
}

export type RulesReceiptPurpose = "start" | "turn" | "dry-run";

export type RulesReceiptDelivery = "delivered" | "resumed" | "dry-run";

export interface RulesReceipt {
  version: 1;
  delivery: RulesReceiptDelivery;
  threadId: string;
  snapshotId: string | null;
  mode: string | null;
  source: InstructionsSource;
  instructionsSha256: string;
  instructionsBytes: number;
  sections: InstructionsSectionRecord[];
}

export interface InstructionsSectionText {
  text: string;
  source: InstructionsSource;
  snapshotId: string | null;
  mode: string | null;
  header: string;
}

interface InstructionsConfigDeps {
  config: { dataDir: string; orchestration?: OrchestrationRuntimeConfig };
  logger: ServerLogger;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function startsWithStubMarker(text: string): boolean {
  return text
    .replace(/^﻿/u, "")
    .trimStart()
    .startsWith(INSTRUCTIONS_STUB_MARKER);
}

function stubRefusal(origin: string): ApiError {
  return new ApiError(
    409,
    "instructions_stub_refused",
    `The user instructions from ${origin} are a stub document, not rules. The thread was not started.`,
    { retryable: false },
  );
}

function blocked(code: string, message: string, details?: unknown): ApiError {
  return new ApiError(409, code, message, {
    retryable: false,
    ...(details !== undefined ? { details } : {}),
  });
}

function dataDirMarkerExists(dataDir: string): boolean {
  try {
    fs.statSync(path.join(dataDir, DATA_DIR_INSTRUCTIONS_MARKER_FILE));
    return true;
  } catch (error) {
    if (error instanceof Error && isFsErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw blocked(
      "instructions_marker_unreadable",
      "The instructions marker in the data directory could not be inspected. The thread was not started.",
    );
  }
}

interface RunResolveArgs {
  command: readonly string[];
  dataDir: string;
  store: string;
  timeoutMs: number;
}

function resolveFailure(details: unknown): ApiError {
  return new ApiError(
    503,
    "instructions_resolve_failed",
    "Resolving the instructions store failed. The thread was not started.",
    { retryable: true, details },
  );
}

function runResolveCommand(args: RunResolveArgs): Promise<string> {
  const [executable, ...baseArgs] = args.command;
  if (executable === undefined) {
    return Promise.reject(
      new ApiError(
        503,
        "instructions_resolve_failed",
        "The instructions resolve command is empty.",
        { retryable: true },
      ),
    );
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrText = "";
    const child = spawnPortableOutputProcess({
      command: executable,
      args: [...baseArgs, "--store", args.store, "--data-dir", args.dataDir],
      detached: true,
    });
    const killTree = () => {
      killProcessGroup({ child, signal: "SIGKILL" });
    };
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree();
      finish();
    };
    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new ApiError(
            503,
            "instructions_resolve_timeout",
            `Resolving the instructions store did not finish within ${args.timeoutMs} ms. Try again.`,
            { retryable: true, details: { timeoutMs: args.timeoutMs } },
          ),
        ),
      );
    }, args.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > RESOLVE_MAX_OUTPUT_BYTES) {
        settle(() => reject(resolveFailure({ outputOverflow: true })));
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrText.length < 2000) {
        stderrText += chunk.toString("utf8");
      }
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(() =>
        reject(
          resolveFailure({
            exitCode: null,
            spawnError: error.code ?? "spawn_error",
            stderr: stderrText.slice(0, 2000),
          }),
        ),
      );
    });
    child.on("close", (code) => {
      settle(() => {
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks).toString("utf8"));
          return;
        }
        reject(
          resolveFailure({
            exitCode: code,
            spawnError: null,
            stderr: stderrText.slice(0, 2000),
          }),
        );
      });
    });
  });
}

async function resolveStore(
  orchestration: OrchestrationRuntimeConfig,
  store: string,
  dataDir: string,
): Promise<InstructionsResolveResult> {
  const stdout = await runResolveCommand({
    command:
      orchestration.resolveCommand ?? DEFAULT_INSTRUCTIONS_RESOLVE_COMMAND,
    dataDir,
    store,
    timeoutMs:
      orchestration.resolveTimeoutMs ?? DEFAULT_INSTRUCTIONS_RESOLVE_TIMEOUT_MS,
  });
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    throw new ApiError(
      503,
      "instructions_resolve_invalid",
      "The instructions resolve command did not return JSON. The thread was not started.",
      { retryable: true },
    );
  }
  const parsed = instructionsResolveResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(
      503,
      "instructions_resolve_invalid",
      "The instructions resolve command returned an unexpected shape. The thread was not started.",
      { retryable: true, details: parsed.error.issues.slice(0, 5) },
    );
  }
  return parsed.data;
}

interface ReadResolvedAgentsArgs {
  directory: string;
  expectedSha256: string;
  snapshotId: string;
  storeRoot: string;
}

interface ResolvedAgents {
  directory: string;
  text: string;
}

function escapesStore(snapshotId: string): ApiError {
  return blocked(
    "instructions_path_escape",
    "The resolved instructions snapshot points outside the configured instructions store. The thread was not started.",
    { snapshotId },
  );
}

function canonicalPath(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function readResolvedAgents(
  args: ReadResolvedAgentsArgs,
): ResolvedAgents | null {
  const storeRoot = canonicalPath(args.storeRoot);
  if (storeRoot === null) {
    return null;
  }
  const directory = canonicalPath(args.directory);
  if (directory === null) {
    return null;
  }
  if (directory === storeRoot || !isPathWithinDirectory(storeRoot, directory)) {
    throw escapesStore(args.snapshotId);
  }
  const file = canonicalPath(
    path.join(directory, INSTRUCTIONS_STORE_AGENTS_RELATIVE_PATH),
  );
  if (file === null) {
    return null;
  }
  if (!isPathWithinDirectory(directory, file)) {
    throw escapesStore(args.snapshotId);
  }
  let content: Buffer;
  try {
    content = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (sha256Hex(content) !== args.expectedSha256) {
    return null;
  }
  return { directory, text: content.toString("utf8") };
}

type ActiveResolveResult = Extract<
  InstructionsResolveResult,
  { source: "active" | "lkg" }
>;

function requireAgentsDigest(result: ActiveResolveResult): string {
  const entry = result.files.find(
    (file) => file.path === INSTRUCTIONS_STORE_AGENTS_RELATIVE_PATH,
  );
  if (entry === undefined) {
    throw blocked(
      "instructions_agents_missing",
      `The resolved instructions snapshot does not list ${INSTRUCTIONS_STORE_AGENTS_RELATIVE_PATH}. The thread was not started.`,
    );
  }
  return entry.sha256;
}

function fillAndCheck(directory: string, text: string): string {
  if (startsWithStubMarker(text)) {
    throw stubRefusal(INSTRUCTIONS_STORE_AGENTS_RELATIVE_PATH);
  }
  const filled = text
    .split(INSTRUCTIONS_DIR_PLACEHOLDER)
    .join(directory)
    .trim();
  if (filled.length === 0) {
    throw blocked(
      "instructions_agents_empty",
      `${INSTRUCTIONS_STORE_AGENTS_RELATIVE_PATH} in the resolved snapshot is empty. The thread was not started.`,
    );
  }
  return filled;
}

function darkText(
  deps: InstructionsConfigDeps,
): InstructionsSectionText | null {
  const text = readDataDirAgentInstructions(deps.logger, deps.config.dataDir);
  if (text === null) return null;
  if (startsWithStubMarker(text)) {
    throw stubRefusal("<dataDir>/AGENTS.md");
  }
  return {
    text,
    source: "dark",
    snapshotId: null,
    mode: null,
    header: "The following user instructions come from <dataDir>/AGENTS.md:",
  };
}

function requireNotDark(): never {
  throw blocked(
    "instructions_dark_after_init",
    "The instructions store reported no instructions, but the data directory is already marked as using an instructions store. The thread was not started.",
  );
}

export async function resolveUserInstructionsSection(
  deps: InstructionsConfigDeps,
): Promise<InstructionsSectionText | null> {
  const dataDir = deps.config.dataDir;
  const orchestration = deps.config.orchestration;
  const store = orchestration?.instructionsStore;
  if (orchestration === undefined || store === undefined) {
    if (dataDirMarkerExists(dataDir)) {
      throw blocked(
        "instructions_store_not_configured",
        "The data directory is marked as using an instructions store, but orchestration.instructionsStore is not configured. The thread was not started.",
      );
    }
    return darkText(deps);
  }

  const initialized = dataDirMarkerExists(dataDir);
  let result = await resolveStore(orchestration, store, dataDir);
  if (result.source === "dark") {
    return initialized ? requireNotDark() : darkText(deps);
  }

  let agents = readResolvedAgents({
    directory: result.directory,
    expectedSha256: requireAgentsDigest(result),
    snapshotId: result.snapshotId,
    storeRoot: store,
  });
  if (agents === null) {
    deps.logger.warn(
      { snapshotId: result.snapshotId, source: result.source },
      "Resolved instructions failed the digest re-check; resolving once more",
    );
    result = await resolveStore(orchestration, store, dataDir);
    if (result.source === "dark") {
      return requireNotDark();
    }
    agents = readResolvedAgents({
      directory: result.directory,
      expectedSha256: requireAgentsDigest(result),
      snapshotId: result.snapshotId,
      storeRoot: store,
    });
    if (agents === null) {
      throw blocked(
        "instructions_digest_mismatch",
        `${INSTRUCTIONS_STORE_AGENTS_RELATIVE_PATH} does not match the digest the store reported, twice. The thread was not started.`,
        { snapshotId: result.snapshotId },
      );
    }
  }
  return {
    text: fillAndCheck(agents.directory, agents.text),
    source: result.source,
    snapshotId: result.snapshotId,
    mode: result.mode,
    header: `The following user instructions come from the instructions store (${INSTRUCTIONS_STORE_AGENTS_RELATIVE_PATH}):`,
  };
}

export interface RecordedInstructionsSection {
  header: string | null;
  text: string;
}

interface BuildRulesReceiptArgs {
  delivery: RulesReceiptDelivery;
  instructions: string;
  origin: Pick<InstructionsSectionText, "mode" | "snapshotId" | "source">;
  sections: readonly RecordedInstructionsSection[];
  threadId: string;
}

export function buildRulesReceipt(args: BuildRulesReceiptArgs): RulesReceipt {
  return {
    version: 1,
    delivery: args.delivery,
    threadId: args.threadId,
    snapshotId: args.origin.snapshotId,
    mode: args.origin.mode,
    source: args.origin.source,
    instructionsSha256: sha256Hex(args.instructions),
    instructionsBytes: Buffer.byteLength(args.instructions),
    sections: args.sections.map((section) => ({
      header: section.header,
      bytes: Buffer.byteLength(section.text),
      sha256: sha256Hex(section.text),
    })),
  };
}

export function isInstructionsStoreConfigured(
  orchestration: OrchestrationRuntimeConfig | undefined,
): boolean {
  return orchestration?.instructionsStore !== undefined;
}
