import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, "..", "src", "legacy-migration-chain.ts");
const check = process.argv.includes("--check");

const legacyTipRev = "07c1ec9ed2";
const upstreamRev = "411eac54ac16d0a3cb57d1de8396d37564884a73";
const journalPath = "packages/db/drizzle/meta/_journal.json";

const releases = [
  { name: "aleph.1", rev: "7a3f937afe" },
  { name: "aleph.2", rev: "62f935d8ff" },
  { name: "aleph.3", rev: "26462bd50e" },
  { name: "aleph.4", rev: "62dac47e70" },
  { name: "0.4.1", rev: "c51230bc3a" },
  { name: "0.4.2", rev: "8708b7321b" },
  { name: "0.5.0", rev: "f4010fd2ff" },
  { name: "0.5.1", rev: "f903a0c32f" },
  { name: "0.5.2", rev: "62002e96b2" },
  { name: "0.5.3", rev: "6da364408f" },
  { name: "0.6.0", rev: "e0a99814e9" },
  { name: "0.6.1", rev: "bc860996a6" },
  { name: "0.6.2", rev: "3b0ca1cfd3" },
  { name: "0.6.3", rev: "d5cd7d9f2e" },
  { name: "main-0.6.4", rev: "29736aaba5" },
  { name: "0.7.0", rev: "07c1ec9ed2" },
];

const alephOnly = new Map([
  [132, "A0001"],
  [133, "A0002"],
  [134, "A0003"],
  [141, "A0004"],
  [142, "A0005"],
  [143, "A0006"],
  [144, "A0007"],
  [145, "A0008"],
]);
const superseding = new Map([
  [151, { id: "A0009", supersedes: "0143_queued_message_state" }],
]);

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function fullRev(rev) {
  return git("rev-parse", "--verify", `${rev}^{commit}`).trim();
}

function chainAt(rev) {
  const journal = JSON.parse(git("show", `${rev}:${journalPath}`));
  return journal.entries.map((entry) => ({
    idx: entry.idx,
    tag: entry.tag,
    when: entry.when,
    sha256: createHash("sha256")
      .update(git("show", `${rev}:packages/db/drizzle/${entry.tag}.sql`))
      .digest("hex"),
  }));
}

const legacy = chainAt(legacyTipRev);
const upstream = chainAt(upstreamRev);
const upstreamBySha = new Map(upstream.map((entry) => [entry.sha256, entry]));

const entries = legacy.map((entry) => {
  const twin = upstreamBySha.get(entry.sha256);
  if (alephOnly.has(entry.idx)) {
    if (twin)
      throw new Error(
        `${entry.tag} expected aleph-only but matches upstream ${twin.tag}`,
      );
    return {
      ...entry,
      relation: "aleph-only",
      target: { namespace: "aleph", id: alephOnly.get(entry.idx) },
    };
  }
  if (superseding.has(entry.idx)) {
    if (twin)
      throw new Error(
        `${entry.tag} expected superseding but matches upstream ${twin.tag}`,
      );
    const { id, supersedes } = superseding.get(entry.idx);
    return {
      ...entry,
      relation: "aleph-supersedes",
      target: { namespace: "aleph", id },
      supersedes,
    };
  }
  if (!twin)
    throw new Error(
      `${entry.tag} has no upstream twin and is not declared Aleph-only`,
    );
  const identical =
    twin.idx === entry.idx &&
    twin.tag === entry.tag &&
    twin.when === entry.when;
  return {
    ...entry,
    relation: identical ? "identical" : "upstream-twin",
    target: { namespace: "upstream", id: twin.tag },
    upstreamWhen: twin.when,
  };
});

const matchedUpstream = new Set(
  entries
    .filter((entry) => entry.target.namespace === "upstream")
    .map((entry) => entry.target.id),
);
const unmatchedUpstream = upstream
  .filter((entry) => !matchedUpstream.has(entry.tag))
  .map((entry) => entry.tag);
const expectedUnmatched = ["0143_queued_message_state"];
if (JSON.stringify(unmatchedUpstream) !== JSON.stringify(expectedUnmatched)) {
  throw new Error(
    `unexpected unmatched upstream steps: ${unmatchedUpstream.join(", ")}`,
  );
}

