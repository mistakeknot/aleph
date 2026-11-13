import { experimental_spawnHostProcess as spawn } from "@get-bb/plugin-sdk/process";
import { isAbsolute } from "node:path";
import { z } from "zod";

export const UNSUPPORTED_CHECK =
  "pre-run check not yet supported for this environment";
const localExecution = z.object({
  permissionMode: z.literal("full"),
  targetThreadId: z.undefined().optional(),
  environment: z.object({
    type: z.literal("host"),
    hostId: z.string(),
    workspace: z.object({
      type: z.literal("unmanaged"),
      path: z.string().refine(isAbsolute),
      branch: z.undefined().optional(),
    }),
  }),
});

export function supportsPreRunCheck(
  execution: unknown,
  serverHostId: string | null,
): boolean {
  const parsed = localExecution.safeParse(execution);
  return (
    parsed.success &&
    serverHostId !== null &&
    parsed.data.environment.hostId === serverHostId
  );
}

export async function runPreRunCheck(args: {
  command: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<{
  exitCode: number | null;
  stderr: string;
  reason: string | null;
  durationMs: number;
}> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stderr = Buffer.alloc(0);
    let reason: string | null = null;
    const child = spawn("sh", ["-c", args.command], {
      cwd: args.cwd,
      env: process.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "pipe"],
    });
    const kill = () => {
      try {
        if (process.platform !== "win32" && child.pid !== undefined)
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(-2048);
    });
    child.once("error", () => {
      reason = "check failed to spawn";
    });
    const timer = setTimeout(() => {
      reason = "check timed out";
      kill();
    }, args.timeoutMs ?? 60_000);
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      kill();
      const tail = stderr.toString("utf8");
      resolve({
        exitCode,
        stderr: Buffer.from(tail).byteLength <= 2048 ? tail : tail.slice(1),
        reason,
        durationMs: Date.now() - started,
      });
    });
  });
}
