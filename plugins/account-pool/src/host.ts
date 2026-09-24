import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { poolExecHostContract } from "./exec-contract.js";
import { parsePoolExecArgs } from "./exec-args.js";
import { readPoolInput } from "./exec-input.js";

const OUTPUT_LIMIT_BYTES = 900_000;

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
  readInput?: typeof readPoolInput;
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
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    ...(!args.some((arg) => arg === "--sandbox" || arg.startsWith("--sandbox="))
      ? ["--sandbox=read-only"]
      : []),
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
    "-c",
    "sandbox_workspace_write.network_access=false",
    "-c",
    'approval_policy="never"',
    ...args
      .slice(1)
      .filter(
        (arg) =>
          !["--ephemeral", "--ignore-user-config", "--ignore-rules"].includes(
            arg,
          ),
      ),
  ];
}

export function createAccountPoolHostEntry(deps: PoolExecHostDependencies) {
  const active = new Set<PoolExecChild>();
  const defaultInputDir = path.resolve(
    deps.env.HOME || homedir(),
    ".local/state/bb-account-pool/exec-input",
  );
  const claudeConfigDir = deps.env.CLAUDE_CONFIG_DIR
    ? path.resolve(deps.env.CLAUDE_CONFIG_DIR)
    : undefined;

  return experimental_defineHostEntry({
    contract: poolExecHostContract,
    handlers: {
      async run(input, context) {
        const permittedArgs = parsePoolExecArgs(input.provider, input.args);
        if (permittedArgs === null) {
          return {
            started: false,
            providerPinned: false,
            exitCode: 1,
            stdout: "",
            stderr: `${input.provider} arguments are not permitted by the Account Pooler execution allowlist.\n`,
          };
        }
        let stdin: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        if (input.stdinPath !== null) {
          try {
            stdin = await (deps.readInput ?? readPoolInput)(
              input.stdinDir ?? defaultInputDir,
              input.stdinPath,
              deps.env,
            );
          } catch (error) {
            return {
              started: false,
              providerPinned: false,
              exitCode: 1,
              stdout: "",
              stderr: `Unable to read ${input.provider} stdin file: ${redact(error instanceof Error ? error.message : String(error), input.token)}\n`,
            };
          }
        }
        return new Promise((resolve) => {
          const env = { ...deps.env };
          let args = permittedArgs;
          if (input.provider === "codex") {
            delete env.OPENAI_API_KEY;
            delete env.CODEX_API_KEY;
            env.CODEX_POOL_AUTH_TOKEN = input.token;
            env.CODEX_OPENAI_BASE_URL = input.baseUrl;
            args = codexArgs(args, input.baseUrl);
          } else {
            delete env.ANTHROPIC_API_KEY;
            if (claudeConfigDir === undefined) delete env.CLAUDE_CONFIG_DIR;
            else env.CLAUDE_CONFIG_DIR = claudeConfigDir;
            env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = "1";
            env.CLAUDE_CODE_USE_BEDROCK = "0";
            env.CLAUDE_CODE_USE_VERTEX = "0";
            env.CLAUDE_CODE_USE_FOUNDRY = "0";
            env.ANTHROPIC_BASE_URL = input.baseUrl;
            env.ANTHROPIC_AUTH_TOKEN = input.token;
            env.ENABLE_TOOL_SEARCH = "true";
            args = ["--setting-sources", "user", ...args];
          }

          let child: PoolExecChild;
          try {
            child = deps.spawn(input.provider, args, {
              ...(input.cwd === null ? {} : { cwd: input.cwd }),
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch (error) {
            resolve({
              started: false,
              providerPinned: false,
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
              providerPinned: started,
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
                providerPinned: started,
                exitCode: 1,
                stdout: "",
                stderr: `${input.provider} output exceeded the safe bb pool exec limit.\n`,
              });
              return;
            }
            resolve({
              started,
              providerPinned: started,
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
  spawn(command, args, options) {
    return nodeSpawn(command, [...args], options);
  },
});
