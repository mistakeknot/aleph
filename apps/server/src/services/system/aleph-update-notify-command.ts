import { spawn } from "node:child_process";
import type { AlephUpdateNoticeSink } from "./aleph-update-composition.js";

export const ALEPH_UPDATE_NOTIFY_COMMAND_ENV = "ALEPH_UPDATE_NOTIFY_COMMAND";
export const ALEPH_UPDATE_NOTIFY_MAX_BYTES = 512;
const DEFAULT_TIMEOUT_MS = 5_000;

function parseArgv(value: string | undefined): string[] | null {
  if (value === undefined || value.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((part) => typeof part === "string" && part !== "")
    ) {
      return parsed as string[];
    }
  } catch {}
  return null;
}

function bound(message: string): string {
  const buffer = Buffer.from(message, "utf8");
  if (buffer.length <= ALEPH_UPDATE_NOTIFY_MAX_BYTES) return message;
  return buffer
    .subarray(0, ALEPH_UPDATE_NOTIFY_MAX_BYTES)
    .toString("utf8")
    .replace(/�+$/u, "");
}

export function createAlephUpdateNotifyFromEnv(
  env: NodeJS.ProcessEnv,
  options: { timeoutMs?: number } = {},
): AlephUpdateNoticeSink {
  const argv = parseArgv(env[ALEPH_UPDATE_NOTIFY_COMMAND_ENV]);
  if (argv === null) return async () => {};
  const [file, ...rest] = argv as [string, ...string[]];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (message) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(file, rest, {
        killSignal: "SIGKILL",
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        timeout: timeoutMs,
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `aleph update notice command ended with ${signal ?? `code ${code}`}`,
            ),
          );
      });
      child.stdin.on("error", () => {});
      child.stdin.end(bound(message));
    });
}
