import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { poolExecHostContract } from "./exec-contract.js";
import { parsePoolExecArgs, poolExecArgsRefusal } from "./exec-args.js";
import { readPoolInput } from "./exec-input.js";
import { claudeEnvironment, verifyClaudeScrub } from "./claude-env.js";
import {
  createExecOutput,
  readExecPrompt,
  validateExecDirectory,
} from "./exec-files.js";

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
  checkClaudeScrub?: typeof verifyClaudeScrub;
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
            stderr: `${poolExecArgsRefusal(input.provider, input.args) ?? `${input.provider} arguments are not permitted by the Account Pooler execution allowlist.`}\n`,
          };
        }
        if (
          input.provider === "claude" &&
          !permittedArgs.includes("--tools=") &&
          !(await (deps.checkClaudeScrub ?? verifyClaudeScrub)(deps.env))
        ) {
          return {
            started: false,
            providerPinned: false,
            exitCode: 1,
            stdout: "",
            stderr:
              "Pool exec refused: tool-capable Claude requires verified Claude Code 2.1.323 subprocess env scrubbing, socat, ripgrep and working Linux bubblewrap isolation. Tool-free --print --tools= may still run.\n",
          };
        }
        let cwd: string;
        let output: Awaited<ReturnType<typeof createExecOutput>> | undefined;
        let stdin: Buffer<ArrayBufferLike> = Buffer.alloc(0);
        try {
          if (input.workspacePath === null)
            throw new Error("Missing server-owned environment workspace");
          cwd = await validateExecDirectory(
            input.cwd,
            permittedArgs,
            deps.env,
            input.workspacePath,
          );
          if (input.promptPath !== null) {
            if (input.stdinPath !== null)
              throw new Error("Choose only one stdin source");
            stdin = await readExecPrompt(cwd, input.promptPath);
          }
          if (input.outputPath !== null)
            output = await createExecOutput(cwd, input.outputPath, input.token);
        } catch (error) {
          return {
            started: false,
            providerPinned: false,
            exitCode: 1,
            stdout: "",
            stderr: `Invalid pool exec files or cwd: ${redact(error instanceof Error ? error.message : String(error), input.token)}\n`,
          };
        }
        if (input.stdinPath !== null) {
          try {
            stdin = await (deps.readInput ?? readPoolInput)(
              input.stdinDir ?? defaultInputDir,
              input.stdinPath,
              deps.env,
            );
          } catch (error) {
            output?.close();
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
          const env =
            input.provider === "claude"
              ? claudeEnvironment(deps.env)
              : { ...deps.env };
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
            const sources = args.find((arg) =>
              arg.startsWith("--setting-sources="),
            );
            args = [
              "--setting-sources",
              sources === undefined
                ? "user"
                : sources.slice("--setting-sources=".length),
              ...(!args.includes("--strict-mcp-config")
                ? ["--strict-mcp-config"]
                : []),
              ...args.filter(
                (arg) =>
                  !arg.startsWith("--setting-sources=") &&
                  !arg.startsWith("--mcp-config="),
              ),
            ];
          }

          let child: PoolExecChild;
          try {
            child = deps.spawn(input.provider, args, {
              cwd,
              env,
              stdio: ["pipe", "pipe", "pipe"],
            });
          } catch (error) {
            output?.close();
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
          let outputError = "";
          let timedOut = false;
          let forceTimer: ReturnType<typeof setTimeout> | undefined;
          const stop = () => {
            child.kill("SIGTERM");
            forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
            forceTimer.unref();
          };
          const timer = setTimeout(() => {
            timedOut = true;
            stop();
          }, input.timeoutSeconds * 1000);
          timer.unref();
          const finishOutput = () => {
            clearTimeout(timer);
            clearTimeout(forceTimer);
            try {
              output?.close();
            } catch {
              outputError = "Unable to finish pool exec output file";
            }
          };
          const stdout: Buffer[] = [];
          const stderr: Buffer[] = [];
          const append = (target: Buffer[], chunk: unknown): void => {
            if (outputOverflow || outputError) return;
            const buffer = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(String(chunk));
            if (output) {
              try {
                output.write(target === stdout ? "stdout" : "stderr", buffer);
              } catch {
                outputError = "Unable to write pool exec output file";
                stop();
              }
              return;
            }
            outputBytes += buffer.length;
            if (outputBytes > OUTPUT_LIMIT_BYTES) {
              outputOverflow = true;
              stop();
              return;
            }
            target.push(buffer);
          };
          child.stdout.on("data", (chunk) => append(stdout, chunk));
          child.stderr.on("data", (chunk) => append(stderr, chunk));
          child.stdin.on("error", () => {});
          child.stdin.end(stdin);

          const cancel = (): void => {
            stop();
          };
          context.signal.addEventListener("abort", cancel, { once: true });
          if (context.signal.aborted) cancel();
          child.once("spawn", () => {
            started = true;
          });
          child.once("error", (error) => {
            if (settled) return;
            settled = true;
            active.delete(child);
            finishOutput();
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
            finishOutput();
            context.signal.removeEventListener("abort", cancel);
            if (outputOverflow || outputError || timedOut) {
              resolve({
                started: true,
                providerPinned: started,
                exitCode: 1,
                stdout: "",
                stderr: `${outputError || (timedOut ? "Pool exec timeout exceeded" : `${input.provider} output exceeded the safe bb pool exec limit.`)}\n`,
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
