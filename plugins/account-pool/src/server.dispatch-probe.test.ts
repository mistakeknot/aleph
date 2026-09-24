import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { z } from "zod";
import { createAccountPoolPlugin } from "./server.js";
import { AccountStore, HubTokenStore } from "./store.js";

const clavainRoot = process.env.BB_POOL_DISPATCH_PROBE_CLAVAIN_ROOT;

it.runIf(Boolean(clavainRoot)).each(["claude", "codex"] as const)(
  "blocks a budgeted cross-provider %s dispatch on refused thread ownership before receipt begin or provider launch",
  async (provider) => {
    if (!clavainRoot) throw new Error("Clavain probe checkout required");
    const config = z
      .object({ allowed_host_ids: z.array(z.string()).min(1) })
      .parse(
        JSON.parse(
          await fs.readFile(
            path.join(clavainRoot, "config/bb-integration.json"),
            "utf8",
          ),
        ),
      );
    await fs.access(path.join(clavainRoot, "scripts/bb-pool-receipt.py"));
    const hostId = config.allowed_host_ids[0]!;
    const root = await fs.mkdtemp(path.join(tmpdir(), "bb-dispatch-probe-"));
    const threadId = "thr_dispatch_probe";
    const thread = makeThreadResponse({
      id: threadId,
      environmentId: "env-probe",
      providerId: provider === "claude" ? "codex" : "claude-code",
    });
    const environment = makeMessageDispatchHookContext({
      host: { id: "different-owner" },
      environment: { id: "env-probe" },
    }).environment!;
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir: root,
      sdk: {
        hosts: {
          list: async () => [makeHostResponse({ id: hostId })],
          get: async () => ({
            ...makeHostResponse({ id: hostId }),
            connectMachineId: null,
          }),
        },
        threads: { get: async () => thread },
        environments: { get: async () => environment },
        plugins: { list: async () => ({ plugins: [] }) },
      },
    });
    const requests: string[] = [];
    const upstreamRequests: string[] = [];
    const server = createServer(async (request, response) => {
      const url = (request.url ?? "").replace(
        "/api/v1/plugins/account-pool/http",
        "",
      );
      requests.push(`${request.method} ${url}`);
      try {
        if (request.method !== "GET" && request.method !== "POST")
          throw new Error("Unexpected method");
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const result = await host.harness.behavior.fetchHttp(
          request.method,
          url,
          {
            headers: {
              "x-bb-account-pool-token": String(
                request.headers["x-bb-account-pool-token"] ?? "",
              ),
              "content-type": "application/json",
            },
            ...(request.method === "POST"
              ? { body: Buffer.concat(chunks).toString("utf8") }
              : {}),
          },
        );
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(await result.text());
      } catch {
        response.writeHead(500);
        response.end();
      }
    });
    try {
      const secretDir = path.join(
        root,
        "plugins/account-pool/secrets/accounts",
      );
      const accounts = new AccountStore(host.bb.storage.kv, secretDir);
      await accounts.initialize();
      for (const target of ["claude", "codex"] as const) {
        await accounts.add(
          {
            provider: target,
            kind: "oauth",
            label: target,
            email: null,
            accountUuid: null,
            subscriptionType: null,
            rateLimitTier: null,
            enabled: true,
            priority: 100,
          },
          {
            kind: "oauth",
            accessToken: "synthetic-access",
            refreshToken: "synthetic-refresh",
            expiresAt: Date.now() + 3_600_000,
          },
        );
      }
      const token = await new HubTokenStore(secretDir).forHost(hostId);
      await createAccountPoolPlugin({
        env: {},
        fetch: async (input) => {
          upstreamRequests.push(String(input));
          return Response.json({});
        },
      })(host.bb);
      host.harness.behavior.runService("hub");
      const control = await host.harness.behavior.fetchHttp(
        "POST",
        "/receipts/begin",
        {
          headers: { "x-bb-account-pool-token": token },
          body: JSON.stringify({ version: 1, provider, attempt_id: "control" }),
        },
      );
      expect(control.status).toBe(200);
      const lease = z.object({ id: z.string() }).parse(await control.json());
      expect(
        (
          await host.harness.behavior.fetchHttp("POST", "/receipts/finalize", {
            headers: { "x-bb-account-pool-token": token },
            body: JSON.stringify({
              version: 1,
              id: lease.id,
              attempt_id: "control",
            }),
          })
        ).status,
      ).toBe(200);
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing fixture listener");
      const origin = `http://127.0.0.1:${address.port}`;
      const bin = path.join(root, "bin");
      await fs.mkdir(bin);
      const bb = path.join(bin, "bb");
      await fs.writeFile(
        bb,
        `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ thread: { id: threadId, environment: { hostId } } })}'\n`,
        { mode: 0o700 },
      );
      await fs.writeFile(
        path.join(bin, "ic"),
        "#!/bin/sh\nprintf '%s\\n' '{\"model_identity\":\"observed-model\"}'\n",
        { mode: 0o700 },
      );
      for (const cli of ["claude", "codex"]) {
        await fs.writeFile(
          path.join(bin, cli),
          '#!/bin/sh\nif [ "$1" = "--version" ]; then printf \'codex-cli 0.153.3\\n\'; exit 0; fi\n: > "$PROVIDER_CALLED"\nexit 97\n',
          { mode: 0o700 },
        );
      }
      const marker = path.join(root, "provider-called");
      const env: NodeJS.ProcessEnv = {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        BB_CLI: bb,
        BB_THREAD_ID: threadId,
        BB_SERVER_URL: origin,
        CLAVAIN_REQUIRE_USAGE: "1",
        CLAVAIN_TOKEN_BUDGET: "1000",
        CLAVAIN_REVIEW_EVENTS: path.join(root, "events"),
        CLAVAIN_CONTEXT_GATEWAY_MODE: "off",
        CLAVAIN_BB_DIRECT_POOL: "1",
        CLAVAIN_POOL_HEADROOM: "0",
        PROVIDER_CALLED: marker,
        ...(provider === "claude"
          ? {
              CODEX_POOL_AUTH_TOKEN: token,
              CODEX_OPENAI_BASE_URL: `${origin}/api/v1/plugins/account-pool/http/v1`,
            }
          : {
              ANTHROPIC_AUTH_TOKEN: token,
              ANTHROPIC_BASE_URL: `${origin}/api/v1/plugins/account-pool/http`,
            }),
      };
      const child = spawn(
        "/bin/bash",
        [
          path.join(clavainRoot, "scripts/dispatch.sh"),
          "--to",
          provider,
          "-m",
          "observed-model",
          "-C",
          root,
          "-o",
          path.join(root, "out"),
          "fixture",
        ],
        { env, timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      let stdout = "";
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      expect(code).toBe(1);
      expect(stderr).toContain(
        `cannot establish current bb account-pool eligibility for ${provider}`,
      );
      expect(requests).toEqual([`GET /availability?threadId=${threadId}`]);
      await expect(fs.access(marker)).rejects.toThrow();
      expect(
        (await fs.readdir(root)).filter((name) => name.startsWith("out.pool-")),
      ).toEqual([]);
      expect(
        upstreamRequests.some((url) => /\/v1\/(messages|responses)/u.test(url)),
      ).toBe(false);
      expect(stdout + stderr).not.toContain(token);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await host.harness.lifecycle.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
