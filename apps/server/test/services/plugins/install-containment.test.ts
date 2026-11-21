import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { InstalledPlugin } from "@bb/server-contract";
import { createNodeBbSdk } from "@bb/sdk";
import { hostToolchain } from "@bb/process-utils";
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
  it("contains npm fallback rebuilds and their real esbuild children", async () => {
    const root = await mkdtemp(
      join(process.env.BB_CONTAINMENT_TEST_ROOT ?? tmpdir(), "contained-npm-"),
    );
    const source = join(root, "package");
    await mkdir(source);
    const name = "bb-plugin-contained-npm";
    const version = "1.0.0";
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name,
        version,
        bb: {
          name: "Contained npm",
          description: "Containment fixture",
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
    const packed = await exec(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", root],
      { cwd: source },
    );
    const files = z
      .array(z.object({ filename: z.string() }))
      .parse(JSON.parse(packed.stdout));
    const tarball = await readFile(join(root, files[0]!.filename));
    const registry = createServer((request, response) => {
      if (request.url === "/package.tgz") {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(tarball);
      } else if (request.url === `/${name}`) {
        const origin = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            name,
            "dist-tags": { latest: version },
            versions: {
              [version]: {
                name,
                version,
                dist: {
                  tarball: `${origin}/package.tgz`,
                  shasum: createHash("sha1").update(tarball).digest("hex"),
                  integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
                },
              },
            },
          }),
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    registry.listen(
      Number(process.env.BB_CONTAINMENT_REGISTRY_PORT ?? "0"),
      "127.0.0.1",
    );
    await once(registry, "listening");
    try {
      const registryUrl = `http://127.0.0.1:${(registry.address() as AddressInfo).port}`;
      const npmrc = join(root, "npmrc");
      await writeFile(npmrc, `registry=${registryUrl}\n`);
      const observer = join(root, "observe.cjs");
      const observed = join(root, "esbuild.jsonl");
      await writeFile(
        observer,
        `
        const fs = require('node:fs');
        const cp = require('node:child_process');
        const original = cp.spawn;
        cp.spawn = function(command, args, options) {
          const service = String(command).includes('esbuild') && Array.isArray(args) && args.some(arg => arg.startsWith('--service='));
          if (service && !require('node:path').isAbsolute(command)) throw new Error('esbuild binary must be absolute');
          const child = original.call(this, command, args, options);
          if (service) {
            child.once('spawn', () => fs.appendFileSync(${JSON.stringify(observed)}, JSON.stringify({ pid: child.pid, cgroup: fs.readFileSync('/proc/' + child.pid + '/cgroup', 'utf8') }) + '\\n'));
          }
          return child;
        };
        require('node:module').syncBuiltinESMExports();
      `,
      );
      const file = join(root, "server.mjs");
      const jobsModule = new URL(
        "../../../src/services/plugins/plugin-install-jobs.ts",
        import.meta.url,
      ).href;
      const harnessModule = new URL(
        "../../helpers/test-app.ts",
        import.meta.url,
      ).href;
      await writeFile(
        file,
        `
        import { readFile, writeFile } from 'node:fs/promises';
        import { createPluginInstallJobs } from ${JSON.stringify(jobsModule)};
        import { withTestHarness } from ${JSON.stringify(harnessModule)};
        await withTestHarness(async h => {
          const records = async () => { try { return (await readFile(${JSON.stringify(observed)}, 'utf8')).trim().split('\\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
          const before = await records();
          const jobs = createPluginInstallJobs({ notifyChanged() {} });
          const source = 'npm:${name}@${version}';
          const job = jobs.start({ requestKey: ${JSON.stringify(randomUUID())}, target: { kind: 'source', source, selection: { kind: 'root' } }, displayName: 'Contained npm', run: () => h.pluginService.install(source, { kind: 'root' }) });
          const settled = await jobs.settled(job.id);
          const during = (await records()).slice(before.length);
          await writeFile(${JSON.stringify(join(root, "result.json"))}, JSON.stringify({ job: settled, during, after: (await records()).slice(before.length) }));
        });
      `,
      );
      try {
        const output = await exec(
          process.execPath,
          ["--conditions=source", "--import", import.meta.resolve("tsx"), file],
          {
            env: {
              ...process.env,
              NPM_CONFIG_USERCONFIG: npmrc,
              npm_config_registry: registryUrl,
              npm_config_cache: join(root, "npm-cache"),
              NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${observer}`,
            },
            timeout: 60_000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        await writeFile(
          join(root, "server.log"),
          output.stdout + output.stderr,
        );
      } catch (error) {
        await writeFile(join(root, "server-error.log"), String(error));
        throw error;
      }
      const result = z
        .object({
          job: z.object({
            state: z.string(),
            error: z.string().optional(),
            plugin: z.object({ status: z.string() }).optional(),
            containment: z.object({ id: z.string() }),
          }),
          during: z.array(processRecord),
          after: z.array(processRecord),
        })
        .parse(JSON.parse(await readFile(join(root, "result.json"), "utf8")));
      expect(
        result.during.filter(
          (record) => !record.cgroup.includes(result.job.containment.id),
        ),
      ).toEqual([]);
      expect(result.during.length).toBeGreaterThan(0);
      expect(result.job).toMatchObject({
        state: "succeeded",
        plugin: { status: "running" },
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        registry.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 120_000);

  it("cannot start a delayed installer after its original server dies and recovery releases", async () => {
    const root = await mkdtemp(
      join(process.env.BB_CONTAINMENT_TEST_ROOT ?? tmpdir(), "delayed-launch-"),
    );
    const bin = join(root, "bin");
    await mkdir(bin);
    const real = hostToolchain.resolve("systemd-run");
    if (real === null)
      throw new Error("systemd-run is required for containment tests");
    const requestKey = randomUUID();
    const launcher = `#!${process.execPath}
      const fs = require('node:fs');
      const path = require('node:path');
      const { spawnSync } = require('node:child_process');
      const args = process.argv.slice(2);
      const root = ${JSON.stringify(root)};
      const delay = args.includes('--scope') && args.some(arg => arg.includes('C3_LATE_MUTATION') || arg.includes('BB_INSTALL_CONTAINMENT_READY'));
      const run = () => {
        const result = spawnSync(${JSON.stringify(real)}, args, { stdio: 'inherit' });
        if (delay) fs.writeFileSync(path.join(root, 'control-completed'), String(result.status));
        process.exit(result.status ?? 1);
      };
      if (!delay) run();
      else {
        fs.writeFileSync(path.join(root, 'control-pending'), String(process.pid));
        const timer = setInterval(() => {
          if (fs.existsSync(path.join(root, 'release-control'))) { clearInterval(timer); run(); }
        }, 10);
      }
    `;
    await writeFile(join(bin, "systemd-run"), launcher, { mode: 0o755 });
    const serverFile = join(root, "server.mjs");
    const jobsModule = new URL(
      "../../../src/services/plugins/plugin-install-jobs.ts",
      import.meta.url,
    ).href;
    const sourcesModule = new URL(
      "../../../src/services/plugins/install-sources.ts",
      import.meta.url,
    ).href;
    const mutation = `require('node:fs').writeFileSync(${JSON.stringify(join(root, "mutation"))}, 'C3_LATE_MUTATION')`;
    await writeFile(
      serverFile,
      `
      import { writeFile } from 'node:fs/promises';
      import { createPluginInstallJobs } from ${JSON.stringify(jobsModule)};
      import { runInstallCommand } from ${JSON.stringify(sourcesModule)};
      const jobs = createPluginInstallJobs({ notifyChanged() {} });
      const job = jobs.start({ requestKey: ${JSON.stringify(requestKey)}, target: { kind: 'source', source: 'npm:delayed-fixture', selection: { kind: 'root' } }, displayName: 'Delayed fixture', run: async () => { await runInstallCommand(process.execPath, ['-e', ${JSON.stringify(mutation)}]); throw new Error('fixture finished'); } });
      await writeFile(${JSON.stringify(join(root, "original-server.json"))}, JSON.stringify(job.containment));
      await jobs.settled(job.id);
    `,
    );
    const original = spawn(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        import.meta.resolve("tsx"),
        serverFile,
      ],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
        stdio: "ignore",
      },
    );
    try {
      await once(original, "spawn");
      await vi.waitFor(
        () => expect(existsSync(join(root, "control-pending"))).toBe(true),
        { timeout: 15_000 },
      );
      const metadata = z
        .object({
          server: z.object({ pid: z.number(), startTime: z.string() }),
        })
        .parse(
          JSON.parse(
            await readFile(join(root, "original-server.json"), "utf8"),
          ),
        );
      const restarted = createPluginInstallJobs({ notifyChanged: () => {} });
      expect(
        (await restarted.inspectContainment(requestKey, metadata.server))
          .canRelease,
      ).toBe(false);
      const exited = once(original, "exit");
      original.kill("SIGKILL");
      await exited;
      expect(
        (await restarted.inspectContainment(requestKey, metadata.server))
          .canRelease,
      ).toBe(true);
      await writeFile(join(root, "release-control"), "release");
      await vi.waitFor(
        () => expect(existsSync(join(root, "control-completed"))).toBe(true),
        { timeout: 15_000 },
      );
      expect(existsSync(join(root, "mutation"))).toBe(false);
    } finally {
      await writeFile(join(root, "release-control"), "release");
      if (original.exitCode === null && original.signalCode === null) {
        const exited = once(original, "exit");
        original.kill("SIGKILL");
        await exited;
      }
    }
  }, 60_000);

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
      const safeguards = await sdk.plugins.experimental_safeguards();
      expect(safeguards.capabilities).toContain("install-containment-v1");
      expect(safeguards.server).toMatchObject({
        pid: process.pid,
        startTime: expect.any(String),
      });
      await expect(
        sdk.plugins.startInstall({
          source: spec,
          requestKey,
          expectedServer: { pid: process.pid, startTime: "0" },
        }),
      ).rejects.toMatchObject({ status: 409, code: "install_server_changed" });
      const job = await sdk.plugins.startInstall({
        source: spec,
        requestKey,
        expectedServer: safeguards.server!,
      });
      expect(job.containment!.server).toEqual(safeguards.server);
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
      const originalServer = { ...job.containment!.server };
      const known = jobs.get(job.id)!;
      Object.assign(known.containment!.server, {
        pid: 2147483647,
        startTime: "1",
      });
      try {
        expect(
          (await jobs.inspectContainment(requestKey, originalServer))
            .canRelease,
        ).toBe(false);
      } finally {
        Object.assign(known.containment!.server, originalServer);
      }
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
