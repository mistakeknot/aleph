import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(here, "..", "..");
const scenarioPath = join(here, "capped-scenarios.ts");
const MIB = 1024 * 1024;

export type VolumeKind =
  | "privileged-loop-ext4"
  | "privileged-hdiutil"
  | "rehearsal-tmpfs";

export interface PlanStep {
  command: string;
  args: string[];
}

export interface VolumePlan {
  kind: Exclude<VolumeKind, "rehearsal-tmpfs">;
  setup: PlanStep[];
  teardown: PlanStep[];
}

export interface PlanInput {
  imagePath: string;
  mountPoint: string;
  sizeBytes: number;
}

function wholeMiB(sizeBytes: number): number {
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes % MIB !== 0) {
    throw new RangeError("capped volume size must be a whole number of MiB");
  }
  return sizeBytes / MIB;
}

export function planLinuxLoop(input: PlanInput): VolumePlan {
  const mib = wholeMiB(input.sizeBytes);
  return {
    kind: "privileged-loop-ext4",
    setup: [
      { command: "truncate", args: ["-s", `${mib}M`, input.imagePath] },
      { command: "mkfs.ext4", args: ["-F", "-q", input.imagePath] },
      {
        command: "mount",
        args: ["-o", "loop,nosuid,nodev", input.imagePath, input.mountPoint],
      },
    ],
    teardown: [
      { command: "umount", args: [input.mountPoint] },
      { command: "rm", args: ["-f", input.imagePath] },
    ],
  };
}

export function planMacosImage(input: PlanInput): VolumePlan {
  const mib = wholeMiB(input.sizeBytes);
  return {
    kind: "privileged-hdiutil",
    setup: [
      {
        command: "hdiutil",
        args: [
          "create",
          "-size",
          `${mib}m`,
          "-fs",
          "HFS+",
          "-volname",
          "sscapped",
          "-ov",
          input.imagePath,
        ],
      },
      {
        command: "hdiutil",
        args: [
          "attach",
          input.imagePath,
          "-mountpoint",
          input.mountPoint,
          "-nobrowse",
        ],
      },
    ],
    teardown: [
      { command: "hdiutil", args: ["detach", input.mountPoint, "-force"] },
      { command: "rm", args: ["-f", input.imagePath] },
    ],
  };
}

export function rehearsalWrapperArgs(
  mountPoint: string,
  sizeBytes: number,
  childArgv: readonly string[],
): { command: string; args: string[] } {
  const mib = wholeMiB(sizeBytes);
  return {
    command: "unshare",
    args: [
      "-Urm",
      "sh",
      "-c",
      'mount -t tmpfs -o size="$2" tmpfs "$1" && shift 2 && exec "$@"',
      "sh",
      mountPoint,
      `${mib}m`,
      ...childArgv,
    ],
  };
}

function onPath(tool: string): boolean {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory !== "" && existsSync(join(directory, tool))) return true;
  }
  return false;
}

function run(step: PlanStep): { ok: boolean; stderr: string } {
  const result = spawnSync(step.command, step.args, { encoding: "utf8" });
  return { ok: result.status === 0, stderr: result.stderr ?? "" };
}

export type VolumeRun =
  | { status: "not-run"; reason: string }
  | {
      status: "ran";
      kind: VolumeKind;
      scenario: string;
      result: unknown;
      stderr: string;
    };

export interface RunOptions {
  scenario: string;
  sizeBytes: number;
  allowRehearsal?: boolean;
  scenarioOptions?: Record<string, unknown>;
}

function childArgv(
  mountPoint: string,
  scenario: string,
  options: Record<string, unknown>,
): string[] {
  return [
    process.execPath,
    "--import",
    "tsx",
    scenarioPath,
    mountPoint,
    scenario,
    JSON.stringify(options),
  ];
}

function parseResult(stdout: string): unknown {
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "null");
}

