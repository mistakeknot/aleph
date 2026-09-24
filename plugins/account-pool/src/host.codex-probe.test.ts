import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { expect, it } from "vitest";
import { createAccountPoolHostEntry } from "./host.js";

it.runIf(process.env.BB_POOL_EXEC_CODEX_PROBE === "1")(
  "pins the installed Codex to a synthetic local pool without a real credential",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pool-codex-probe-"));
    const codexHome = path.join(root, "codex");
    await mkdir(codexHome);
    const requests: { url: string; authenticated: boolean }[] = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        authenticated:
          request.headers.authorization === "Bearer synthetic-pool-probe",
      });
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "Synthetic local probe stops here",
            type: "authentication_error",
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("missing local listener");
      const harness = experimental_createHostEntryHarness(
        createAccountPoolHostEntry({
          env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome },
          spawn: (command, args, options) => spawn(command, [...args], options),
        }),
      );
      const result = await harness.experimental_call(
        "run",
        {
          provider: "codex",
          args: [
            "exec",
            "--model=gpt-5",
            "--sandbox=read-only",
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "Respond with OK.",
          ],
          cwd: process.cwd(),
          stdinPath: null,
          stdinDir: null,
          token: "synthetic-pool-probe",
          baseUrl: `http://127.0.0.1:${address.port}/api/v1/plugins/account-pool/http/v1`,
        },
        { signal: controller.signal },
      );
      expect(result.started).toBe(true);
      expect(result.providerPinned).toBe(true);
      expect(result.stderr).toContain("provider: bb-account-pool");
      expect(
        requests.some(
          (request) =>
            request.url.startsWith(
              "/api/v1/plugins/account-pool/http/v1/responses",
            ) && request.authenticated,
        ),
      ).toBe(true);
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout + result.stderr).not.toContain(
        "synthetic-pool-probe",
      );
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
