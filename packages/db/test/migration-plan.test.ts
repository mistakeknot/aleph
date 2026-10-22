import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { materializeLegacyCompatibleFolder } from "../src/legacy-compat-folder.js";
import { legacyMigrationChain } from "../src/legacy-migration-chain.js";
import {
  buildMigrationPlan,
  loadMigrationPlan,
  loadMigrationPlanInput,
  MigrationPlanError,
  type AlephStepSource,
  type MigrationPlanInput,
  type UpstreamStepSource,
} from "../src/migration-plan.js";
import {
  applyFolder,
  legacyDrizzleFolder,
  materializeLegacyOracle,
  upstreamDrizzleFolder,
} from "./helpers/legacy-oracle.js";
import {
  describeSchema,
  describeSequences,
} from "./helpers/migration-equality.js";
import { applyPlan, sourceFolders } from "./helpers/plan-apply.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function upstream(...tags: string[]): UpstreamStepSource[] {
  return tags.map((tag, index) => ({
    tag,
    when: 1000 + index,
    sha256: `hash-${tag}`,
  }));
}

function aleph(
  id: string,
  after: string,
  extra: Partial<AlephStepSource> = {},
): AlephStepSource {
  return {
    id,
    file: `${id}.sql`,
    after,
    when: 5000,
    sha256: `hash-${id}`,
    ...extra,
  };
}

function ids(input: MigrationPlanInput): string[] {
  return buildMigrationPlan(input).steps.map((step) => step.id);
}

describe("buildMigrationPlan", () => {
  it("places Aleph steps after their anchors", () => {
    expect(
      ids({
        upstream: upstream("u1", "u2", "u3"),
        aleph: [aleph("A0001", "u1"), aleph("A0002", "A0001")],
      }),
    ).toEqual(["u1", "A0001", "A0002", "u2", "u3"]);
  });

  it("replaces a superseded upstream step in place and records it", () => {
    const plan = buildMigrationPlan({
      upstream: upstream("u1", "u2", "u3"),
      aleph: [aleph("A0001", "u1", { supersedes: "u2" })],
    });
    expect(plan.steps.map((step) => step.id)).toEqual(["u1", "A0001", "u3"]);
    expect(plan.superseded).toMatchObject([
      { id: "u2", supersededBy: "A0001" },
    ]);
  });

  it("places a later Aleph step after the one that supersedes", () => {
    expect(
      ids({
        upstream: upstream("u1", "u2", "u3"),
        aleph: [
          aleph("A0001", "u1", { supersedes: "u2" }),
          aleph("A0002", "A0001"),
        ],
      }),
    ).toEqual(["u1", "A0001", "A0002", "u3"]);
  });

  it("lets a later replacement follow an earlier one", () => {
    expect(
      ids({
        upstream: upstream("u1", "u2", "u3", "u4"),
        aleph: [
          aleph("A0001", "u1", { supersedes: "u2" }),
          aleph("A0002", "A0001", { supersedes: "u3" }),
        ],
      }),
    ).toEqual(["u1", "A0001", "A0002", "u4"]);
  });

  it("refuses an unknown after target", () => {
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1"),
        aleph: [aleph("A0001", "u9")],
      }),
    ).toThrow(/unknown after target u9/);
  });

  it("refuses an unknown supersedes target", () => {
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1"),
        aleph: [aleph("A0001", "u1", { supersedes: "u9" })],
      }),
    ).toThrow(/unknown supersedes target u9/);
  });

  it("refuses a cycle", () => {
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1"),
        aleph: [aleph("A0001", "A0002"), aleph("A0002", "A0001")],
      }),
    ).toThrow(MigrationPlanError);
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1"),
        aleph: [aleph("A0001", "A0002"), aleph("A0002", "A0001")],
      }),
    ).toThrow(/cycle/);
  });

  it("refuses Aleph steps declared out of order", () => {
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1"),
        aleph: [aleph("A0002", "u1"), aleph("A0001", "A0002")],
      }),
    ).toThrow(/out of order/);
  });

  it("refuses an Aleph step anchored on a later Aleph step", () => {
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1"),
        aleph: [aleph("A0001", "A0002"), aleph("A0002", "u1")],
      }),
    ).toThrow(/does not come before it/);
  });

  it("refuses two steps with the same anchor", () => {
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1", "u2"),
        aleph: [aleph("A0001", "u1"), aleph("A0002", "u1")],
      }),
    ).toThrow(/both declare after u1/);
  });

  it("refuses an anchor on a superseded step", () => {
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1", "u2", "u3"),
        aleph: [
          aleph("A0001", "u1", { supersedes: "u2" }),
          aleph("A0002", "u2"),
        ],
      }),
    ).toThrow(/superseded and never runs/);
  });

  it("refuses a replacement that does not take the superseded position", () => {
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1", "u2", "u3"),
        aleph: [
          aleph("A0001", "u1"),
          aleph("A0002", "u3", { supersedes: "u2" }),
        ],
      }),
    ).toThrow(/does not take its position/);
  });

  it("refuses two replacements for one step", () => {
    expect(() =>
      buildMigrationPlan({
        upstream: upstream("u1", "u2"),
        aleph: [
          aleph("A0001", "u1", { supersedes: "u2" }),
          aleph("A0002", "A0001", { supersedes: "u2" }),
        ],
      }),
    ).toThrow(/superseded by both/);
  });
});

