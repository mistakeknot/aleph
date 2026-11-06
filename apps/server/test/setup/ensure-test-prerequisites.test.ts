import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type GeneratedPrerequisite,
  GENERATED_PREREQUISITES,
  ensurePrerequisite,
  isMissing,
  missingPrerequisites,
} from "./ensure-test-prerequisites.js";

const repoRoot = join(import.meta.dirname, "../../../..");
const sdkPrerequisite = GENERATED_PREREQUISITES[1]!;

describe("ensureTestPrerequisites", () => {
  const roots: string[] = [];

  const runners: ChildProcess[] = [];

  function hardKill(pid: number): void {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        continue;
      }
    }
  }

  afterEach(async () => {
    for (const runner of runners.splice(0)) {
      if (runner.exitCode === null && runner.signalCode === null) {
        const gone = new Promise<void>((resolve) => {
          runner.once("exit", () => resolve());
        });
        runner.kill("SIGKILL");
        await gone;
      }
    }
    for (const root of roots.splice(0)) {
      const packageDir = join(root, "pkg");
      if (existsSync(packageDir)) {
        for (const name of readdirSync(packageDir)) {
          if (name.endsWith(".pid")) {
            hardKill(Number(readFileSync(join(packageDir, name), "utf8")));
          }
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  function emptyRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "bb-prerequisites-"));
    roots.push(root);
    return root;
  }

  function touch(path: string, contents = ""): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  async function populate(root: string): Promise<void> {
    for (const prerequisite of GENERATED_PREREQUISITES) {
      for (const output of await prerequisite.outputs()) {
        touch(join(root, prerequisite.packageDir, output));
      }
    }
  }

  it("reports every prerequisite when nothing is built", async () => {
    expect(
      await missingPrerequisites(GENERATED_PREREQUISITES, emptyRoot()),
    ).toEqual(GENERATED_PREREQUISITES);
  });

  it("derives the plugin SDK outputs from its package exports", async () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages/plugin-sdk/package.json"), "utf8"),
    ) as { exports: Record<string, { import: string }> };
    const outputs = await sdkPrerequisite.outputs();
    for (const entry of Object.values(manifest.exports)) {
      expect(outputs).toContain(entry.import.slice(2));
    }
    expect(outputs).toContain("dist/provider-bridge.js");
  });

  it("reports nothing missing once every output exists", async () => {
    const root = emptyRoot();
    await populate(root);
    expect(await missingPrerequisites(GENERATED_PREREQUISITES, root)).toEqual(
      [],
    );
  });

  it("reports the SDK as missing when any single exported output is absent", async () => {
    const outputs = await sdkPrerequisite.outputs();
    for (const output of outputs) {
      const root = emptyRoot();
      await populate(root);
      rmSync(join(root, sdkPrerequisite.packageDir, output));
      expect(await isMissing(sdkPrerequisite, root)).toBe(true);
    }
  });

  function fakePrerequisite(root: string, body: string): GeneratedPrerequisite {
    touch(join(root, "pkg/build.mjs"), body);
    return {
      label: "fake artifact",
      packageDir: "pkg",
      script: "build.mjs",
      outputs: async () => ["out.txt"],
    };
  }

  it("lets concurrent builds finish without exposing a partial output", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(
      root,
      [
        'import { appendFileSync, renameSync, writeFileSync } from "node:fs";',
        'appendFileSync("builds.log", "x\\n");',
        "await new Promise((resolve) => setTimeout(resolve, 300));",
        'writeFileSync(`out.txt.${process.pid}`, "done");',
        'renameSync(`out.txt.${process.pid}`, "out.txt");',
      ].join("\n"),
    );
    await Promise.all([
      ensurePrerequisite(prerequisite, root),
      ensurePrerequisite(prerequisite, root),
      ensurePrerequisite(prerequisite, root),
    ]);
    expect(readFileSync(join(root, "pkg/out.txt"), "utf8")).toBe("done");
    expect(await isMissing(prerequisite, root)).toBe(false);
  });

  it("skips the build when the outputs already exist", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(root, 'throw new Error("ran");');
    touch(join(root, "pkg/out.txt"), "done");
    await ensurePrerequisite(prerequisite, root);
  });

  it("reports a failing build with its exit code and output", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(root, 'throw new Error("boom");');
    await expect(ensurePrerequisite(prerequisite, root)).rejects.toThrow(
      /Could not build fake artifact before the server tests: exited with code 1: [\s\S]*boom/,
    );
  });

  it("fails with a descriptive error when the build exceeds its timeout", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(
      root,
      "await new Promise((resolve) => setTimeout(resolve, 30000));",
    );
    await expect(
      ensurePrerequisite(prerequisite, root, {
        timeoutMs: 500,
        killGraceMs: 200,
      }),
    ).rejects.toThrow(
      "Could not build fake artifact before the server tests: timed out after 500 ms",
    );
  });

  it("force-kills a build that ignores SIGTERM", async () => {
    const root = emptyRoot();
    const prerequisite = fakePrerequisite(
      root,
      [
        'import { writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => {});',
        'writeFileSync("child.pid", String(process.pid));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const started = Date.now();
    await expect(
      ensurePrerequisite(prerequisite, root, {
        timeoutMs: 1500,
        killGraceMs: 300,
      }),
    ).rejects.toThrow("timed out after 1500 ms");
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(join(root, "pkg/child.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  async function waitFor(condition: () => boolean, limitMs: number) {
    const giveUpAt = Date.now() + limitMs;
    while (!condition() && Date.now() < giveUpAt) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return condition();
  }

  function isDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }

  it("force-kills a SIGTERM-ignoring grandchild that outlives the build", async () => {
    const root = emptyRoot();
    touch(
      join(root, "pkg/grandchild.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => {});',
        'writeFileSync("grandchild.pid", String(process.pid));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const prerequisite = fakePrerequisite(
      root,
      [
        'import { spawn } from "node:child_process";',
        'import { existsSync, writeFileSync } from "node:fs";',
        'spawn(process.execPath, ["grandchild.mjs"], { stdio: "ignore" }).unref();',
        'while (!existsSync("grandchild.pid")) {',
        "  await new Promise((resolve) => setTimeout(resolve, 20));",
        "}",
        'writeFileSync("out.txt", "done");',
      ].join("\n"),
    );
    const started = Date.now();
    await ensurePrerequisite(prerequisite, root, {
      timeoutMs: 20_000,
      killGraceMs: 300,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(readFileSync(join(root, "pkg/grandchild.pid"), "utf8"));
    expect(await waitFor(() => isDead(pid), 2_000)).toBe(true);
  });

  interface SetupEnd {
    readonly name: string;
    readonly signal: "SIGTERM" | "SIGINT" | undefined;
  }

  const setupEnds: readonly SetupEnd[] = [
    { name: "SIGTERM", signal: "SIGTERM" },
    { name: "SIGINT", signal: "SIGINT" },
    { name: "a normal exit", signal: undefined },
  ];

  function startSetup(root: string, mode: string, competing = "") {
    fakePrerequisite(
      root,
      [
        'import { writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => {});',
        'writeFileSync("child.pid", String(process.pid));',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const moduleUrl = pathToFileURL(
      join(import.meta.dirname, "ensure-test-prerequisites.ts"),
    ).href;
    touch(
      join(root, "runner.mjs"),
      [
        'import { appendFileSync, existsSync, writeFileSync } from "node:fs";',
        `import { ensurePrerequisite } from ${JSON.stringify(moduleUrl)};`,
        "const [, , root, mode, competing] = process.argv;",
        "const prerequisite = {",
        '  label: "fake artifact",',
        '  packageDir: "pkg",',
        '  script: "build.mjs",',
        '  outputs: async () => ["out.txt"],',
        "};",
        "const [signal, kind, order] = competing.split(':');",
        "const unrelated = () => {};",
        "const register = () => {",
        "  if (!signal) {",
        "    return;",
        "  }",
        "  const record = () => appendFileSync(`${root}/handler.log`, 'x');",
        "  if (kind === 'once') {",
        "    process.once(signal, record);",
        "  } else if (kind === 'self') {",
        "    const handler = () => {",
        "      process.off(signal, handler);",
        "      record();",
        "    };",
        "    process.on(signal, handler);",
        "  } else if (kind === 'unrelated') {",
        "    process.on(signal, unrelated);",
        "  } else {",
        "    process.on(signal, record);",
        "  }",
        "};",
        "let registered = false;",
        "const attach = () => {",
        "  registered = true;",
        "  register();",
        "  writeFileSync(`${root}/ready`, 'ready');",
        "};",
        "if (order !== 'after') {",
        "  attach();",
        "}",
        "setInterval(() => {",
        "  if (!registered && existsSync(`${root}/pkg/child.pid`)) {",
        "    attach();",
        "  }",
        "  if (mode === 'exit' && existsSync(`${root}/go`)) {",
        "    process.exit(0);",
        "  }",
        "  if (kind === 'unrelated' && existsSync(`${root}/trigger`)) {",
        "    process.off(signal, unrelated);",
        "    process.emit('SIGTERM');",
        "  }",
        "}, 20);",
        "await ensurePrerequisite(prerequisite, root, {",
        "  timeoutMs: 60000,",
        "  killGraceMs: 60000,",
        "}).catch(() => {});",
      ].join("\n"),
    );
    const tsxLoader = pathToFileURL(
      createRequire(import.meta.url).resolve("tsx"),
    ).href;
    const setup = spawn(
      process.execPath,
      ["--import", tsxLoader, join(root, "runner.mjs"), root, mode, competing],
      { cwd: root, stdio: "ignore" },
    );
    runners.push(setup);
    const ended = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      setup.on("exit", (code, signal) => resolve({ code, signal }));
    });
    return { setup, ended };
  }

  async function buildPid(root: string): Promise<number> {
    const pidFile = join(root, "pkg/child.pid");
    expect(await waitFor(() => existsSync(pidFile), 15_000)).toBe(true);
    return Number(readFileSync(pidFile, "utf8"));
  }

  it.each(setupEnds)(
    "kills the running build group when setup ends by $name",
    async ({ signal }) => {
      const root = emptyRoot();
      const { setup, ended } = startSetup(
        root,
        signal === undefined ? "exit" : "wait",
      );
      const pid = await buildPid(root);
      expect(isDead(pid)).toBe(false);
      if (signal === undefined) {
        writeFileSync(join(root, "go"), "go");
      } else {
        setup.kill(signal);
      }
      const result = await ended;
      expect(result.signal).toBe(signal ?? null);
      expect(result.code).toBe(signal === undefined ? 0 : null);
      expect(await waitFor(() => isDead(pid), 5_000)).toBe(true);
    },
    60_000,
  );

  interface Competing {
    readonly signal: "SIGTERM" | "SIGINT";
    readonly kind: "persistent" | "once" | "self";
    readonly order: "before" | "after";
  }

  const competingHandlers: readonly Competing[] = [
    { signal: "SIGTERM", kind: "persistent", order: "before" },
    { signal: "SIGINT", kind: "persistent", order: "before" },
    { signal: "SIGTERM", kind: "persistent", order: "after" },
    { signal: "SIGTERM", kind: "once", order: "before" },
    { signal: "SIGTERM", kind: "once", order: "after" },
    { signal: "SIGINT", kind: "once", order: "before" },
    { signal: "SIGTERM", kind: "self", order: "before" },
    { signal: "SIGTERM", kind: "self", order: "after" },
    { signal: "SIGINT", kind: "self", order: "before" },
  ];

  it.each(competingHandlers)(
    "runs a $kind $signal handler registered $order setup exactly once and leaves it in charge",
    async ({ signal, kind, order }) => {
      const root = emptyRoot();
      const { setup, ended } = startSetup(
        root,
        "wait",
        `${signal}:${kind}:${order}`,
      );
      const pid = await buildPid(root);
      expect(await waitFor(() => existsSync(join(root, "ready")), 5_000)).toBe(
        true,
      );
      setup.kill(signal);
      const handlerLog = join(root, "handler.log");
      expect(await waitFor(() => existsSync(handlerLog), 5_000)).toBe(true);
      expect(await waitFor(() => isDead(pid), 5_000)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(readFileSync(handlerLog, "utf8")).toBe("x");
      expect(setup.exitCode).toBeNull();
      expect(setup.signalCode).toBeNull();
      setup.kill("SIGKILL");
      const result = await ended;
      expect(result.signal).toBe("SIGKILL");
    },
    60_000,
  );

  it("still re-raises SIGTERM after an unrelated SIGINT listener is removed in the same tick", async () => {
    const root = emptyRoot();
    const { ended } = startSetup(root, "wait", "SIGINT:unrelated:before");
    const pid = await buildPid(root);
    expect(await waitFor(() => existsSync(join(root, "ready")), 5_000)).toBe(
      true,
    );
    writeFileSync(join(root, "trigger"), "go");
    const result = await ended;
    expect(result.signal).toBe("SIGTERM");
    expect(await waitFor(() => isDead(pid), 5_000)).toBe(true);
  }, 60_000);
});
