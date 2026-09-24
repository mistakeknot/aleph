import { spawn as nodeSpawn } from "node:child_process";
import { readFile as nodeReadFile } from "node:fs/promises";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { poolExecHostContract } from "./exec-contract.js";

const OUTPUT_LIMIT_BYTES = 900_000;
const INPUT_LIMIT_BYTES = 8 << 20;

interface PoolExecChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "spawn", listener: () => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

interface PoolExecHostDependencies {
  env: NodeJS.ProcessEnv;
  readFile(path: string): Promise<Buffer>;
  spawn(
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      env: NodeJS.ProcessEnv;
      stdio: ["pipe", "pipe", "pipe"];
    },
  ): PoolExecChild;
}

function redact(value: string, token: string): string {
  return value.split(token).join("[REDACTED]");
}

function codexArgs(args: readonly string[], baseUrl: string): string[] {
  return [
    "-c",
    'model_provider="bb-account-pool"',
    "-c",
    'model_providers.bb-account-pool.name="BB Account Pooler"',
    "-c",
    `model_providers.bb-account-pool.base_url=${JSON.stringify(baseUrl)}`,
    "-c",
    'model_providers.bb-account-pool.wire_api="responses"',
    "-c",
    'model_providers.bb-account-pool.env_key="CODEX_POOL_AUTH_TOKEN"',
    "-c",
    "model_providers.bb-account-pool.requires_openai_auth=false",
    "-c",
    "model_providers.bb-account-pool.supports_websockets=false",
    ...args,
  ];
}

export function createAccountPoolHostEntry(deps: PoolExecHostDependencies) {
  const active = new Set<PoolExecChild>();

  return experimental_defineHostEntry({
    contract: poolExecHostContract,
    handlers: {
      async run(input, context) {
        let stdin: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        if (input.stdinPath !== null) {
          try {
            stdin = await deps.readFile(input.stdinPath);
          } catch (error) {
            return {
              started: false,
              exitCode: 1,
              stdout: "",
              stderr: `Unable to read ${input.provider} stdin file: ${redact(error instanceof Error ? error.message : String(error), input.token)}\n`,
            };
          }
          if (stdin.length > INPUT_LIMIT_BYTES) {
            return {
              started: false,
              exitCode: 1,
              stdout: "",
              stderr: `${input.provider} stdin file exceeds 8 MiB.\n`,
            };
          }
        }
        return new Promise((resolve) => {
          const env = { ...deps.env };
          let args = [...input.args];
          if (input.provider === "codex") {
            delete env.OPENAI_API_KEY;
            delete env.CODEX_API_KEY;
            env.CODEX_POOL_AUTH_TOKEN = input.token;
            env.CODEX_OPENAI_BASE_URL = input.baseUrl;
            args = codexArgs(args, input.baseUrl);
          } else {
            delete env.ANTHROPIC_API_KEY;
            env.ANTHROPIC_BASE_URL = input.baseUrl;
            env.ANTHROPIC_AUTH_TOKEN = input.token;
            env.ENABLE_TOOL_SEARCH = "true";
          }

          let child: PoolExecChild;
          try {
            child = deps.spawn(input.command, args, {
              ...(input.cwd === null ? {} : { cwd: input.cwd }),
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch (error) {
            resolve({
              started: false,
              exitCode: 1,
              stdout: "",
              stderr: `Unable to start ${input.provider}: ${redact(error instanceof Error ? error.message : String(error), input.token)}\n`,
            });
            return;
          }

          active.add(child);
          let started = false;
          let settled = false;
          let outputBytes = 0;
          let outputOverflow = false;
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          const append = (target: Buffer[], chunk: unknown): void => {
            if (outputOverflow) return;
            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(String(chunk));
            outputBytes += buffer.length;
            if (outputBytes > OUTPUT_LIMIT_BYTES) {
              outputOverflow = true;
              child.kill("SIGTERM");
              return;
            }
            target.push(buffer);
          };
          child.stdout.on("data", (chunk) => append(stdout, chunk));
          child.stderr.on("data", (chunk) => append(stderr, chunk));
          child.stdin.on("error", () => {});
          child.stdin.end(stdin);

          const cancel = (): void => {
            child.kill("SIGTERM");
          };
          context.signal.addEventListener("abort", cancel, { once: true });
          child.once("spawn", () => {
            started = true;
          });
          child.once("error", (error) => {
            if (settled) return;
            settled = true;
            active.delete(child);
            context.signal.removeEventListener("abort", cancel);
            resolve({
              started,
              exitCode: 1,
              stdout: "",
              stderr: `Unable to start ${input.provider}: ${redact(error.message, input.token)}\n`,
            });
          });
          child.once("close", (code) => {
            if (settled) return;
            settled = true;
            active.delete(child);
            context.signal.removeEventListener("abort", cancel);
            if (outputOverflow) {
              resolve({
                started: true,
                exitCode: 1,
                stdout: "",
                stderr: `${input.provider} output exceeded the safe bb pool exec limit.\n`,
              });
              return;
            }
            resolve({
              started,
              exitCode:
                code === null || code < 0 || code > 255 ? 1 : Math.trunc(code),
              stdout: redact(
                Buffer.concat(stdout).toString("utf8"),
                input.token,
              ),
              stderr: redact(
                Buffer.concat(stderr).toString("utf8"),
                input.token,
              ),
            });
          });
        });
      },
    },
    dispose() {
      for (const child of active) child.kill("SIGTERM");
      active.clear();
    },
  });
}

export default createAccountPoolHostEntry({
  env: process.env,
  readFile: nodeReadFile,
  spawn(command, args, options) {
    return nodeSpawn(command, [...args], options);
  },
});
