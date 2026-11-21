import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { InstalledPlugin } from "@bb/server-contract";
import { createNodeBbSdk } from "@bb/sdk";
import { createPluginInstallJobs } from "../../../src/services/plugins/plugin-install-jobs.js";
import { runInstallCommand } from "../../../src/services/plugins/install-sources.js";
import { withTestHarness } from "../../helpers/test-app.js";

let plugin: InstalledPlugin;

beforeAll(async () => {
  plugin = await withTestHarness((h) =>
    h.pluginService.install("builtin:keep-awake", { kind: "root" }),
  );
});

const processRecord = z.object({ pid: z.number(), cgroup: z.string() });
const descendantSource = `
  const fs = require('node:fs');
  const path = require('node:path');
  const root = process.argv[1];
  fs.writeFileSync(path.join(root, 'child.json'), JSON.stringify({ pid: process.pid, cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8') }));
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(root, 'release'))) {
      clearInterval(timer);
      fs.writeFileSync(path.join(root, 'child-finished'), 'finished');
    } else {
      fs.appendFileSync(path.join(root, 'heartbeat'), 'write\\n');
    }
  }, 15);
`;

describe("install containment", () => {
  it("runs a real Git install and its build worker inside the requested containment", async () => {
    const root = await mkdtemp(
      join(process.env.BB_CONTAINMENT_TEST_ROOT ?? tmpdir(), "contained-git-"),
    );
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "bb-plugin-contained-build",
        version: "1.0.0",
        bb: {
          name: "Contained build",
          description: "Build containment fixture",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(source, "server.ts"),
      "export default function plugin() {}\n",
    );
    const exec = promisify(execFile);
    await exec("git", ["init", "-q", "-b", "main"], { cwd: source });
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "add",
        ".",
      ],
      { cwd: source },
    );
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "-qm",
        "fixture",
      ],
      { cwd: source },
    );
    const commit = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: source })
    ).stdout.trim();
    await withTestHarness(async (h) => {
      const requestKey = randomUUID();
      const spec = `git:${source}@${commit}`;
      const sdk = createNodeBbSdk({
        baseUrl: "http://127.0.0.1:3334",
        fetch: async (input, init) => h.app.request(String(input), init),
      });
      expect(
        (await sdk.plugins.experimental_safeguards()).capabilities,
      ).toContain("install-containment-v1");
      const job = await sdk.plugins.startInstall({ source: spec, requestKey });
      await vi.waitFor(
        async () =>
          expect(
            (await sdk.plugins.installJobs.get({ jobId: job.id })).state,
          ).toBe("succeeded"),
        { timeout: 30_000 },
      );
      const finished = await sdk.plugins.installJobs.get({ jobId: job.id });
      expect(finished).toMatchObject({
        state: "succeeded",
        plugin: { id: "contained-build", status: "running" },
      });
      expect(
        (
          await sdk.plugins.installJobs.experimental_inspectContainment({
            requestKey,
            server: job.containment!.server,
          })
        ).canRelease,
      ).toBe(true);
      expect(
        (await sdk.plugins.startInstall({ source: spec, requestKey })).id,
      ).toBe(job.id);
    });
  }, 60_000);

  for (const outcome of ["succeeded", "failed"] as const) {
    it(`keeps a ${outcome} callback running and recovery blocked while a late descendant writes`, async () => {
      const fixtureRoot = process.env.BB_CONTAINMENT_TEST_ROOT ?? tmpdir();
      await mkdir(fixtureRoot, { recursive: true });
      const root = await mkdtemp(join(fixtureRoot, "contained-install-"));
      const requestKey = randomUUID();
      const jobs = createPluginInstallJobs({ notifyChanged: () => {} });
      const parentSource = `
        const fs = require('node:fs');
        const path = require('node:path');
        const { spawn } = require('node:child_process');
        const root = process.argv[1];
        fs.writeFileSync(path.join(root, 'parent.json'), JSON.stringify({ pid: process.pid, cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8') }));
        setTimeout(() => {
          const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}, root], { detached: true, stdio: 'ignore' });
          child.unref();
        }, 50);
      `;
      const job = jobs.start({
        requestKey,
        target: {
          kind: "source",
          source: "npm:contained-fixture",
          selection: { kind: "root" },
        },
        displayName: "Contained fixture",
        run: async () => {
          await runInstallCommand(process.execPath, ["-e", parentSource, root]);
          await writeFile(join(root, "callback-returned"), "returned");
          if (outcome === "failed")
            throw new Error("installer callback failed");
          return plugin;
        },
      });
      try {
        expect(job.containment).toMatchObject({
          requestKey,
          server: { pid: process.pid, startTime: expect.any(String) },
        });
        const selfStat = await readFile("/proc/self/stat", "utf8");
        expect(job.containment!.server.startTime).toBe(
          selfStat.slice(selfStat.lastIndexOf(") ") + 2).split(" ")[19],
        );
        await vi.waitFor(
          () => expect(existsSync(join(root, "callback-returned"))).toBe(true),
          { timeout: 10_000 },
        );
        await vi.waitFor(
          async () =>
            expect(
              (await readFile(join(root, "heartbeat"), "utf8")).length,
            ).toBeGreaterThan(12),
          { timeout: 10_000 },
        );
        const parent = processRecord.parse(
          JSON.parse(await readFile(join(root, "parent.json"), "utf8")),
        );
        const child = processRecord.parse(
          JSON.parse(await readFile(join(root, "child.json"), "utf8")),
        );
        expect(parent.cgroup).toContain(job.containment!.id);
        expect(child.cgroup).toContain(job.containment!.id);
        expect(jobs.get(job.id)).toMatchObject({
          state: "running",
          detail: "draining",
        });
        const observed = await jobs.inspectContainment(
          requestKey,
          job.containment!.server,
        );
        expect(observed).toMatchObject({
          id: job.containment!.id,
          state: "nonempty",
          canRelease: false,
        });
        const current = jobs.get(job.id)!;
        Object.assign(current, { state: "succeeded", plugin });
        expect(
          (await jobs.inspectContainment(requestKey, job.containment!.server))
            .canRelease,
        ).toBe(false);
        Object.assign(current, { state: "running", detail: "draining" });
        const restartedRegistry = createPluginInstallJobs({
          notifyChanged: () => {},
        });
        expect(
          (
            await restartedRegistry.inspectContainment(
              requestKey,
              job.containment!.server,
            )
          ).canRelease,
        ).toBe(false);
      } finally {
        await writeFile(join(root, "release"), "release");
        await jobs.settled(job.id);
      }
      expect(jobs.get(job.id)?.state).toBe(outcome);
      expect(
        (await jobs.inspectContainment(requestKey, job.containment!.server))
          .canRelease,
      ).toBe(true);
      const unknownRegistry = createPluginInstallJobs({
        notifyChanged: () => {},
      });
      expect(
        await unknownRegistry.inspectContainment(
          requestKey,
          job.containment!.server,
        ),
      ).toMatchObject({ originalServerExited: false, canRelease: false });
      expect(existsSync(join(root, "child-finished"))).toBe(true);
    }, 30_000);
  }
});
