import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAccountPoolPlugin } from "./server.js";
import { AccountStore } from "./store.js";
import type { PoolAvailability, PoolProvider } from "./contracts.js";

const cleanups: Array<() => Promise<void>> = [];
const threadId = "thr_eligibility";
const hostId = "host-one";
const both = { claude: true, codex: true };
const neither = { claude: false, codex: false };

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(
  options: {
    parent?: boolean;
    localAccounts?: boolean;
  } = {},
) {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "bb-availability-"));
  const thread = makeThreadResponse({
    id: threadId,
    environmentId: "environment-one",
    providerId: "codex",
  });
  const environment = makeMessageDispatchHookContext({
    host: { id: hostId },
    environment: { id: "environment-one", projectId: thread.projectId },
  }).environment;
  if (environment === null) throw new Error("Missing fixture environment");
  const state = {
    thread,
    environment,
    hosts: [makeHostResponse({ id: hostId })],
    parentAvailability: { ...both },
    parentStatus: 200,
    parentUnreachable: false,
  };
  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: {
      threads: { get: async () => state.thread },
      environments: { get: async () => state.environment },
      hosts: {
        list: async () => state.hosts,
        get: async () => {
          const host = state.hosts[0];
          if (!host) throw new Error("Host no longer enrolled");
          return { ...host, connectMachineId: null };
        },
      },
      plugins: { list: async () => ({ plugins: [] }) },
    },
  });
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const accounts = new AccountStore(
    host.bb.storage.kv,
    path.join(dataDir, "plugins/account-pool/secrets/accounts"),
  );
  await accounts.initialize();
  if (options.localAccounts !== false) {
    for (const provider of ["claude", "codex"] as const) {
      await accounts.add(
        {
          provider,
          kind: "oauth",
          label: provider,
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
  }
  const parentFetch = vi.fn<typeof fetch>(async (input) => {
    if (String(input) !== "https://parent.invalid/availability") {
      throw new Error("Unexpected upstream request");
    }
    if (state.parentUnreachable) throw new Error("Parent unavailable");
    return Response.json(state.parentAvailability, {
      status: state.parentStatus,
    });
  });
  await createAccountPoolPlugin({
    env: options.parent
      ? {
          BB_ACCOUNT_POOL_PARENT_URL: "https://parent.invalid",
          BB_ACCOUNT_POOL_PARENT_TOKEN: "P".repeat(43),
        }
      : {},
    availabilityTtlMs: 0,
    fetch: parentFetch,
  })(host.bb);
  const env = async (provider: PoolProvider) =>
    host.harness.behavior.resolveProviderEnv(
      provider === "claude" ? "claude-code" : "codex",
      { threadId, hostId, projectId: thread.projectId },
    );
  const codexEnv = await env("codex");
  const token = codexEnv.find(
    (entry) => entry.name === "CODEX_POOL_AUTH_TOKEN",
  )?.value;
  if (typeof token !== "string" || !token)
    throw new Error("Missing fixture token");
  const request = (
    query = `?threadId=${threadId}`,
    credential: string | null = token,
  ) =>
    host.harness.behavior.fetchHttp("GET", `/availability${query}`, {
      headers:
        credential === null ? {} : { "x-bb-account-pool-token": credential },
    });
  const expectAvailability = async (expected: PoolAvailability) => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ threadId, availability: expected });
    expect(response.headers.get("cache-control")).toBe("no-store");
    for (const provider of ["claude", "codex"] as const) {
      const entries = await env(provider);
      const name =
        provider === "claude"
          ? "ANTHROPIC_AUTH_TOKEN"
          : "CODEX_POOL_AUTH_TOKEN";
      expect(Boolean(entries.find((entry) => entry.name === name)?.value)).toBe(
        expected[provider],
      );
    }
  };
  return {
    ...host,
    state,
    accounts,
    parentFetch,
    env,
    request,
    expectAvailability,
  };
}

