import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  claimThreadRole,
  getThreadRole,
} from "../../src/data/thread-roles.js";
import { makeThread } from "../helpers/thread-roles.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..", "..");
const childScript = join(here, "..", "helpers", "thread-roles-child.ts");
const TIMEOUT = 120_000;
const CONTENDERS = 6;

const tempDirs: string[] = [];
const liveChildren = new Set<ChildProcess>();

afterEach(() => {
  for (const child of liveChildren) child.kill("SIGKILL");
  liveChildren.clear();
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface Outcome {
  ok: boolean;
  code?: string;
  generation?: number;
}

function fixture(threadCount: number) {
  const directory = mkdtempSync(join(tmpdir(), "bb-roles-race-"));
  tempDirs.push(directory);
  const path = join(directory, "bb.db");
  const db = createConnection(path);
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "race-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "race-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/race" },
  });
  const ids = Array.from(
    { length: threadCount },
    () => makeThread(db, project.id).id,
  );
  return { db, directory, ids, path };
}

interface Contender {
  operation: "claim" | "transfer" | "release";
  argument?: string;
  generation?: number;
}

async function race(
  path: string,
  directory: string,
  role: string,
  contenders: Contender[],
): Promise<Outcome[]> {
  const goFile = join(directory, "go");
  const runs = contenders.map((contender) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        childScript,
        path,
        goFile,
        contender.operation,
        role,
        contender.argument ?? "",
        String(contender.generation ?? ""),
      ],
      { cwd: packageDir, stdio: ["ignore", "pipe", "pipe"] },
    );
    liveChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const ready = new Promise<void>((resolveReady) => {
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes("ready\n")) resolveReady();
      });
    });
    const done = new Promise<Outcome>((resolveDone, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        const line = stdout.trim().split("\n").at(-1) ?? "";
        if (code !== 0) reject(new Error(`child exited ${code}: ${stderr}`));
        else resolveDone(JSON.parse(line) as Outcome);
      });
    });
    return { ready, done };
  });
  await Promise.all(runs.map((run) => run.ready));
  writeFileSync(goFile, "go");
  return Promise.all(runs.map((run) => run.done));
}

describe("thread role races across processes", () => {
  it(
    "lets exactly one of many concurrent claims win",
    async () => {
      const { db, directory, ids, path } = fixture(CONTENDERS);
      const outcomes = await race(
        path,
        directory,
        "vizier",
        ids.map((id) => ({ operation: "claim", argument: id })),
      );
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.code === "role_held"),
      ).toHaveLength(CONTENDERS - 1);
      expect(getThreadRole(db, "vizier").generation).toBe(1);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "lets exactly one of many concurrent transfers at one generation win",
    async () => {
      const { db, directory, ids, path } = fixture(CONTENDERS + 1);
      const [holder, ...targets] = ids as [string, ...string[]];
      claimThreadRole(db, {
        updatedByKind: "cli",
        role: "vizier",
        threadId: holder,
      });
      const outcomes = await race(
        path,
        directory,
        "vizier",
        targets.map((id) => ({
          operation: "transfer",
          argument: id,
          generation: 1,
        })),
      );
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(
        outcomes.filter((outcome) => outcome.code === "role_generation_conflict"),
      ).toHaveLength(targets.length - 1);
      const final = getThreadRole(db, "vizier");
      expect(final.generation).toBe(2);
      expect(targets).toContain(final.threadId);
      db.$client.close();
    },
    TIMEOUT,
  );

  it(
    "serializes a release against a transfer at the same generation",
    async () => {
      const { db, directory, ids, path } = fixture(2);
      const [holder, target] = ids as [string, string];
      claimThreadRole(db, {
        updatedByKind: "cli",
        role: "vizier",
        threadId: holder,
      });
      const outcomes = await race(path, directory, "vizier", [
        { operation: "release", generation: 1 },
        { operation: "transfer", argument: target, generation: 1 },
      ]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      const losers = outcomes.filter((outcome) => !outcome.ok);
      expect(losers).toHaveLength(1);
      expect(["role_generation_conflict", "role_not_held"]).toContain(
        losers[0]?.code,
      );
      expect(getThreadRole(db, "vizier").generation).toBe(2);
      db.$client.close();
    },
    TIMEOUT,
  );
});