const states = new Map();
const releaseRows = releases.map((release) => {
  const chain = chainAt(release.rev);
  chain.forEach((entry, index) => {
    const legacyEntry = legacy[index];
    if (
      !legacyEntry ||
      legacyEntry.tag !== entry.tag ||
      legacyEntry.when !== entry.when ||
      legacyEntry.sha256 !== entry.sha256
    ) {
      throw new Error(
        `${release.name}: entry ${index} (${entry.tag}) is not a prefix of the legacy chain`,
      );
    }
  });
  const tail = chain[chain.length - 1];
  states.set(chain.length, tail.tag);
  return {
    name: release.name,
    commit: fullRev(release.rev),
    length: chain.length,
    tail: tail.tag,
  };
});

const lines = [];
lines.push("export type LegacyMigrationRelation =");
lines.push('  | "identical"');
lines.push('  | "upstream-twin"');
lines.push('  | "aleph-only"');
lines.push('  | "aleph-supersedes";');
lines.push("");
lines.push("export interface LegacyMigrationTarget {");
lines.push('  namespace: "upstream" | "aleph";');
lines.push("  id: string;");
lines.push("}");
lines.push("");
lines.push("export interface LegacyMigrationChainEntry {");
lines.push("  idx: number;");
lines.push("  tag: string;");
lines.push("  when: number;");
lines.push("  sha256: string;");
lines.push("  relation: LegacyMigrationRelation;");
lines.push("  target: LegacyMigrationTarget;");
lines.push("  upstreamWhen?: number;");
lines.push("  supersedes?: string;");
lines.push("}");
lines.push("");
lines.push("export interface LegacyMigrationRelease {");
lines.push("  name: string;");
lines.push("  commit: string;");
lines.push("  length: number;");
lines.push("  tail: string;");
lines.push("}");
lines.push("");
lines.push(
  `export const legacyUpstreamCommit = ${JSON.stringify(upstreamRev)};`,
);
lines.push("");
lines.push(
  "export const legacyMigrationChain: readonly LegacyMigrationChainEntry[] = [",
);
for (const entry of entries) {
  lines.push("  {");
  lines.push(`    idx: ${entry.idx},`);
  lines.push(`    tag: ${JSON.stringify(entry.tag)},`);
  lines.push(`    when: ${entry.when},`);
  lines.push(`    sha256: ${JSON.stringify(entry.sha256)},`);
  lines.push(`    relation: ${JSON.stringify(entry.relation)},`);
  lines.push("    target: {");
  lines.push(`      namespace: ${JSON.stringify(entry.target.namespace)},`);
  lines.push(`      id: ${JSON.stringify(entry.target.id)},`);
  lines.push("    },");
  if (entry.upstreamWhen !== undefined && entry.upstreamWhen !== entry.when) {
    lines.push(`    upstreamWhen: ${entry.upstreamWhen},`);
  }
  if (entry.supersedes)
    lines.push(`    supersedes: ${JSON.stringify(entry.supersedes)},`);
  lines.push("  },");
}
lines.push("];");
lines.push("");
lines.push(
  "export const legacyMigrationReleases: readonly LegacyMigrationRelease[] = [",
);
for (const row of releaseRows) {
  lines.push("  {");
  lines.push(`    name: ${JSON.stringify(row.name)},`);
  lines.push(`    commit: ${JSON.stringify(row.commit)},`);
  lines.push(`    length: ${row.length},`);
  lines.push(`    tail: ${JSON.stringify(row.tail)},`);
  lines.push("  },");
}
lines.push("];");
lines.push("");
const output = lines.join("\n");

if (check) {
  const current = execFileSync("cat", [outputPath], { encoding: "utf8" });
  if (current !== output) {
    console.error("legacy-migration-chain.ts is out of date");
    process.exit(1);
  }
} else {
  writeFileSync(outputPath, output);
  console.log(
    `wrote ${entries.length} entries and ${releaseRows.length} releases`,
  );
}
