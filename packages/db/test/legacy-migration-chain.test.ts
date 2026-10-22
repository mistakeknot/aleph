import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  legacyMigrationChain,
  legacyMigrationReleases,
} from "../src/legacy-migration-chain.js";
import { legacyOracleFolder } from "./helpers/plan-apply.js";
import {
  compatibleMigrationHashes,
  publishedMigrationWhens,
} from "../src/migration-history.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = legacyOracleFolder();

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

function readJournal(): JournalEntry[] {
  const raw = fs.readFileSync(
    resolve(drizzleDir, "meta", "_journal.json"),
    "utf-8",
  );
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

function sha256OfStep(tag: string): string {
  return createHash("sha256")
    .update(fs.readFileSync(resolve(drizzleDir, `${tag}.sql`)))
    .digest("hex");
}

describe("legacy migration chain mapping", () => {
  it("matches the on-disk journal and step contents", () => {
    const journal = readJournal();
    expect(legacyMigrationChain).toHaveLength(journal.length);
    for (const [position, entry] of legacyMigrationChain.entries()) {
      const onDisk = journal[position];
      expect(entry.idx).toBe(position);
      expect(entry.tag).toBe(onDisk?.tag);
      expect(entry.when).toBe(onDisk?.when);
      expect(entry.sha256).toBe(sha256OfStep(entry.tag));
    }
  });

  it("maps every step to exactly one target", () => {
    const targets = new Set<string>();
    for (const entry of legacyMigrationChain) {
      const key = `${entry.target.namespace}:${entry.target.id}`;
      expect(targets.has(key), key).toBe(false);
      targets.add(key);
    }
  });

  it("keeps identical steps in the upstream namespace under the same tag", () => {
    for (const entry of legacyMigrationChain) {
      if (entry.relation === "identical") {
        expect(entry.target).toEqual({ namespace: "upstream", id: entry.tag });
        expect(entry.upstreamWhen).toBeUndefined();
      }
    }
  });

  it("puts Aleph-only and superseding steps in the aleph namespace", () => {
    const alephIds = legacyMigrationChain
      .filter((entry) => entry.target.namespace === "aleph")
      .map((entry) => entry.target.id);
    expect(alephIds).toEqual(
      Array.from(
        { length: alephIds.length },
        (_, i) => `A${String(i + 1).padStart(4, "0")}`,
      ),
    );
    for (const entry of legacyMigrationChain) {
      if (entry.relation === "aleph-supersedes") {
        expect(entry.supersedes).toBeDefined();
        expect(entry.target.namespace).toBe("aleph");
      } else {
        expect(entry.supersedes).toBeUndefined();
      }
    }
  });

  it("records every published release as a prefix of the chain", () => {
    for (const release of legacyMigrationReleases) {
      expect(release.length).toBeGreaterThan(0);
      expect(release.length).toBeLessThanOrEqual(legacyMigrationChain.length);
      expect(legacyMigrationChain[release.length - 1]?.tag).toBe(release.tail);
    }
  });

  it("is reproduced by the derivation script from git history", () => {
    execFileSync(
      process.execPath,
      [
        resolve(
          __dirname,
          "..",
          "scripts",
          "derive-legacy-migration-chain.mjs",
        ),
        "--check",
      ],
      { stdio: "pipe" },
    );
  }, 180_000);

  it("pins the supersession of upstream 0143 by A0009 at legacy 0151", () => {
    const entry = legacyMigrationChain[151];
    expect(entry?.tag).toBe("0151_queued_message_state");
    expect(entry?.relation).toBe("aleph-supersedes");
    expect(entry?.target).toEqual({ namespace: "aleph", id: "A0009" });
    expect(entry?.supersedes).toBe("0143_queued_message_state");
    expect(
      legacyMigrationChain.filter(
        (candidate) => candidate.supersedes !== undefined,
      ),
    ).toHaveLength(1);
  });

  it("records the compatible hashes and published whens of the validator", () => {
    const recorded = legacyMigrationChain.flatMap((entry) =>
      entry.compatibleHashes.map((hash) => ({
        tag: entry.tag,
        when: entry.when,
        hash,
      })),
    );
    expect(recorded).toEqual(
      compatibleMigrationHashes.map(({ tag, when, hash }) => ({
        tag,
        when,
        hash,
      })),
    );
    const published = legacyMigrationChain
      .filter((entry) => entry.publishedWhen !== undefined)
      .map((entry) => ({ tag: entry.tag, when: entry.publishedWhen }));
    expect(published).toEqual(
      publishedMigrationWhens.map(({ tag, when }) => ({ tag, when })),
    );
  });

  it("classifies exactly the reordered cleanup migrations", () => {
    expect(
      legacyMigrationChain
        .filter((entry) => entry.reorderedCleanup)
        .map((entry) => entry.tag),
    ).toEqual([
      "0033_drop_cleanup_mode",
      "0034_drop_stop_requested_at",
      "0035_warm_kingpin",
    ]);
  });

  it("keeps all sixteen release rows with the expected distinct prefixes", () => {
    expect(legacyMigrationReleases).toHaveLength(16);
    expect(
      new Set(legacyMigrationReleases.map((release) => release.length)),
    ).toEqual(new Set([131, 134, 135, 141, 146, 152]));
  });
});
