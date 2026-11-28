import { expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.js";
import { usageSnapshotSchema } from "./usage-schema.js";
import {
  usageListMethod,
  usageFetchMethod,
  usageFetchInputSchema,
} from "./usage-source-contract.js";

it.each(["expired", "unauthenticated"] as const)(
  "caches the existing %s state without a refresh failure",
  async (status) => {
    const rpc = vi.fn(async ({ method }: { method: string }) =>
      method === usageListMethod
        ? {
            label: "Source",
            resources: [
              {
                id: "Primary",
                label: "Primary",
                providerId: "claude-code",
                scope: { kind: "shared" },
              },
            ],
          }
        : {
            observedAt: null,
            usage: { status, accountEmail: null, planLabel: null },
          },
    );
    const host = createFakePluginHost({
      pluginId: "provider-usage",
      sdk: {
        system: { config: async () => ({ primaryHostId: null }) },
        hosts: { list: async () => [] },
        providers: { list: async () => [] },
        plugins: {
          experimental_discoverRpc: async () => [
            {
              pluginId: "source",
              displayName: "Source",
              method: usageListMethod,
            },
          ],
          callRpc: rpc,
        },
      },
    });
    plugin(host.bb);
    const request = {
      force: false,
      machineIds: null,
      providerIds: ["claude-code"],
      maxAgeMs: 60_000,
    };
    try {
      const first = await host.harness.behavior.callRpc("getUsage", request);
      expect(first).toMatchObject({
        machines: [{ error: null, providers: [{ usage: { status } }] }],
      });
      expect(JSON.stringify(first)).not.toContain("refreshFailure");
      expect(await host.harness.behavior.callRpc("getUsage", request)).toEqual(
        first,
      );
      expect(
        rpc.mock.calls.filter(([args]) => args.method === usageFetchMethod),
      ).toHaveLength(1);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  },
);

it("preserves cached rows on source-list failure and marks all requested fetch failures", async () => {
  let listFails = false;
  let fetchFails = false;
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: { list: async () => [] },
      providers: { list: async () => [] },
      plugins: {
        experimental_discoverRpc: async () => [
          {
            pluginId: "source",
            displayName: "Source",
            method: usageListMethod,
          },
        ],
        callRpc: async ({ method }) => {
          if (method === usageListMethod) {
            if (listFails) throw new Error("List unavailable");
            return {
              label: "Source",
              resources: ["Primary", "Secondary"].map((label) => ({
                id: label,
                label,
                providerId: "claude-code",
                scope: { kind: "shared" },
              })),
            };
          }
          if (fetchFails) throw new Error("Fetch unavailable");
          return {
            observedAt: 123,
            usage: {
              status: "ok",
              accountEmail: null,
              planLabel: null,
              windows: [
                {
                  id: "weekly",
                  label: "Weekly",
                  kind: "weekly",
                  usedPercent: 90,
                  resetsAt: null,
                  model: null,
                  cost: null,
                  observedAt: 67,
                  limitReached: true,
                },
                {
                  id: "daily",
                  label: "Daily",
                  kind: "daily",
                  usedPercent: 15,
                  resetsAt: null,
                  model: null,
                  cost: null,
                },
              ],
            },
          };
        },
      },
    },
  });
  plugin(host.bb);
  const request = {
    force: false,
    machineIds: null,
    providerIds: ["claude-code"],
    maxAgeMs: 60_000,
  };
  try {
    const initial = usageSnapshotSchema.parse(
      await host.harness.behavior.callRpc("getUsage", request),
    );
    const windows = initial.machines[0]?.providers[0]?.usage;
    expect(windows).toMatchObject({
      status: "ok",
      windows: [{ observedAt: 67, limitReached: true }, { usedPercent: 15 }],
    });
    expect(windows?.status === "ok" && windows.windows[1]).not.toHaveProperty(
      "observedAt",
    );
    listFails = true;
    const stale = usageSnapshotSchema.parse(
      await host.harness.behavior.callRpc("getUsage", request),
    );
    expect(stale.machines[0]?.error).not.toBeNull();
    expect(stale.machines[0]?.providers).toEqual(
      initial.machines[0]?.providers,
    );
    listFails = false;
    fetchFails = true;
    expect(
      await host.harness.behavior.callRpc("getUsage", {
        ...request,
        force: true,
      }),
    ).toMatchObject({
      machines: [
        {
          error: "Some usage could not be refreshed.",
          providers: [
            { refreshFailure: "unavailable", usage: { status: "ok" } },
            { refreshFailure: "unavailable", usage: { status: "ok" } },
          ],
        },
      ],
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("isolates failed accounts and clears the row failure after recovery", async () => {
  let failing = false;
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: { list: async () => [] },
      providers: { list: async () => [] },
      plugins: {
        experimental_discoverRpc: async () => [
          { pluginId: "pool", displayName: "Pool", method: usageListMethod },
        ],
        callRpc: async ({ method, input }) =>
          method === usageListMethod
            ? {
                label: "Pool",
                resources: ["Primary", "Secondary"].map((label) => ({
                  id: label,
                  label,
                  providerId: "claude-code",
                  scope: { kind: "shared" },
                })),
              }
            : failing &&
                usageFetchInputSchema.parse(input).resourceId === "Primary"
              ? {
                  observedAt: 123,
                  failureReason: "needs_sign_in",
                  usage: {
                    status: "error",
                    accountEmail: null,
                    planLabel: null,
                    message: "Usage could not be collected.",
                  },
                }
              : {
                  observedAt: 123,
                  usage: {
                    status: "ok",
                    accountEmail: null,
                    planLabel: null,
                    windows: [],
                  },
                },
      },
    },
  });
  plugin(host.bb);
  const request = {
    force: true,
    machineIds: null,
    providerIds: ["claude-code"],
    maxAgeMs: 0,
  };
  try {
    await host.harness.behavior.callRpc("getUsage", request);
    failing = true;
    const mixed = await host.harness.behavior.callRpc("getUsage", request);
    expect(mixed).toMatchObject({
      machines: [
        {
          error: null,
          providers: [
            {
              accountLabel: "Primary",
              refreshFailure: "needs_sign_in",
              usage: { status: "ok" },
            },
            { accountLabel: "Secondary", usage: { status: "ok" } },
          ],
        },
      ],
    });
    expect(JSON.stringify(mixed)).not.toContain(
      "Usage could not be collected.",
    );
    failing = false;
    const recovered = await host.harness.behavior.callRpc("getUsage", request);
    expect(recovered).toMatchObject({ machines: [{ error: null }] });
    expect(JSON.stringify(recovered)).not.toContain("refreshFailure");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("lists cheaply, fetches only the selected source/provider, preserves failed measurements, and evicts removed resources", async () => {
  let enabled = true;
  let failure = false;
  let hasWork = true;
  const rpc = vi.fn(async ({ pluginId, method, input }) => {
    if (method === usageListMethod)
      return pluginId === "pool"
        ? {
            label: "Account Pooler",
            resources: [
              {
                id: "claude",
                providerId: "claude-code",
                label: "claude@example.com",
                scope: { kind: "shared" },
              },
              {
                id: "personal",
                providerId: "codex",
                label: "personal@example.com",
                scope: { kind: "shared" },
              },
              ...(hasWork
                ? [
                    {
                      id: "work",
                      providerId: "codex",
                      label: "work@example.com",
                      scope: { kind: "shared" },
                    },
                  ]
                : []),
            ],
          }
        : {
            resources: [
              {
                id: "host",
                providerId: "codex",
                label: "Codex",
                scope: { kind: "host", hostId: "host", hostName: "Machine" },
              },
            ],
          };
    if (failure) throw new Error("Upstream failed");
    return {
      observedAt: 123,
      usage: {
        status: "ok",
        accountEmail: `${input.resourceId}@example.com`,
        planLabel: null,
        windows: [
          {
            id: "week",
            label: "Weekly",
            usedPercent: 42,
            resetsAt: null,
            model: null,
            cost: null,
          },
        ],
      },
    };
  });
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: {
        list: async () => [
          makeHostResponse({
            id: "host",
            name: "Machine",
            status: "connected",
          }),
        ],
      },
      providers: {
        list: async () => [
          { id: "codex", displayName: "Codex", logoUrl: "/codex.svg" },
          {
            id: "claude-code",
            displayName: "Claude Code",
            logoUrl: "/claude.svg",
          },
        ],
      },
      plugins: {
        experimental_discoverRpc: async () =>
          enabled
            ? [
                {
                  pluginId: "pool",
                  displayName: "Account Pooler",
                  method: usageListMethod,
                },
                {
                  pluginId: "local",
                  displayName: "Codex",
                  method: usageListMethod,
                },
              ]
            : [],
        callRpc: rpc,
      },
    },
  });
  plugin(host.bb);
  const request = {
    force: false,
    machineIds: null,
    providerIds: [],
    maxAgeMs: 60_000,
  };
  try {
    const listed = await host.harness.behavior.callRpc("getUsage", request);
    expect(listed).toMatchObject({
      machines: [
        { id: "host" },
        {
          id: "source:pool",
          providers: [
            { providerId: "codex", usage: null },
            { providerId: "codex", usage: null },
            { providerId: "claude-code", usage: null },
          ],
        },
      ],
    });
    expect(
      rpc.mock.calls.every(([args]) => args.method === usageListMethod),
    ).toBe(true);
    const target = {
      ...request,
      machineIds: ["source:pool"],
      providerIds: ["codex"],
    };
    await host.harness.behavior.callRpc("getUsage", target);
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .map(([args]) => [
          args.pluginId,
          args.input.resourceId,
          args.input.refresh,
        ]),
    ).toEqual([
      ["pool", "personal", false],
      ["pool", "work", false],
    ]);
    await host.harness.behavior.callRpc("getUsage", target);
    expect(
      rpc.mock.calls.filter(([args]) => args.method === usageFetchMethod),
    ).toHaveLength(2);
    failure = true;
    expect(
      await host.harness.behavior.callRpc("getUsage", {
        ...target,
        force: true,
      }),
    ).toMatchObject({
      machines: [
        { id: "host" },
        {
          id: "source:pool",
          error: "Some usage could not be refreshed.",
          providers: [
            { usage: { status: "ok" } },
            { usage: { status: "ok" } },
            { usage: null },
          ],
        },
      ],
    });
    failure = false;
    hasWork = false;
    expect(
      await host.harness.behavior.callRpc("getUsage", {
        ...target,
        force: true,
      }),
    ).toMatchObject({
      machines: [
        { id: "host" },
        {
          id: "source:pool",
          error: null,
          providers: [{ id: "pool:personal" }, { id: "pool:claude" }],
        },
      ],
    });
    await host.harness.behavior.callRpc("getUsage", {
      ...target,
      providerIds: ["claude-code"],
    });
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .at(-1)?.[0].input.resourceId,
    ).toBe("claude");
    await host.harness.behavior.callRpc("getUsage", {
      ...target,
      machineIds: null,
    });
    expect(
      rpc.mock.calls
        .filter(([args]) => args.method === usageFetchMethod)
        .at(-1)?.[0].pluginId,
    ).toBe("local");
    enabled = false;
    expect(
      await host.harness.behavior.callRpc("getUsage", request),
    ).toMatchObject({ machines: [{ id: "host", providers: [] }] });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("keeps an unconfigured shared group without hosts or measurement requests", async () => {
  const rpc = vi.fn(async () => ({ label: "Account Pooler", resources: [] }));
  const host = createFakePluginHost({
    pluginId: "provider-usage",
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: { list: async () => [] },
      providers: { list: async () => [] },
      plugins: {
        experimental_discoverRpc: async () => [
          { pluginId: "pool", displayName: "Pool", method: usageListMethod },
        ],
        callRpc: rpc,
      },
    },
  });
  plugin(host.bb);
  try {
    await expect(
      host.harness.behavior.callRpc("getUsage", {
        force: false,
        machineIds: null,
        providerIds: [],
        maxAgeMs: 0,
      }),
    ).resolves.toEqual({
      machines: [
        {
          id: "source:pool",
          displayName: "Account Pooler",
          status: "connected",
          providers: [],
          error: null,
        },
      ],
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

it("collapses known account observations per machine, preserves unknown identities, and normalizes display labels", async () => {
  const { bb, harness } = createFakePluginHost({
    sdk: {
      system: { config: async () => ({ primaryHostId: null }) },
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host", status: "connected" }),
        ],
      },
      providers: { list: async () => [] },
      plugins: {
        experimental_discoverRpc: async () => [
          { pluginId: "adapter", displayName: "Adapter" },
          { pluginId: "custom", displayName: "Custom" },
        ],
        callRpc: async ({ pluginId, method }) =>
          method === usageListMethod
            ? {
                resources: [
                  {
                    id: "account",
                    providerId: "codex",
                    accountKey: null,
                    label: "same@example.com",
                    scope: { kind: "host", hostId: "host", hostName: "Host" },
                  },
                  {
                    id: "unknown",
                    providerId: "other",
                    accountKey: null,
                    label: "same@example.com",
                    scope: { kind: "host", hostId: "host", hostName: "Host" },
                  },
                ],
              }
            : {
                accountKey: "issuer:account:1",
                observedAt: 123,
                usage: {
                  status: "ok",
                  accountEmail: "same@example.com",
                  planLabel: "max",
                  plan: { id: "max", multiplier: 20 },
                  windows: [
                    {
                      id: "week",
                      kind: "weekly",
                      label: "168 hour window",
                      model: null,
                      resetsAt: null,
                      cost: null,
                      usedPercent: pluginId === "adapter" ? 42 : 81,
                    },
                  ],
                },
              },
      },
    },
  });
  try {
    plugin(bb);
    const snapshot = await harness.behavior.callRpc("getUsage", {
      force: false,
      machineIds: ["host"],
      providerIds: ["codex"],
      maxAgeMs: 0,
    });
    expect(snapshot).toMatchObject({
      machines: [
        {
          providers: [
            {
              id: "adapter:account",
              usage: {
                planLabel: "Max (20x)",
                windows: [{ label: "Weekly limit", usedPercent: 42 }],
              },
            },
            { id: "adapter:unknown", usage: null },
            { id: "custom:unknown", usage: null },
          ],
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain("81");
  } finally {
    await harness.lifecycle.dispose();
  }
});
