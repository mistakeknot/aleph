import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_LAUNCHER_MARKER } from "@bb/config/cli-command";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureEntry = join(
  packageRoot,
  "test",
  "fixtures",
  "launcher-loop-entry.mjs",
);
const SHIM_DEPTH_LIMIT = 5;
const RUN_TIMEOUT_SECONDS = 90;
const TASKS_MAX = 40;

interface LoopRunResult {
  bundledEnv: string[];
  bundledRuns: string[];
  exitCode: number | null;
  shimDepths: number[];
  stderr: string;
}

interface LoopRunArgs {
  override: string;
  workDir: string;
}

function scopeEnv(): NodeJS.ProcessEnv {
  return {
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    PATH: process.env.PATH,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
  };
}

function canUseSystemdScope(): boolean {
  if (process.platform !== "linux") {
    return false;
  }
  const probe = spawnSync(
    "systemd-run",
    ["--user", "--scope", "-q", "-p", `TasksMax=${TASKS_MAX}`, "true"],
    { env: scopeEnv(), stdio: "ignore", timeout: 10_000 },
  );
  return probe.status === 0;
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function renderDepthLimitedShim(args: {
  entry: string;
  marked: boolean;
}): string {
  return [
    "#!/bin/sh",
    ...(args.marked ? [`# ${CLI_LAUNCHER_MARKER}`] : []),
    "depth=$(( ${SHIM_DEPTH:-0} + 1 ))",
    'printf "%s\\n" "$depth" >> "$SHIM_LOG"',
    `if [ "$depth" -gt ${SHIM_DEPTH_LIMIT} ]; then`,
    '  echo "shim depth limit reached" >&2',
    "  exit 99",
    "fi",
    "export SHIM_DEPTH=$depth",
    args.entry,
    "",
  ].join("\n");
}

function prepareWorkDir(): string {
  const workDir = mkdtempSync(join(tmpdir(), "bb-launcher-loop-"));
  mkdirSync(join(workDir, "host-daemon"));
  writeFileSync(
    join(workDir, "host-daemon", "bb"),
    "const fs = require('node:fs'); fs.appendFileSync(process.env.BUNDLED_LOG, 'bundled\\n'); fs.appendFileSync(process.env.BUNDLED_ENV_LOG, 'BB_CLI=' + (process.env.BB_CLI ?? '') + '\\n')",
  );
  return workDir;
}

async function runLauncherThroughOverride(
  args: LoopRunArgs,
  useScope: boolean,
): Promise<LoopRunResult> {
  const shimLog = join(args.workDir, "shim.log");
  const bundledLog = join(args.workDir, "bundled.log");
  const bundledEnvLog = join(args.workDir, "bundled-env.log");
  const command = [
    "timeout",
    "--kill-after=5",
    String(RUN_TIMEOUT_SECONDS),
    process.execPath,
    "--conditions=source",
    "--import",
    "tsx",
    fixtureEntry,
    "arg",
  ];
  const scoped = useScope
    ? [
        "systemd-run",
        "--user",
        "--scope",
        "-q",
        "-p",
        `TasksMax=${TASKS_MAX}`,
        ...command,
      ]
    : command;
  const child = spawn(scoped[0] ?? "", scoped.slice(1), {
    cwd: packageRoot,
    env: {
      ...scopeEnv(),
      BB_CLI: args.override,
      BUNDLED_ENV_LOG: bundledEnvLog,
      BUNDLED_LOG: bundledLog,
      FIXTURE_DATA_DIR: args.workDir,
      FIXTURE_NODE: process.execPath,
      FIXTURE_ENTRY: fixtureEntry,
      HOME: args.workDir,
      SHIM_LOG: shimLog,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  const exitCode = await new Promise<number | null>((resolve) => {
    child.once("close", (code) => resolve(code));
  });
  const readLines = (path: string): string[] =>
    existsSync(path)
      ? readFileSync(path, "utf8").split("\n").filter(Boolean)
      : [];
  return {
    bundledEnv: readLines(bundledEnvLog),
    bundledRuns: readLines(bundledLog),
    exitCode,
    shimDepths: readLines(shimLog).map(Number),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

describe.skipIf(process.platform === "win32")(
  "bb launcher recursion guard",
  () => {
    let useScope = false;
    const workDirs: string[] = [];

    beforeAll(() => {
      useScope = canUseSystemdScope();
    });

    afterAll(() => {
      for (const dir of workDirs) {
        rmSync(dir, { force: true, recursive: true });
      }
    });

    function newWorkDir(): string {
      const dir = prepareWorkDir();
      workDirs.push(dir);
      return dir;
    }

    it("starts the bundled CLI directly when a shim in the BB_CLI path execs this launcher", async () => {
      const workDir = newWorkDir();
      const shim = join(workDir, "bb");
      writeExecutable(
        shim,
        renderDepthLimitedShim({
          entry: `exec '${process.execPath}' --conditions=source --import tsx '${fixtureEntry}' "$@"`,
          marked: false,
        }),
      );

      const result = await runLauncherThroughOverride(
        { override: shim, workDir },
        useScope,
      );

      expect(result.shimDepths).toEqual([]);
      expect(result.bundledRuns).toEqual(["bundled"]);
      expect(result.bundledEnv).toEqual(["BB_CLI="]);
      expect(result.exitCode).toBe(0);
    }, 120_000);

    it("follows a symlink to a shim that execs this launcher", async () => {
      const workDir = newWorkDir();
      const shim = join(workDir, "real-bb");
      writeExecutable(
        shim,
        renderDepthLimitedShim({
          entry: `exec '${process.execPath}' --conditions=source --import tsx '${fixtureEntry}' "$@"`,
          marked: false,
        }),
      );
      const link = join(workDir, "bb");
      symlinkSync(shim, link);

      const result = await runLauncherThroughOverride(
        { override: link, workDir },
        useScope,
      );

      expect(result.shimDepths).toEqual([]);
      expect(result.bundledRuns).toEqual(["bundled"]);
      expect(result.bundledEnv).toEqual(["BB_CLI="]);
      expect(result.exitCode).toBe(0);
    }, 120_000);

    it("ignores a marked machine launcher shim as BB_CLI", async () => {
      const workDir = newWorkDir();
      const shim = join(workDir, "bb");
      writeExecutable(
        shim,
        renderDepthLimitedShim({
          entry:
            'exec "$FIXTURE_NODE" --conditions=source --import tsx "$FIXTURE_ENTRY" "$@"',
          marked: true,
        }),
      );

      const result = await runLauncherThroughOverride(
        { override: shim, workDir },
        useScope,
      );

      expect(result.shimDepths).toEqual([]);
      expect(result.bundledRuns).toEqual(["bundled"]);
      expect(result.bundledEnv).toEqual(["BB_CLI="]);
      expect(result.exitCode).toBe(0);
    }, 120_000);

    it("stops after one re-exec when the shim hides its target from the static check", async () => {
      const workDir = newWorkDir();
      const shim = join(workDir, "bb");
      writeExecutable(
        shim,
        renderDepthLimitedShim({
          entry:
            'exec "$FIXTURE_NODE" --conditions=source --import tsx "$FIXTURE_ENTRY" "$@"',
          marked: false,
        }),
      );

      const result = await runLauncherThroughOverride(
        { override: shim, workDir },
        useScope,
      );

      expect(result.shimDepths.length).toBeLessThanOrEqual(1);
      expect(Math.max(0, ...result.shimDepths)).toBeLessThan(SHIM_DEPTH_LIMIT);
      expect(result.bundledRuns).toEqual([]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("refusing to start the bb launcher");
    }, 120_000);
  },
);
