import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimQueuedThreadMessage,
  createConnection,
  createProject,
  createQueuedThreadMessage,
  createThread,
  getDowngradeReadiness,
  migrate,
  noopNotifier,
  retireQueuedThreadMessages,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../../scripts/ex88-unretire.ts");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function seededDatabase(): { path: string; db: DbConnection } {
  const directory = mkdtempSync(join(tmpdir(), "ex88-unretire-"));
  directories.push(directory);
  const path = join(directory, "bb.db");
  const db = createConnection(path);
  migrate(db);
  const host = upsertHost(db, noopNotifier, { name: "script-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "script-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/script" },
  });
  const source = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const target = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const row = createQueuedThreadMessage(db, noopNotifier, {
    threadId: source.id,
    content: [{ type: "text", text: "held", mentions: [] }],
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: null,
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
  });
  claimQueuedThreadMessage(db, noopNotifier, row.id);
  const outcome = retireQueuedThreadMessages(db, {
    projectId: project.id,
    sourceThreadId: source.id,
    targetThreadId: target.id,
    operationKey: "script-retire",
    retireEnabled: true,
    resolveWaitingOn: () => ({ kind: "thread-busy" }),
  });
  expect(outcome.kind).toBe("retired");
  return { path, db };
}

function run(path: string, ...flags: string[]) {
  return runWithEnv(
    path,
    { ALEPH_TRANSFER_RETIRE: "off" },
    ...(flags.includes("--check") ? flags : ["--assume-stopped", ...flags]),
  );
}

function runWithEnv(
  path: string,
  env: Record<string, string>,
  ...flags: string[]
) {
  const base = { ...process.env };
  delete base.ALEPH_TRANSFER_RETIRE;
  return spawnSync(
    process.execPath,
    ["--conditions=source", "--import", "tsx", SCRIPT, "--db", path, ...flags],
    { encoding: "utf8", env: { ...base, ...env } },
  );
}

describe("ex88-unretire script", () => {
  it("--check reports counts and changes nothing, exiting non-zero while not ready", () => {
    const { path, db } = seededDatabase();
    const before = getDowngradeReadiness(db);
    db.$client.close();
    const result = run(path, "--check");
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({
      mode: "check",
      redirectsToAbort: 1,
      aborted: 0,
      ready: false,
    });
    expect(report.before.slots).toBe(before.slots);
    const reopened = createConnection(path);
    expect(getDowngradeReadiness(reopened)).toEqual(before);
    reopened.$client.close();
  });

  it("treats a database without the retirement schema as already downgrade-ready", () => {
    const directory = mkdtempSync(join(tmpdir(), "ex88-unretire-"));
    directories.push(directory);
    const path = join(directory, "bb.db");
    const legacy = createConnection(path);
    legacy.$client.exec("CREATE TABLE queued_thread_messages (id TEXT)");
    legacy.$client.close();
    for (const flags of [["--check"], []]) {
      const result = run(path, ...flags);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaPresent: false,
        ready: true,
      });
    }
  });

  it("releases worker claims, aborts every redirect and reports the remaining blockers", () => {
    const { path, db } = seededDatabase();
    db.$client.exec("UPDATE transfer_events SET emitted_at = 1");
    db.$client.close();
    const result = run(path);
    const report = JSON.parse(result.stdout);
    expect(report.mode).toBe("apply");
    expect(report.workerClaimsReleased).toBe(1);
    expect(report.aborted).toBe(1);
    expect(report.refusals).toEqual([]);
    expect(report.after).toMatchObject({ slots: 0, redirects: 0 });
    const reopened = createConnection(path);
    expect(getDowngradeReadiness(reopened)).toMatchObject({
      slots: 0,
      redirects: 0,
    });
    reopened.$client.close();
  });

  it("refuses to apply while the kill switch is not off and changes nothing", () => {
    const { path, db } = seededDatabase();
    const before = getDowngradeReadiness(db);
    db.$client.close();
    const result = runWithEnv(path, {}, "--assume-stopped");
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      stoppedBefore: "kill_switch",
      killSwitchOff: false,
      aborted: 0,
      workerClaimsReleased: null,
    });
    const reopened = createConnection(path);
    expect(getDowngradeReadiness(reopened)).toEqual(before);
    reopened.$client.close();
  });

  it("refuses to apply while another process holds the database open", () => {
    const { path, db } = seededDatabase();
    const before = getDowngradeReadiness(db);
    const result = run(path);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.stoppedBefore).toBe("quiesce");
    expect(report.quiesce.holders).toContain(process.pid);
    expect(report.aborted).toBe(0);
    expect(getDowngradeReadiness(db)).toEqual(before);
    db.$client.exec("UPDATE transfer_events SET emitted_at = 1");
    db.$client.close();
    const stopped = run(path);
    expect(JSON.parse(stopped.stdout).stoppedBefore).toBeNull();
  });

  it("refuses when events are still undelivered before it starts", () => {
    const { path, db } = seededDatabase();
    expect(getDowngradeReadiness(db).unemittedEvents).toBeGreaterThan(0);
    db.$client.close();
    const result = run(path);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      stoppedBefore: "undrained_events",
      aborted: 0,
    });
  });

  it("stamps the events its own aborts create, acks the aborted receipts and ends downgrade-ready", () => {
    const { path, db } = seededDatabase();
    db.$client.exec("UPDATE transfer_events SET emitted_at = 1");
    db.$client.close();
    const result = run(path);
    const report = JSON.parse(result.stdout);
    expect(result.status).toBe(0);
    expect(report).toMatchObject({
      aborted: 1,
      receiptsReconciled: 2,
      stoppedBefore: null,
      ready: true,
    });
    expect(report.eventsStampedOffline).toBeGreaterThan(0);
    const reopened = createConnection(path);
    expect(getDowngradeReadiness(reopened)).toMatchObject({
      slots: 0,
      pendingEntries: 0,
      unemittedEvents: 0,
      redirects: 0,
      nullOrigins: 0,
      unackedReceipts: 0,
      ready: true,
    });
    reopened.$client.close();
  });
});
