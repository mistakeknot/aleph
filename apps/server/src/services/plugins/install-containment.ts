import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import type {
  PluginInstallContainment,
  PluginInstallContainmentState,
  PluginInstallServerIdentity,
} from "@bb/server-contract";

const exec = promisify(execFile);
const storage = new AsyncLocalStorage<PluginInstallContainment>();
let managerRoot: string | undefined;
export const CONTAINED_INSTALL_READY = "BB_INSTALL_CONTAINMENT_READY";
const launcherSource = `
  const fs = require('node:fs');
  const { spawn } = require('node:child_process');
  const { createInterface } = require('node:readline');
  const id = process.argv[1];
  if (!fs.readFileSync('/proc/self/cgroup', 'utf8').split('/').some(part => part.trim() === id)) process.exit(125);
  let received = false;
  const input = createInterface({ input: process.stdin });
  input.once('line', line => {
    received = true;
    input.close();
    try {
      const payload = JSON.parse(line);
      if (typeof payload.command !== 'string' || !Array.isArray(payload.args) || !payload.args.every(arg => typeof arg === 'string')) process.exit(125);
      const child = spawn(payload.command, payload.args, { stdio: ['ignore', 'inherit', 'inherit'] });
      child.once('error', error => { process.stderr.write(String(error)); process.exit(125); });
      child.once('exit', code => process.exit(code ?? 125));
    } catch { process.exit(125); }
  });
  input.once('close', () => { if (!received) process.exit(125); });
  process.stdout.once('error', () => process.exit(125));
  process.stdout.write('${CONTAINED_INSTALL_READY}\\n');
`;

export function containmentIdFor(requestKey: string): string {
  return `bbplugininstall${createHash("sha256").update(requestKey).digest("hex")}.slice`;
}

function processStartTime(pid: number): string {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const startTime = text.slice(text.lastIndexOf(") ") + 2).split(" ")[19];
  if (!startTime || !/^\d+$/.test(startTime))
    throw new Error("process start time unavailable");
  return startTime;
}

export function installServerIdentity(): PluginInstallServerIdentity {
  if (process.platform !== "linux")
    throw new Error(
      "install containment requires Linux cgroup v2 and a user service manager",
    );
  return { pid: process.pid, startTime: processStartTime(process.pid) };
}

export function originalInstallServerExited(
  server: PluginInstallServerIdentity,
): boolean | null {
  try {
    return processStartTime(server.pid) !== server.startTime;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? true
      : null;
  }
}

async function cgroupRoot(): Promise<string> {
  if (process.platform !== "linux")
    throw new Error("install containment unavailable");
  if (managerRoot !== undefined) return managerRoot;
  const result = await exec(
    "systemctl",
    ["--user", "show", "--property=ControlGroup", "--value"],
    { timeout: 15_000 },
  );
  const group = result.stdout.trim();
  if (!group.startsWith("/") || group.includes("\n") || group.includes("\0"))
    throw new Error("user manager cgroup unavailable");
  const root = resolve("/sys/fs/cgroup", `.${group}`);
  if (!root.startsWith("/sys/fs/cgroup/"))
    throw new Error("invalid user manager cgroup");
  await readFile(resolve(root, "cgroup.events"), "utf8");
  managerRoot = root;
  return root;
}

export async function installContainmentSupported(): Promise<boolean> {
  try {
    await cgroupRoot();
    await exec("systemd-run", ["--version"], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export async function inspectInstallContainment(
  requestKey: string,
): Promise<PluginInstallContainmentState> {
  try {
    const root = await cgroupRoot();
    try {
      const events = await readFile(
        resolve(root, containmentIdFor(requestKey), "cgroup.events"),
        "utf8",
      );
      if (/^populated 1$/m.test(events)) return "nonempty";
      if (/^populated 0$/m.test(events)) return "empty";
      return "unknown";
    } catch (error) {
      return error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
        ? "gone"
        : "unknown";
    }
  } catch {
    return "unknown";
  }
}

function scopeArgs(id: string, command: string, args: string[]): string[] {
  return [
    "--user",
    "--scope",
    "--quiet",
    "--collect",
    `--slice=${id}`,
    `--unit=bbpluginphase${randomUUID().replaceAll("-", "")}.scope`,
    "--",
    command,
    ...args,
  ];
}

export function containedInstallCommand(
  command: string,
  args: string[],
): { command: string; args: string[]; payload?: string } {
  const containment = storage.getStore();
  return containment === undefined
    ? { command, args }
    : {
        command: "systemd-run",
        args: scopeArgs(containment.id, process.execPath, [
          "-e",
          launcherSource,
          containment.id,
        ]),
        payload: JSON.stringify({ command, args }),
      };
}

export function currentInstallContainment():
  | PluginInstallContainment
  | undefined {
  return storage.getStore();
}

export async function runContainedInstall<T>(
  containment: PluginInstallContainment,
  run: () => Promise<T>,
  draining: () => void,
): Promise<T> {
  return storage.run(containment, async () => {
    try {
      if (!(await installContainmentSupported()))
        throw new Error("install containment unavailable");
      const initial = await inspectInstallContainment(containment.requestKey);
      if (initial !== "empty" && initial !== "gone")
        throw new Error("install containment is not empty");
      return await run();
    } finally {
      draining();
      for (;;) {
        const state = await inspectInstallContainment(containment.requestKey);
        if (state === "empty" || state === "gone") break;
        await setTimeout(50);
      }
    }
  });
}
