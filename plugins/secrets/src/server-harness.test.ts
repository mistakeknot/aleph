import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { runRequest } from "./server.js";
import { parseRequest } from "./request-args.js";

const DIGEST = "a".repeat(64);
const ENTRY_SHA = "b".repeat(64);
const CANARY_EXISTING = "canary-existing-5c2e91";
const CANARY_SUBMITTED = "canary-submitted-77d0a4";

function readyProbe(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "ready" as const,
    destRealpath: "/home/u/proj/.env",
    parent: { dev: "1", ino: "2" },
    file: { dev: "1", ino: "3" },
    allowlistEntrySha256: ENTRY_SHA,
    consumer: "demo-app",
    existingNames: ["API_KEY"],
    requestDigest: DIGEST,
    ...overrides,
  };
}

function makeHost(
  options: {
    probe?: () => unknown;
    commit?: (args: Record<string, unknown>) => unknown;
  } = {},
) {
  return createFakePluginHost({
    pluginId: "secrets",
    sdk: {
      threads: {
        async get() {
          return { host: { id: "host-test" } };
        },
      },
      files: {
        async secretProbe() {
          return (options.probe ?? (() => readyProbe()))();
        },
        async secretCommit(args: Record<string, unknown>) {
          return (
            options.commit ??
            (() => ({
              outcome: "written",
              added: 1,
              updated: 1,
              unchanged: 0,
            }))
          )(args);
        },
      },
    },
  } as never);
}

type Host = ReturnType<typeof makeHost>;

function register(host: Host) {
  plugin(host.bb as unknown as Parameters<typeof plugin>[0]);
}

const BASE = [
  "request",
  "API_KEY",
  "TOKEN",
  "--project",
  "demo",
  "--write-env",
  ".env",
];
const CTX = { threadId: "thr-test", cwd: "/home/u/proj" };