describe("thread-bound pool availability", () => {
  it("matches the Clavain decision contract without synthesizing native aliases", async () => {
    const f = await fixture();
    await f.expectAvailability(both);
    expect((await f.env("codex")).map((entry) => entry.name)).toEqual([
      "CODEX_OPENAI_BASE_URL",
      "CODEX_POOL_AUTH_TOKEN",
      "BB_ACCOUNT_POOL_PARENT_URL",
      "BB_ACCOUNT_POOL_PARENT_TOKEN",
    ]);
    f.state.thread.providerId = "claude-code";
    await f.expectAvailability(both);
    expect((await f.env("claude")).map((entry) => entry.name)).toEqual([
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ENABLE_TOOL_SEARCH",
      "BB_ACCOUNT_POOL_PARENT_URL",
      "BB_ACCOUNT_POOL_PARENT_TOKEN",
    ]);
    expect(f.parentFetch).not.toHaveBeenCalled();
    expect(await f.bb.storage.kv.list("routed:")).toEqual([
      `routed:${threadId}`,
    ]);
  });

  it("retains the provider-wide response for parent servers without a thread query", async () => {
    const f = await fixture();
    await f.harness.behavior.callRpc("bypass.set", {
      threadId,
      bypassed: true,
    });
    const response = await f.request("");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(both);
  });

  it.each([null, "invalid-token"])(
    "authenticates before looking up a thread (%s)",
    async (token) => {
      const f = await fixture();
      const response = await f.request(`?threadId=${threadId}`, token);
      expect(response.status).toBe(401);
      expect(f.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);
    },
  );

  it.each([
    "",
    " ",
    "a/b",
    "a".repeat(201),
    `${threadId}&threadId=${threadId}`,
  ])("rejects a malformed or ambiguous threadId (%s)", async (value) => {
    const f = await fixture();
    expect((await f.request(`?threadId=${value}`)).status).toBe(400);
    expect(f.harness.inspection.sdk.callsTo("threads.get")).toHaveLength(0);
  });

  it.each([
    "foreign-host",
    "unenrolled-host",
    "unbound-thread",
    "deleted-thread",
    "mismatched-thread",
    "mismatched-environment",
    "mismatched-project",
    "destroyed-environment",
    "mismatched-host",
    "destroyed-host",
  ])(
    "refuses ownership without a current matching environment: %s",
    async (reason) => {
      const f = await fixture();
      if (reason === "foreign-host") f.state.environment.hostId = "host-other";
      if (reason === "unenrolled-host") f.state.hosts = [];
      if (reason === "unbound-thread") f.state.thread.environmentId = null;
      if (reason === "deleted-thread") f.state.thread.deletedAt = 1;
      if (reason === "mismatched-thread") f.state.thread.id = "thr_other";
      if (reason === "mismatched-environment")
        f.state.environment.id = "environment-other";
      if (reason === "mismatched-project")
        f.state.environment.projectId = "project-other";
      if (reason === "destroyed-environment")
        f.state.environment.status = "destroyed";
      if (reason === "mismatched-host") f.state.hosts[0]!.id = "host-other";
      if (reason === "destroyed-host")
        f.state.hosts[0]!.lifecycle.phase = "destroyed";
      const response = await f.request();
      expect(response.status).toBe(reason === "unenrolled-host" ? 503 : 403);
      expect(await response.text()).toBe("");
    },
  );

  it.each(["threads.get", "environments.get", "hosts.get"] as const)(
    "fails closed when %s cannot establish ownership",
    async (method) => {
      const f = await fixture();
      f.harness.inspection.sdk.stub(method, async () => {
        throw new Error("Unavailable");
      });
      expect((await f.request()).status).toBe(503);
    },
  );

  it("rechecks bypass and routing switches on each request", async () => {
    const f = await fixture();
    await f.expectAvailability(both);
    await f.harness.behavior.callRpc("bypass.set", {
      threadId,
      bypassed: true,
    });
    await f.expectAvailability(neither);
    await f.harness.behavior.callRpc("bypass.set", {
      threadId,
      bypassed: false,
    });
    await f.harness.behavior.callRpc("routing.set", {
      provider: "claude",
      enabled: false,
    });
    await f.expectAvailability({ claude: false, codex: true });
    await f.harness.behavior.callRpc("routing.set", {
      provider: "claude",
      enabled: true,
    });
    await f.expectAvailability(both);
  });

  it.each(["disabled", "removed", "unreadable"])(
    "rejects %s accounts like env contribution",
    async (state) => {
      const f = await fixture();
      const claude = (await f.accounts.list()).find(
        (account) => account.provider === "claude",
      );
      if (!claude) throw new Error("Missing fixture account");
      if (state === "unreadable") {
        await fs.writeFile(
          path.join(
            f.bb.server.experimental_dataDir,
            "plugins/account-pool/secrets/accounts",
            `account-${claude.id}.json`,
          ),
          "{}",
        );
      } else {
        await f.harness.behavior.callRpc(
          state === "disabled" ? "account.disable" : "account.remove",
          { id: claude.id },
        );
      }
      await f.expectAvailability({ claude: false, codex: true });
    },
  );

  it("uses parent availability only in proxy mode and neutralizes in isolate mode", async () => {
    const f = await fixture({ parent: true, localAccounts: false });
    await f.expectAvailability(both);
    f.state.parentAvailability = { claude: false, codex: true };
    await f.expectAvailability({ claude: false, codex: true });
    await f.harness.behavior.callRpc("config.set", { parentMode: "isolate" });
    f.parentFetch.mockClear();
    await f.expectAvailability(neither);
    expect(f.parentFetch).not.toHaveBeenCalled();
  });

  it("keeps local pool accounts usable in isolate mode", async () => {
    const f = await fixture({ parent: true });
    await f.harness.behavior.callRpc("config.set", { parentMode: "isolate" });
    f.state.parentUnreachable = true;
    f.parentFetch.mockClear();
    await f.expectAvailability(both);
    expect(f.parentFetch).not.toHaveBeenCalled();
  });

  it.each(["unreachable", "unauthorized"])(
    "denies an %s parent, even with local accounts in proxy mode",
    async (reason) => {
      const f = await fixture({ parent: true });
      f.state.parentUnreachable = reason === "unreachable";
      f.state.parentStatus = 401;
      await f.expectAvailability(neither);
    },
  );

  it("does not return credentials or mark a Claude thread as routed for a decision", async () => {
    const f = await fixture();
    const before = await f.bb.storage.kv.list("routed:");
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await f.bb.storage.kv.list("routed:")).toEqual(before);
    expect(await response.json()).toEqual({ threadId, availability: both });
  });
});