export function privilegedUnavailableReason(): string | null {
  if (process.platform === "linux") {
    if (process.getuid?.() !== 0) {
      return "not-run: loop-mounted ext4 needs root and this process is unprivileged";
    }
    for (const tool of ["truncate", "mkfs.ext4", "mount", "umount"]) {
      if (!onPath(tool)) return `not-run: ${tool} is not installed`;
    }
    return null;
  }
  if (process.platform === "darwin") {
    return onPath("hdiutil") ? null : "not-run: hdiutil is not installed";
  }
  return `not-run: no capped-volume recipe for platform ${process.platform}`;
}

export function rehearsalUnavailableReason(): string | null {
  if (process.platform !== "linux") return "not-run: rehearsal is Linux-only";
  if (!onPath("unshare")) return "not-run: unshare is not installed";
  const probe = spawnSync(
    "unshare",
    [
      "-Urm",
      "sh",
      "-c",
      'mount -t tmpfs -o size=1m tmpfs "$1"',
      "sh",
      tmpdir(),
    ],
    { encoding: "utf8" },
  );
  if (probe.status !== 0) {
    return "not-run: unprivileged user and mount namespaces are unavailable";
  }
  return null;
}

export function runOnPrivilegedVolume(options: RunOptions): VolumeRun {
  const missing = privilegedUnavailableReason();
  if (missing !== null) return { status: "not-run", reason: missing };
  const work = mkdtempSync(join(tmpdir(), "ss-capped-"));
  const mountPoint = join(work, "mnt");
  const imagePath = join(
    work,
    process.platform === "darwin" ? "volume.dmg" : "volume.img",
  );
  const input: PlanInput = {
    imagePath,
    mountPoint,
    sizeBytes: options.sizeBytes,
  };
  const plan =
    process.platform === "darwin"
      ? planMacosImage(input)
      : planLinuxLoop(input);
  const mounted: PlanStep[] = [];
  try {
    mkdirSync(mountPoint, { recursive: true });
    for (const step of plan.setup) {
      const outcome = run(step);
      if (!outcome.ok) {
        return {
          status: "not-run",
          reason: `not-run: ${step.command} failed: ${outcome.stderr.trim()}`,
        };
      }
      mounted.push(step);
    }
    const child = spawnSync(
      process.execPath,
      childArgv(
        mountPoint,
        options.scenario,
        options.scenarioOptions ?? {},
      ).slice(1),
      { encoding: "utf8", cwd: packageDir },
    );
    if (child.status !== 0) {
      throw new Error(
        `scenario ${options.scenario} failed on the capped volume: ${child.stderr}`,
      );
    }
    return {
      status: "ran",
      kind: plan.kind,
      scenario: options.scenario,
      result: parseResult(child.stdout),
      stderr: child.stderr,
    };
  } finally {
    if (mounted.length > 0) {
      for (const step of plan.teardown) run(step);
    }
    rmSync(work, { recursive: true, force: true });
  }
}

export function runOnRehearsalVolume(options: RunOptions): VolumeRun {
  const missing = rehearsalUnavailableReason();
  if (missing !== null) return { status: "not-run", reason: missing };
  const work = mkdtempSync(join(tmpdir(), "ss-rehearsal-"));
  const mountPoint = join(work, "mnt");
  mkdirSync(mountPoint, { recursive: true });
  try {
    const wrapper = rehearsalWrapperArgs(
      mountPoint,
      options.sizeBytes,
      childArgv(mountPoint, options.scenario, options.scenarioOptions ?? {}),
    );
    const child = spawnSync(wrapper.command, wrapper.args, {
      encoding: "utf8",
      cwd: packageDir,
    });
    if (child.status !== 0) {
      throw new Error(
        `scenario ${options.scenario} failed on the rehearsal volume: ${child.stderr}`,
      );
    }
    return {
      status: "ran",
      kind: "rehearsal-tmpfs",
      scenario: options.scenario,
      result: parseResult(child.stdout),
      stderr: child.stderr,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
