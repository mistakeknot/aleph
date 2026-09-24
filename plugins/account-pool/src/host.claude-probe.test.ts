import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { expect, it } from "vitest";
import { createAccountPoolHostEntry } from "./host.js";

it
  .runIf(process.env.BB_POOL_EXEC_CLAUDE_PROBE === "1")
  .each(["project", "local", "user"])(
  "pins installed Claude to listener A despite %s settings pointing at B",
  async (source) => {
    const root = await mkdtemp(path.join(tmpdir(), "pool-claude-probe-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "caller");
    const config = path.join(home, ".claude");
    await mkdir(config, { recursive: true });
    await mkdir(path.join(cwd, ".claude"), { recursive: true });
    const requests: {
      listener: string;
      url: string;
      authenticated: boolean;
    }[] = [];
    const listeners = ["A", "B"].map((listener) =>
      createServer((request, response) => {
        requests.push({
          listener,
          url: request.url ?? "",
          authenticated:
            request.headers.authorization ===
            "Bearer synthetic-claude-pool-probe",
        });
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "authentication_error",
              message: "Synthetic local probe stops here",
            },
          }),
        );
      }),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      await Promise.all(
        listeners.map(
          (server) =>
            new Promise<void>((resolve) =>
              server.listen(0, "127.0.0.1", resolve),
            ),
        ),
      );
      const urls = listeners.map((server) => {
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("missing local listener");
        return `http://127.0.0.1:${address.port}`;
      });
      const [poolUrl, redirectUrl] = urls;
      if (!poolUrl || !redirectUrl) throw new Error("missing listener URLs");
      const settings =
        source === "user"
          ? path.join(config, "settings.json")
          : path.join(
              cwd,
              ".claude",
              source === "project" ? "settings.json" : "settings.local.json",
            );
      await writeFile(
        settings,
        JSON.stringify({ env: { ANTHROPIC_BASE_URL: redirectUrl } }),
        { mode: 0o600 },
      );
      const harness = experimental_createHostEntryHarness(
        createAccountPoolHostEntry({
          env: {
            PATH: process.env.PATH,
            HOME: home,
            CLAUDE_CONFIG_DIR: config,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          },
          spawn: (command, args, options) => spawn(command, [...args], options),
        }),
      );
      const result = await harness.experimental_call(
        "run",
        {
          provider: "claude",
          args: ["--print", "--model=claude-sonnet-4-6", "Respond with OK."],
          cwd,
          stdinPath: null,
          stdinDir: null,
          token: "synthetic-claude-pool-probe",
          baseUrl: poolUrl,
        },
        { signal: controller.signal },
      );
      expect(result.started).toBe(true);
      expect(result.providerPinned).toBe(true);
      expect(requests.filter((request) => request.listener === "B")).toEqual(
        [],
      );
      expect(
        requests.some(
          (request) =>
            request.listener === "A" &&
            request.url.startsWith("/v1/messages") &&
            request.authenticated,
        ),
      ).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(
        "synthetic-claude-pool-probe",
      );
    } finally {
      clearTimeout(timer);
      await Promise.all(
        listeners.map((server) => {
          server.closeAllConnections();
          return new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
