import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostPackageRoot = resolve(packageRoot, "host-package");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const probeSource = [
  'import { createRequire } from "node:module";',
  'import { join } from "node:path";',
  "const require = createRequire(join(process.argv[2], 'package.json'));",
  "const Database = require('better-sqlite3');",
  "const db = new Database(':memory:');",
  "const version = db.prepare('SELECT sqlite_version() AS v').get().v;",
  "const octet = db.prepare(\"SELECT octet_length('é') AS n\").get().n;",
  "db.exec('CREATE VIRTUAL TABLE probe USING fts5(text)');",
  "db.prepare('INSERT INTO probe (text) VALUES (?)').run('session search probe');",
  "const matches = db.prepare('SELECT count(*) AS n FROM probe WHERE probe MATCH ?').get('probe').n;",
  "db.prepare('DELETE FROM probe').run();",
  "const remaining = db.prepare('SELECT count(*) AS n FROM probe').get().n;",
  "db.close();",
  "const resolved = require.resolve('better-sqlite3');",
  "console.log(JSON.stringify({ sqliteVersion: version, octetLength: octet, matches, remaining, resolved }));",
].join("\n");

function run(command, args, options) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

const workDir = await mkdtemp(join(tmpdir(), "bb-host-sqlite-"));
const row = {
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  abi: process.versions.modules,
  status: "fail",
};
try {
  const packDir = join(workDir, "pack");
  const installDir = join(workDir, "install");
  const scriptDir = join(workDir, "script");
  for (const dir of [packDir, installDir, scriptDir]) {
    await mkdir(dir, { recursive: true });
  }
  run(npmCommand, ["pack", "--pack-destination", packDir, "--silent"], {
    cwd: hostPackageRoot,
    shell: process.platform === "win32",
  });
  const tarball = (await readdir(packDir)).find((name) =>
    name.endsWith(".tgz"),
  );
  if (tarball === undefined) {
    throw new Error("npm pack produced no tarball");
  }
  await writeFile(
    join(installDir, "package.json"),
    '{"name":"bb-host-sqlite-probe","private":true}\n',
  );
  run(
    npmCommand,
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      join(packDir, tarball),
    ],
    { cwd: installDir, shell: process.platform === "win32" },
  );
  const installedPackageDir = join(installDir, "node_modules", "bb-app");
  const probePath = join(scriptDir, "probe.mjs");
  await writeFile(probePath, probeSource);
  const output = run(process.execPath, [probePath, installedPackageDir], {
    cwd: scriptDir,
  });
  const probe = JSON.parse(output.trim());
  const insideWorkspace = probe.resolved.startsWith(
    `${resolve(packageRoot, "..", "..")}/`,
  );
  const ok =
    probe.octetLength === 2 &&
    probe.matches === 1 &&
    probe.remaining === 0 &&
    !insideWorkspace;
  Object.assign(row, {
    status: ok ? "pass" : "fail",
    sqliteVersion: probe.sqliteVersion,
    installedOutsideWorkspace: !insideWorkspace,
  });
} catch (error) {
  row.error = error instanceof Error ? error.message.split("\n")[0] : "error";
} finally {
  await rm(workDir, { force: true, recursive: true });
}
process.stdout.write(`${JSON.stringify(row)}\n`);
process.exit(row.status === "pass" ? 0 : 1);
