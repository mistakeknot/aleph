import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { cpus, homedir, loadavg, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, "..", "..");

export const SEED_VERSION = "perf-seed-v2";

export function perfHome() {
  return process.env.BB_PERF_DIR ?? join(homedir(), ".cache", "bb-perf");
}

export function perfTmp() {
  const dir = process.env.BB_PERF_TMP ?? join(perfHome(), "tmp");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

export async function startServer({ dataDir, tmpDir = perfTmp(), label }) {
  const serverPort = await freePort();
  const daemonPort = await freePort();
  const log = join(perfTmp(), `server-${label}-${serverPort}.log`);
  const logFd = openSync(log, "a");
  const startedAt = performance.now();
  const child = spawn(
    process.execPath,
    [
      "--conditions=source",
      "--import",
      "tsx",
      resolve(scriptDir, "start-app.mjs"),
    ],
    {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        BB_DATA_DIR: dataDir,
        BB_SERVER_PORT: String(serverPort),
        BB_HOST_DAEMON_PORT: String(daemonPort),
        BB_INHERITED_SKILLS_ROOTS: "",
        BB_TELEMETRY: "false",
        NODE_ENV: "production",
        TMPDIR: tmpDir,
      },
    },
  );
  const baseUrl = `http://127.0.0.1:${serverPort}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early; see ${log}`);
    }
    if (Date.now() > deadline) {
      stopGroup(child);
      throw new Error(`server not ready within 120s; see ${log}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/v1/system/version`);
      if (response.ok) break;
    } catch {}
    await delay(200);
  }
  return {
    baseUrl,
    log,
    pid: child.pid,
    readyMs: performance.now() - startedAt,
    async stop() {
      const exited = new Promise((resolveExit) =>
        child.once("exit", resolveExit),
      );
      stopGroup(child, "SIGTERM");
      const timeout = delay(8_000).then(() => "timeout");
      if ((await Promise.race([exited, timeout])) === "timeout") {
        stopGroup(child, "SIGKILL");
        await exited;
      }
      await delay(200);
    },
  };
}

function stopGroup(child, signal = "SIGKILL") {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {}
  }
}

function seedCommand(args) {
  execFileSync(
    "pnpm",
    ["seed:perf", "--", ...args],
    { cwd: repoRoot, stdio: "inherit", env: { ...process.env, TMPDIR: perfTmp() } },
  );
}

function openDb(dataDir, readOnly) {
  return new DatabaseSync(join(dataDir, "bb.db"), { readOnly });
}

export function readSeedMeta(dataDir) {
  const db = openDb(dataDir, true);
  try {
    const threadEvents = db
      .prepare(
        `SELECT t.id AS id, t.project_id AS projectId,
                (SELECT COUNT(*) FROM events e WHERE e.thread_id = t.id) AS events
         FROM threads t
         WHERE t.archived_at IS NULL AND t.deleted_at IS NULL
         ORDER BY events DESC, t.id`,
      )
      .all();
    const large = threadEvents[0];
    const small = threadEvents
      .filter((row) => row.events >= 20 && row.events <= 250)
      .slice(0, 12);
    const medium = threadEvents
      .filter((row) => row.events >= 900 && row.events < large.events)
      .slice(0, 3);
    const phraseCounts = new Map();
    for (const { title } of db
      .prepare("SELECT title FROM threads WHERE title IS NOT NULL")
      .all()) {
      const words = title.replace(/\s+\d+$/u, "").toLowerCase().split(/\s+/u);
      if (words.length < 3) continue;
      const phrase = words.slice(-2).join(" ");
      phraseCounts.set(phrase, (phraseCounts.get(phrase) ?? 0) + 1);
    }
    const queries = [...phraseCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([phrase]) => phrase);
    return {
      version: SEED_VERSION,
      large,
      medium,
      small,
      queries,
      counts: {
        threads: db.prepare("SELECT COUNT(*) AS n FROM threads").get().n,
        unarchivedThreads: threadEvents.length,
        events: db.prepare("SELECT COUNT(*) AS n FROM events").get().n,
      },
    };
  } finally {
    db.close();
  }
}

export async function ensureSeed({ rebuild = false } = {}) {
  const seedDir = join(perfHome(), "seed");
  const marker = join(seedDir, ".ready.json");
  if (!rebuild && existsSync(marker)) {
    const meta = JSON.parse(readFileSync(marker, "utf8"));
    if (meta.version === SEED_VERSION) return { seedDir, meta };
  }
  rmSync(seedDir, { recursive: true, force: true });
  mkdirSync(seedDir, { recursive: true });
  process.stderr.write("perf: bootstrapping data dir\n");
  const boot = await startServer({ dataDir: seedDir, label: "bootstrap" });
  const hostIdPath = join(seedDir, "host-id");
  const deadline = Date.now() + 60_000;
  while (!existsSync(hostIdPath)) {
    if (Date.now() > deadline) {
      await boot.stop();
      throw new Error("bootstrap did not create host-id");
    }
    await delay(200);
  }
  await boot.stop();
  process.stderr.write("perf: seeding default fixture\n");
  seedCommand(["--data-dir", seedDir, "--seed", "1"]);
  process.stderr.write("perf: seeding large thread\n");
  seedCommand([
    "--data-dir",
    seedDir,
    "--projects",
    "1",
    "--threads",
    "1",
    "--events",
    "9000",
    "--seed",
    "2",
  ]);
  const db = openDb(seedDir, false);
  try {
    db.exec(`
      UPDATE threads SET archived_at = NULL
        WHERE id = (
          SELECT thread_id FROM events GROUP BY thread_id
          ORDER BY COUNT(*) DESC LIMIT 1
        );
      UPDATE environments SET teardown_status = 'removed'
        WHERE status = 'destroyed' AND teardown_status IS NOT 'removed';
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
  } finally {
    db.close();
  }
  const meta = readSeedMeta(seedDir);
  writeFileSync(marker, JSON.stringify(meta, null, 2));
  return { seedDir, meta };
}

export function cloneSeed(seedDir, label) {
  const dataDir = join(perfTmp(), `data-${label}-${process.pid}`);
  rmSync(dataDir, { recursive: true, force: true });
  cpSync(seedDir, dataDir, { recursive: true });
  return dataDir;
}

export function machineInfo() {
  const cpu = cpus();
  const safe = (command, args) => {
    try {
      return execFileSync(command, args, { encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  return {
    cpu: cpu[0]?.model ?? "unknown",
    logicalCores: cpu.length,
    memGb: Math.round(totalmem() / 2 ** 30),
    loadAvg: loadavg().map((value) => Math.round(value * 100) / 100),
    node: process.version,
    os: `${process.platform} ${safe("uname", ["-r"]) ?? ""}`.trim(),
    chrome: safe(
      process.env.BB_PERF_CHROME ?? "google-chrome",
      ["--version"],
    ),
  };
}

export function gitInfo() {
  const safe = (args) => {
    try {
      return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
    } catch {
      return null;
    }
  };
  return {
    commit: safe(["rev-parse", "--short", "HEAD"]),
    branch: safe(["rev-parse", "--abbrev-ref", "HEAD"]),
    dirty: (safe(["status", "--porcelain", "--", "apps", "packages"]) ?? "") !== "",
  };
}
