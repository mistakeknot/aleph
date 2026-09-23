import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it, vi } from "vitest";
import { createAccountPoolHostEntry } from "./host.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn<(signal: NodeJS.Signals) => boolean>>;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn((_signal: NodeJS.Signals) => true);
  return child;
}

describe("Account Pooler host exec", () => {
  it("injects Codex credentials only through env and redacts them from output", async () => {
    const child = fakeChild();
    const spawn = vi.fn(
      (
        _command: string,
        _args: readonly string[],
        _options: {
          cwd?: string;
          env: NodeJS.ProcessEnv;
          stdio: ["ignore", "pipe", "pipe"];
        },
      ) => child,
    );
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({ spawn, env: { PATH: "/bin" } }),
    );
    const pending = harness.experimental_call("run", {
      provider: "codex",
      command: "/opt/bin/codex",
      args: ["exec", "hello"],
      cwd: "/work",
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
    expect(command).toBe("/opt/bin/codex");
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
  });

  it("returns a pre-start failure without echoing the credential", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child);
    const harness = experimental_createHostEntryHarness(
      createAccountPoolHostEntry({ spawn, env: {} }),
    );
    const pending = harness.experimental_call("run", {
      provider: "claude",
      command: "claude",
      args: ["--print", "hello"],
      cwd: null,
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
      createAccountPoolHostEntry({ spawn, env: {} }),
    );
    const controller = new AbortController();
    const pending = harness.experimental_call(
      "run",
      {
        provider: "claude",
        command: "claude",
        args: [],
        cwd: null,
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