describe("the real migration plan", () => {
  beforeAll(() => {
    materializeLegacyOracle();
  });

  it("keeps drizzle/ byte-identical to the upstream tag", () => {
    const digestTree = (folder: string): Record<string, string> => {
      const tree: Record<string, string> = {};
      for (const entry of readdirSync(folder, {
        recursive: true,
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        const path = join(entry.parentPath, entry.name);
        tree[path.slice(folder.length)] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
      return tree;
    };
    expect(digestTree(sourceFolders.upstreamFolder)).toEqual(
      digestTree(upstreamDrizzleFolder),
    );
  });

  it("orders upstream and Aleph steps exactly as the legacy chain", () => {
    const plan = loadMigrationPlan(sourceFolders);
    expect(
      plan.steps.map((step) => ({ namespace: step.namespace, id: step.id })),
    ).toEqual(
      legacyMigrationChain.map((entry) => ({
        namespace: entry.target.namespace,
        id: entry.target.id,
      })),
    );
    expect(plan.superseded.map((step) => step.id)).toEqual([
      "0143_queued_message_state",
    ]);
  });

  it("keeps the compatibility log equal to the legacy log", () => {
    const folder = materializeLegacyCompatibleFolder(sourceFolders);
    const compatible = JSON.parse(
      readFileSync(join(folder, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string; when: number }> };
    const legacy = JSON.parse(
      readFileSync(join(legacyDrizzleFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: Array<{ tag: string; when: number }> };
    expect(compatible.entries.map(({ tag, when }) => ({ tag, when }))).toEqual(
      legacy.entries.map(({ tag, when }) => ({ tag, when })),
    );
    for (const entry of legacy.entries) {
      expect(readFileSync(join(folder, `${entry.tag}.sql`))).toEqual(
        readFileSync(join(legacyDrizzleFolder, `${entry.tag}.sql`)),
      );
    }
  });

  it("builds the same fresh schema as the legacy chain", () => {
    const legacy = new Database(":memory:");
    const planned = applyPlan();
    try {
      applyFolder(legacy, legacyDrizzleFolder);
      expect(describeSchema(planned)).toEqual(describeSchema(legacy));
      expect(describeSequences(planned)).toEqual(describeSequences(legacy));
    } finally {
      legacy.close();
      planned.close();
    }
  });

  it("reads each source file's hash into the plan", () => {
    const input = loadMigrationPlanInput(sourceFolders);
    expect(input.upstream).toHaveLength(144);
    expect(input.aleph).toHaveLength(9);
    const plan = loadMigrationPlan(sourceFolders);
    for (const step of plan.steps) {
      const legacy = legacyMigrationChain.find(
        (entry) => entry.target.id === step.id,
      );
      expect(step.sha256).toBe(legacy?.sha256);
    }
  });

  it("fails on every load when a frozen pin no longer matches", () => {
    const alephFolder = mkdtempSync(join(tmpdir(), "bb-plan-pin-"));
    tempDirs.push(alephFolder);
    cpSync(sourceFolders.alephFolder, alephFolder, { recursive: true });
    const frozenPath = join(alephFolder, "frozen-upstream.json");
    const frozen = JSON.parse(readFileSync(frozenPath, "utf8")) as {
      steps: Array<{ tag: string; sha256: string }>;
    };
    const superseded = frozen.steps.find(
      (step) => step.tag === "0143_queued_message_state",
    );
    if (superseded === undefined) throw new Error("0143 is not frozen");
    superseded.sha256 = `${superseded.sha256.slice(0, -1)}0`;
    writeFileSync(frozenPath, JSON.stringify(frozen));
    const folders = {
      upstreamFolder: sourceFolders.upstreamFolder,
      alephFolder,
    };
    expect(() => loadMigrationPlan(folders)).toThrow(
      /0143_queued_message_state changed/,
    );
    expect(() => materializeLegacyCompatibleFolder(folders)).toThrow(
      /0143_queued_message_state changed/,
    );
  });

  it("refuses to materialize a plan that drifts from the mapping table", () => {
    const alephFolder = mkdtempSync(join(tmpdir(), "bb-plan-drift-"));
    tempDirs.push(alephFolder);
    cpSync(sourceFolders.alephFolder, alephFolder, { recursive: true });
    const manifestPath = join(alephFolder, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      steps: Array<{ id: string; after: string }>;
    };
    const a4 = manifest.steps.find((step) => step.id === "A0004");
    if (a4 === undefined) throw new Error("A0004 is missing from the manifest");
    a4.after = "0138_thread_pruning_work";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() =>
      materializeLegacyCompatibleFolder({
        upstreamFolder: sourceFolders.upstreamFolder,
        alephFolder,
      }),
    ).toThrow();
  });
});
