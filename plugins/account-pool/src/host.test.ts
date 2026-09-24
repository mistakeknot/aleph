import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it, vi } from "vitest";
import { createAccountPoolHostEntry } from "./host.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => boolean>>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((_signal: NodeJS.Signals) => true);
  return child;
}

describe("Account Pooler host exec", () => {
  it.each([null, "/configured-input"])(
    "forwards a 160 KiB prompt from the daemon default or server override %s",
    async (stdinDir) => {
      const child = fakeChild();
      const spawn = vi.fn(() => child);
      const prompt = Buffer.alloc(160 * 1024, "p");
      const readInput = vi.fn(async () => prompt);
      const env = { HOME: "/daemon-home", TMPDIR: "/private-tmp" };
      const harness = experimental_createHostEntryHarness(
        createAccountPoolHostEntry({ spawn, readInput, env }),
      );
      const directory =
        stdinDir ?? "/daemon-home/.local/state/bb-account-pool/exec-input";
      const received: Buffer[] = [];
      child.stdin.on("data", (chunk) => received.push(Buffer.from(chunk)));
      const pending = harness.experimental_call("run", {
        provider: "codex",
        args: ["exec", "-"],
        cwd: "/caller-cwd",
        stdinDir,
        stdinPath: `${directory}/prompt`,
        token: "pool-secret",
        baseUrl: "http://127.0.0.1/v1",
      });
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.emit("spawn");
      child.emit("close", 0, null);
      await expect(pending).resolves.toMatchObject({
        started: true,
        providerPinned: true,
        exitCode: 0,
      });
      expect(readInput).toHaveBeenCalledWith(
        directory,
        `${directory}/prompt`,
        env,
      );
      expect(Buffer.concat(received)).toEqual(prompt);
    },
    20_000,
  );

  it.each([undefined, "", "daemon-config", "/daemon-config"])(
    "owns Claude settings sources and anchors config %j at the daemon, not the caller cwd",
    async (configDir) => {
      const child = fakeChild();
      const spawn = vi.fn(
        (
          _command: string,
          _args: readonly string[],
          _options: {
            cwd?: string;
            env: NodeJS.ProcessEnv;
            stdio: ["pipe", "pipe", "pipe"];
          },
        ) => child,
      );
      const harness = experimental_createHostEntryHarness(
        createAccountPoolHostEntry({
          spawn,
          env: {
            HOME: "/daemon-home",
            CLAUDE_CONFIG_DIR: configDir,
            ANTHROPIC_API_KEY: "unused-key",
            CLAUDE_CODE_USE_BEDROCK: "1",
            CLAUDE_CODE_USE_VERTEX: "1",
            CLAUDE_CODE_USE_FOUNDRY: "1",
          },
        }),
      );
      const pending = harness.experimental_call("run", {
        provider: "claude",
        args: ["--print", "hello"],
        cwd: "/caller-cwd",
        stdinPath: null,
        stdinDir: null,
        token: "pool-secret",
        baseUrl: "http://127.0.0.1:38886/pool",
      });
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      child.emit("spawn");
      child.emit("close", 0, null);
      await expect(pending).resolves.toMatchObject({
        started: true,
        providerPinned: true,
      });
      const [, args, options] = spawn.mock.calls[0] ?? [];
      expect(args).toEqual([
        "--setting-sources",
        "user",
        "--print",
        "--",
        "hello",
      ]);
      expect(options).toMatchObject({
        cwd: "/caller-cwd",
        env: {
          CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
          CLAUDE_CODE_USE_BEDROCK: "0",
          CLAUDE_CODE_USE_VERTEX: "0",
          CLAUDE_CODE_USE_FOUNDRY: "0",
          ANTHROPIC_AUTH_TOKEN: "pool-secret",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:38886/pool",
        },
      });
      expect(options?.env.ANTHROPIC_API_KEY).toBeUndefined();
      if (configDir) {
        expect(options?.env.CLAUDE_CONFIG_DIR).toBe(path.resolve(configDir));
      } else {
        expect(options?.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      }
      expect(JSON.stringify(args)).not.toContain("pool-secret");
    },
  );

  it("injects Codex credentials only through env, forwards an input file, and redacts output", async () => {
    const child = fakeChild();
    const spawn = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _options: {
          cwd?: string;
          env: NodeJS.ProcessEnv;
          stdio: ["pipe", "pipe", "pipe"];
        },
      ) => child,
    );
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({
        spawn,
        env: { PATH: "/bin" },
        readInput: async () => Buffer.from("prompt from file"),
      }),
    );
    const input: Buffer[] = [];
    child.stdin.on("data", (chunk) => input.push(Buffer.from(chunk)));
    const pending = harness.experimental_call("run", {
      provider: "codex",
      args: ["exec", "hello"],
      cwd: "/work",
      stdinPath: "/tmp/prompt.txt",
      stdinDir: "/tmp",
      token: "pool-secret",
      baseUrl: "http://127.0.0.1:38886/api/v1/plugins/account-pool/http/v1",
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emit("spawn");
    child.stdout.end("ok pool-secret");
    child.stderr.end("warn pool-secret");
    child.emit("close", 0, null);

    await expect(pending).resolves.toEqual({
      started: true,
      providerPinned: true,
      exitCode: 0,
      stdout: "ok [REDACTED]",
      stderr: "warn [REDACTED]",
    });
    const [command, args, options] = spawn.mock.calls[0] ?? [];
    expect(command).toBe("codex");
    expect(args?.[0]).toBe("exec");
    expect(args).toContain('model_provider="bb-account-pool"');
    expect(args).toContain("sandbox_workspace_write.network_access=false");
    expect(args).toContain('approval_policy="never"');
    expect(args).not.toContain("pool-secret");
    expect(JSON.stringify(args)).not.toContain("pool-secret");
    expect(options).toMatchObject({
      cwd: "/work",
      env: {
        PATH: "/bin",
        CODEX_POOL_AUTH_TOKEN: "pool-secret",
        CODEX_OPENAI_BASE_URL:
          "http://127.0.0.1:38886/api/v1/plugins/account-pool/http/v1",
      },
    });
    expect(Buffer.concat(input).toString("utf8")).toBe("prompt from file");
  });

  it("rejects every caller config form including exec-level innocuous config", async () => {
    const spawn = vi.fn(() => {
      throw new Error("must not spawn");
    });
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({
        spawn,
        env: {},
      }),
    );

    for (const args of [
      ["-c", 'model="gpt-5"', "exec", "hello"],
      ["exec", "-c", 'model="gpt-5"', "hello"],
      ["exec", "--config", 'model="gpt-5"', "hello"],
      ["exec", '-c=model="gpt-5"', "hello"],
      ["exec", '-cmodel="gpt-5"', "hello"],
      ["exec", '--config=model="gpt-5"', "hello"],
      ["exec", "--profile=evil", "hello"],
      ["exec", "--oss", "hello"],
      ["exec", "resume", "id", "-c", 'model="gpt-5"'],
      ["exec", "-c", 'model_provider="attacker"', "hello"],
      [
        "exec",
        '--config=model_providers.bb-account-pool.base_url="https://attacker.invalid"',
        "hello",
      ],
      ["exec", '-c"model_provider"="attacker"', "hello"],
      [
        "exec",
        '-cmodel_providers."bb-account-pool".base_url="https://attacker.invalid"',
        "hello",
      ],
    ]) {
      await expect(
        harness.experimental_call("run", {
          provider: "codex",
          args,
          cwd: null,
          stdinPath: null,
          stdinDir: null,
          token: "pool-secret",
          baseUrl: "http://127.0.0.1:38886/api/v1/plugins/account-pool/http/v1",
        }),
      ).resolves.toMatchObject({
        started: false,
        stderr: expect.stringContaining("not permitted"),
      });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects broad stdin directories and symlinks before reading or spawning", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pool-input-test-"));
    try {
      const home = path.join(root, "home");
      const codexHome = path.join(home, "private", "codex");
      const inputs = path.join(root, "inputs");
      await mkdir(codexHome, { recursive: true });
      await mkdir(inputs, { mode: 0o700 });
      const prompt = path.join(inputs, "prompt");
      await writeFile(prompt, "test prompt", { mode: 0o600 });
      await symlink(prompt, path.join(inputs, "link"));
      const spawn = vi.fn(() => {
        throw new Error("must not spawn");
      });
      const harness = experimental_createHostEntryHarness(
        createAccountPoolHostEntry({
          spawn,
          env: { HOME: home, CODEX_HOME: codexHome },
        }),
      );
      for (const stdinDir of ["/", home, path.dirname(codexHome), codexHome]) {
        const result = await harness.experimental_call("run", {
          provider: "codex",
          args: ["exec", "-"],
          cwd: null,
          stdinDir,
          stdinPath: path.join(stdinDir, "prompt"),
          token: "pool-secret",
          baseUrl: "http://127.0.0.1/v1",
        });
        expect(result.stderr).toContain("unsafe stdin directory");
      }
      const result = await harness.experimental_call("run", {
        provider: "codex",
        args: ["exec", "-"],
        cwd: null,
        stdinDir: inputs,
        stdinPath: path.join(inputs, "link"),
        token: "pool-secret",
        baseUrl: "http://127.0.0.1/v1",
      });
      expect(result.stderr).toContain("Unable to read");
      expect(result.stderr).not.toContain("must not spawn");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects path-qualified commands at the host contract", async () => {
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({
        spawn: vi.fn(() => {
          throw new Error("must not spawn");
        }),
        env: {},
      }),
    );

    await expect(
      harness.experimental_call("run", {
        provider: "codex",
        command: "/tmp/codex",
        args: [],
        cwd: null,
        stdinPath: null,
        stdinDir: null,
        token: "pool-secret",
        baseUrl: "http://127.0.0.1:38886/api/v1/plugins/account-pool/http/v1",
      } as never),
    ).rejects.toThrow();
  });

  it("rejects stdin files outside the configured directory", async () => {
    const spawn = vi.fn(() => fakeChild());
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({
        spawn,
        env: {},
      }),
    );

    await expect(
      harness.experimental_call("run", {
        provider: "codex",
        args: ["exec", "-"],
        cwd: null,
        stdinPath: "/etc/passwd",
        stdinDir: "/tmp",
        token: "pool-secret",
        baseUrl: "http://127.0.0.1:38886/api/v1/plugins/account-pool/http/v1",
      }),
    ).resolves.toMatchObject({
      started: false,
      stderr: expect.stringContaining("outside the configured directory"),
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns a pre-start failure without echoing the credential", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({
        spawn,
        env: {},
      }),
    );
    const pending = harness.experimental_call("run", {
      provider: "claude",
      args: ["--print", "hello"],
      cwd: null,
      stdinPath: null,
      stdinDir: null,
      token: "pool-secret",
      baseUrl: "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
    });

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emit("error", new Error("spawn failed with pool-secret"));

    await expect(pending).resolves.toEqual({
      started: false,
      providerPinned: false,
      exitCode: 1,
      stdout: "",
      stderr: "Unable to start claude: spawn failed with [REDACTED]\n",
    });
  });

  it("terminates the child when the request is cancelled", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({
        spawn,
        env: {},
      }),
    );
    const controller = new AbortController();
    const pending = harness.experimental_call(
      "run",
      {
        provider: "claude",
        args: ["--print"],
        cwd: null,
        stdinPath: null,
        stdinDir: null,
        token: "pool-secret",
        baseUrl: "http://127.0.0.1:38886/api/v1/plugins/account-pool/http",
      },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emit("spawn");

    controller.abort();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 143, "SIGTERM");
    await expect(pending).resolves.toMatchObject({
      started: true,
      providerPinned: true,
      exitCode: 143,
    });
  });
});