describe("secrets plugin server", () => {
  it("probes, asks, then commits on the host and never reads or writes the file", async () => {
    const host = makeHost();
    register(host);
    const command = host.harness.runCli(
      [
        ...BASE,
        "--purpose",
        "Configure the app",
        "--describe",
        "API_KEY",
        "Primary API key",
      ],
      CTX,
    );
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const pending = host.harness.pendingInteractions[0]!;
    expect(pending.title).toBe("Add secrets");
    expect(pending.payload).toMatchObject({
      project: "demo",
      purpose: "Configure the app",
      destination: {
        kind: "dotenv",
        path: "/home/u/proj/.env",
        consumer: "demo-app",
      },
      digestPrefix: DIGEST.slice(0, 12),
      allowlistEntryPrefix: ENTRY_SHA.slice(0, 12),
      fields: [
        { name: "API_KEY", description: "Primary API key", existing: true },
        { name: "TOKEN", description: null, existing: false },
      ],
    });
    host.harness.submitInteraction(pending.id, {
      values: { API_KEY: "fake-one", TOKEN: "fake-two" },
    });

    const result = await command;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("fake-one");
    expect(result.stdout).not.toContain("fake-two");
    expect(JSON.parse(result.stdout ?? "")).toEqual({
      outcome: "written",
      path: "/home/u/proj/.env",
      names: ["API_KEY", "TOKEN"],
      added: 1,
      updated: 1,
      unchanged: 0,
    });

    const probeArgs = host.harness.sdk.callsTo("files.secretProbe")[0]?.[0];
    expect(probeArgs).toMatchObject({
      hostId: "host-test",
      threadId: "thr-test",
      project: "demo",
      path: "/home/u/proj/.env",
      fields: [
        { name: "API_KEY", description: "Primary API key" },
        { name: "TOKEN", description: null },
      ],
    });
    const commitArgs = host.harness.sdk.callsTo("files.secretCommit")[0]?.[0];
    expect(commitArgs).toMatchObject({
      requestDigest: DIGEST,
      parent: { dev: "1", ino: "2" },
      file: { dev: "1", ino: "3" },
      allowlistEntrySha256: ENTRY_SHA,
      values: { API_KEY: "fake-one", TOKEN: "fake-two" },
    });
    const requestId = (probeArgs as { requestId: string }).requestId;
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect((pending.payload as { requestId: string }).requestId).toBe(
      requestId,
    );
    expect((commitArgs as { requestId: string }).requestId).toBe(requestId);
    expect(host.harness.sdk.callsTo("files.read")).toEqual([]);
    expect(host.harness.sdk.callsTo("files.write")).toEqual([]);
  });

  it("preserves an absolute dotenv destination outside the working directory", async () => {
    const host = makeHost();
    register(host);
    const command = host.harness.runCli(
      [
        "request",
        "API_KEY",
        "--project",
        "demo",
        "--write-env",
        "/var/plugin/.env",
      ],
      CTX,
    );
    await vi.waitFor(() =>
      expect(host.harness.sdk.callsTo("files.secretProbe")).toHaveLength(1),
    );
    expect(host.harness.sdk.callsTo("files.secretProbe")[0]?.[0]).toMatchObject(
      {
        path: "/var/plugin/.env",
      },
    );
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.cancelInteraction(host.harness.pendingInteractions[0]!.id);
    await command;
  });

  it("describes the submission by names only", async () => {
    const host = makeHost();
    register(host);
    const command = host.harness.runCli(BASE, CTX);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const pending = host.harness.pendingInteractions[0]!;
    expect(
      pending.describeSubmission?.({ values: { API_KEY: "s3cret" } }),
    ).toEqual({
      title: "Provided API_KEY",
      detail: "/home/u/proj/.env\n- API_KEY",
    });
    expect(pending.describeSubmission?.({ nope: "s3cret" })).toMatchObject({
      title: "Provided ",
    });
    host.harness.cancelInteraction(pending.id);
    await command;
  });

  it("keeps the row label within its cap for many long secret names", async () => {
    const names = Array.from(
      { length: 12 },
      (_unused, index) => `A_VERY_LONG_SECRET_NAME_NUMBER_${index}`,
    );
    const host = makeHost();
    register(host);
    const command = host.harness.runCli(
      ["request", ...names, "--project", "demo", "--write-env", ".env"],
      CTX,
    );
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const pending = host.harness.pendingInteractions[0]!;
    expect(pending.presentation?.label?.pending.length).toBeLessThanOrEqual(80);
    expect(pending.presentation?.label?.completed.length).toBeLessThanOrEqual(
      80,
    );
    host.harness.cancelInteraction(pending.id);
    await command;
  });

  it("T1.5: cancelling the form writes nothing and a re-ask gets a new request", async () => {
    const host = makeHost();
    register(host);
    const first = host.harness.runCli(BASE, CTX);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.cancelInteraction(host.harness.pendingInteractions[0]!.id);
    const cancelled = await first;
    expect(cancelled.exitCode).toBe(1);
    expect(cancelled.stderr).toContain("cancelled");
    expect(host.harness.sdk.callsTo("files.secretCommit")).toEqual([]);

    const second = host.harness.runCli(BASE, CTX);
    await vi.waitFor(() =>
      expect(host.harness.sdk.callsTo("files.secretProbe")).toHaveLength(2),
    );
    const ids = host.harness.sdk
      .callsTo("files.secretProbe")
      .map((call) => (call[0] as { requestId: string }).requestId);
    expect(new Set(ids).size).toBe(2);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.cancelInteraction(host.harness.pendingInteractions[0]!.id);
    await second;
    expect(host.harness.sdk.callsTo("files.secretCommit")).toEqual([]);
  });

  it("T1.5: a submission after expiry writes nothing", async () => {
    const host = makeHost();
    let clock = 1_800_000_000_000;
    const parsed = parseRequest({
      names: ["API_KEY"],
      project: "demo",
      purpose: undefined,
      describe: [],
      writeEnv: ".env",
    });
    const running = runRequest(
      host.bb as unknown as Parameters<typeof runRequest>[0],
      parsed,
      { threadId: "thr-test", cwd: "/home/u/proj" } as Parameters<
        typeof runRequest
      >[2],
      () => clock,
    );
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    const pending = host.harness.pendingInteractions[0]!;
    expect((pending.payload as { expiresAtMs: number }).expiresAtMs).toBe(
      clock + 3_600_000,
    );
    clock += 3_600_000;
    host.harness.submitInteraction(pending.id, {
      values: { API_KEY: CANARY_SUBMITTED },
    });
    await expect(running).rejects.toMatchObject({ code: "expired" });
    expect(host.harness.sdk.callsTo("files.secretCommit")).toEqual([]);
  });

  it("surfaces a host refusal at request time without showing the form", async () => {
    const host = makeHost({
      probe: () => ({
        outcome: "refused",
        reason: "not-allowlisted",
        message: "This destination is not on the secrets allowlist.",
      }),
    });
    register(host);
    const result = await host.harness.runCli(BASE, CTX);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not on the secrets allowlist");
    expect(host.harness.pendingInteractions).toEqual([]);
    expect(host.harness.sdk.callsTo("files.secretCommit")).toEqual([]);
  });

  it("surfaces a host refusal at write time", async () => {
    const host = makeHost({
      commit: () => ({
        outcome: "refused",
        reason: "identity-changed",
        message: "The destination changed after the request; ask again.",
      }),
    });
    register(host);
    const command = host.harness.runCli(BASE, CTX);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      values: { API_KEY: "fake-one", TOKEN: "fake-two" },
    });
    const result = await command;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("changed after the request");
  });

  it("reports committed-elsewhere and replaced-after-commit with a non-zero exit", async () => {
    for (const outcome of ["committed-elsewhere", "replaced-after-commit"]) {
      const host = makeHost({
        commit: () => ({ outcome, added: 2, updated: 0, unchanged: 0 }),
      });
      register(host);
      const command = host.harness.runCli(BASE, CTX);
      await vi.waitFor(() =>
        expect(host.harness.pendingInteractions).toHaveLength(1),
      );
      host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
        values: { API_KEY: "fake-one", TOKEN: "fake-two" },
      });
      const result = await command;
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout ?? "").outcome).toBe(outcome);
    }
  });

  it("rejects a response that does not hold exactly the requested names", async () => {
    const host = makeHost();
    register(host);
    const command = host.harness.runCli(BASE, CTX);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      values: { API_KEY: "fake-one" },
    });
    const result = await command;
    expect(result.exitCode).toBe(1);
    expect(host.harness.sdk.callsTo("files.secretCommit")).toEqual([]);
  });

  it("T1.3: canaries never reach output, errors or the thread-visible text", async () => {
    const host = makeHost({
      probe: () => readyProbe({ existingNames: ["API_KEY"] }),
      commit: (args) => {
        throw Object.assign(
          new Error(`boom ${JSON.stringify(args)} ${CANARY_EXISTING}`),
          { status: 500 },
        );
      },
    });
    register(host);
    const command = host.harness.runCli([...BASE, "--json"], CTX);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      values: { API_KEY: CANARY_SUBMITTED, TOKEN: CANARY_SUBMITTED },
    });
    const result = await command;
    const everything = JSON.stringify([
      result,
      host.harness.pendingInteractions,
    ]);
    expect(result.exitCode).toBe(1);
    expect(everything).not.toContain(CANARY_SUBMITTED);
    expect(everything).not.toContain(CANARY_EXISTING);
    expect(result.stderr).toContain("HTTP 500");
  });

  it("T1.3: a malformed response is reported without echoing it", async () => {
    const host = makeHost();
    register(host);
    const command = host.harness.runCli(BASE, CTX);
    await vi.waitFor(() =>
      expect(host.harness.pendingInteractions).toHaveLength(1),
    );
    host.harness.submitInteraction(host.harness.pendingInteractions[0]!.id, {
      values: { API_KEY: `${CANARY_SUBMITTED}\nsecond line` },
      extra: CANARY_SUBMITTED,
    });
    const result = await command;
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result)).not.toContain(CANARY_SUBMITTED);
    expect(host.harness.sdk.callsTo("files.secretCommit")).toEqual([]);
  });

  it("T1.3: a key-shaped purpose or description is refused before any host call", async () => {
    const host = makeHost();
    register(host);
    const fakeKey = `sk-${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`;
    const result = await host.harness.runCli(
      [...BASE, "--purpose", `use ${fakeKey}`],
      CTX,
    );
    expect(result.exitCode).toBe(1);
    expect(JSON.stringify(result)).not.toContain(fakeKey);
    expect(host.harness.sdk.callsTo("files.secretProbe")).toEqual([]);
  });

  it.each([
    {
      argv: [...BASE, "--purpose", "--write-env", ".env"],
      message: "--purpose requires a value",
    },
    {
      argv: [
        "request",
        "API_KEY",
        "--project",
        "demo",
        "--describe",
        "API_KEY",
      ],
      message: "missing required options: --write-env",
    },
    {
      argv: ["request", "API_KEY", "--write-env", ".env"],
      message: "missing required options: --project",
    },
    {
      argv: ["request", "--project", "demo", "--write-env", ".env"],
      message: "missing required arguments: <name>",
    },
    {
      argv: [...BASE, "--wrote-env", "x"],
      message: "unknown option '--wrote-env' (Did you mean --write-env?)",
    },
    {
      argv: [...BASE, "--describe", "OTHER=text"],
      message: "--describe references unrequested variable OTHER.",
    },
    {
      argv: [
        "request",
        "API_KEY",
        "API_KEY",
        "--project",
        "demo",
        "--write-env",
        ".env",
      ],
      message: "Variable names must be unique.",
    },
    {
      argv: ["request", "1BAD", "--project", "demo", "--write-env", ".env"],
      message:
        "Variable name must start with a letter or underscore and contain only letters, digits, and underscores.",
    },
    {
      argv: [
        "request",
        "API_KEY=value",
        "--project",
        "demo",
        "--write-env",
        ".env",
      ],
      message: "Variable name must be a bare variable name",
    },
    {
      argv: [
        "request",
        "API_KEY",
        "--project",
        "demo",
        "--write-env",
        "a/../.env",
      ],
      message: "--write-env must be a normalized path.",
    },
    {
      argv: [
        "request",
        "API_KEY",
        "--project",
        "demo",
        "--write-env",
        "a//.env",
      ],
      message: "--write-env must be a normalized path.",
    },
    {
      argv: [
        "request",
        "API_KEY",
        "--project",
        "demo",
        "--write-env",
        "./.env",
      ],
      message: "--write-env must be a normalized path.",
    },
  ])(
    "reports a usage error for malformed invocation $argv",
    async ({ argv, message }) => {
      const host = makeHost();
      register(host);
      const result = await host.harness.runCli(argv, CTX);
      expect(result.exitCode).toBe(1);
      expect(result.stderr.split("\n")[0]).toContain(message);
      expect(result.stderr).not.toContain("API_KEY=value");
      expect(host.harness.pendingInteractions).toEqual([]);
      expect(host.harness.sdk.callsTo("files.secretProbe")).toEqual([]);
    },
  );

  it("reports failures as JSON with --json", async () => {
    const host = makeHost();
    register(host);
    const result = await host.harness.runCli([...BASE, "--json"], {
      cwd: "/workspace",
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      error: {
        code: "missing_thread",
        message: "bb secret request must run from a bb thread.",
      },
    });
    expect(host.harness.pendingInteractions).toEqual([]);
  });

  it.each([["--help"], ["request", "--help"], ["help"]])(
    "documents %s without running the command",
    async (...argv) => {
      const host = makeHost();
      register(host);
      const result = await host.harness.runCli(argv, CTX);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("bb secret request");
      expect(host.harness.pendingInteractions).toEqual([]);
    },
  );
});
