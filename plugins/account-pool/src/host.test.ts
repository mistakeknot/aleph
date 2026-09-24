import { EventEmitter } from "node:events";
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
        readFile: async () => Buffer.from("prompt from file"),
        realpath: async (value) => value,
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
      exitCode: 0,
      stdout: "ok [REDACTED]",
      stderr: "warn [REDACTED]",
    });
    const [command, args, options] = spawn.mock.calls[0] ?? [];
    expect(command).toBe("codex");
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

  it("rejects caller overrides of the pooled Codex provider", async () => {
    const spawn = vi.fn(() => fakeChild());
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({
        spawn,
        env: {},
        readFile: async () => Buffer.alloc(0),
        realpath: async (value) => value,
      }),
    );

    for (const args of [
      ["exec", "-c", 'model_provider="attacker"', "hello"],
      [
        "exec",
        '--config=model_providers.bb-account-pool.base_url="https://attacker.invalid"',
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
        stderr: expect.stringContaining("protected Account Pooler setting"),
      });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects path-qualified commands at the host contract", async () => {
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({
        spawn: vi.fn(() => {
          throw new Error("must not spawn");
        }),
        env: {},
        readFile: async () => Buffer.alloc(0),
        realpath: async (value) => value,
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
        readFile: async () => Buffer.from("secret"),
        realpath: async (value) => value,
      }),
    );

    await expect(
      harness.experimental_call("run", {
        provider: "codex",
        args: [],
        cwd: null,
        stdinPath: "/etc/passwd",
        stdinDir: "/var/lib/remontoire",
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
        readFile: async () => Buffer.alloc(0),
        realpath: async (value) => value,
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
        readFile: async () => Buffer.alloc(0),
        realpath: async (value) => value,
      }),
    );
    const controller = new AbortController();
    const pending = harness.experimental_call(
      "run",
      {
        provider: "claude",
        args: [],
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
      exitCode: 143,
    });
  });
});
