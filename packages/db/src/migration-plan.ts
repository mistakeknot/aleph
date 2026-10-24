import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyFrozenSet } from "./migration-guard.js";

export type MigrationNamespace = "upstream" | "aleph";

export interface UpstreamStepSource {
  tag: string;
  when: number;
  sha256: string;
}

export interface AlephStepSource {
  id: string;
  file: string;
  after: string;
  when: number;
  sha256: string;
  supersedes?: string;
}

export interface MigrationPlanInput {
  upstream: readonly UpstreamStepSource[];
  aleph: readonly AlephStepSource[];
}

export interface MigrationPlanStep {
  namespace: MigrationNamespace;
  id: string;
  file: string;
  when: number;
  sha256: string;
  supersedes?: string;
}

export interface SupersededMigrationStep {
  namespace: "upstream";
  id: string;
  file: string;
  when: number;
  sha256: string;
  supersededBy: string;
}

export interface MigrationPlan {
  steps: readonly MigrationPlanStep[];
  superseded: readonly SupersededMigrationStep[];
}

export interface MigrationPlanFolders {
  upstreamFolder: string;
  alephFolder: string;
}

export class MigrationPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationPlanError";
  }
}

const ALEPH_ID_PATTERN = /^A(\d{4})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new MigrationPlanError(`Expected a non-empty string for "${key}"`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new MigrationPlanError(`Expected an integer for "${key}"`);
  }
  return value;
}

function requireEntries(raw: unknown, label: string): unknown[] {
  if (!isRecord(raw)) {
    throw new MigrationPlanError(`Unexpected ${label} shape`);
  }
  const list = raw[label === "journal" ? "entries" : "steps"];
  if (!Array.isArray(list)) {
    throw new MigrationPlanError(`Unexpected ${label} shape`);
  }
  return list;
}

export interface ParsedUpstreamJournalEntry {
  tag: string;
  when: number;
}

export function parseUpstreamJournal(
  raw: unknown,
): ParsedUpstreamJournalEntry[] {
  return requireEntries(raw, "journal").map((entry) => {
    if (!isRecord(entry)) {
      throw new MigrationPlanError("Unexpected journal entry shape");
    }
    return {
      tag: requireString(entry, "tag"),
      when: requireNumber(entry, "when"),
    };
  });
}

export interface ParsedAlephManifestStep {
  id: string;
  file: string;
  after: string;
  when: number;
  supersedes?: string;
}

export function parseAlephManifest(raw: unknown): ParsedAlephManifestStep[] {
  return requireEntries(raw, "manifest").map((entry) => {
    if (!isRecord(entry)) {
      throw new MigrationPlanError("Unexpected manifest entry shape");
    }
    const step: ParsedAlephManifestStep = {
      id: requireString(entry, "id"),
      file: requireString(entry, "file"),
      after: requireString(entry, "after"),
      when: requireNumber(entry, "when"),
    };
    if (entry.supersedes !== undefined) {
      step.supersedes = requireString(entry, "supersedes");
    }
    return step;
  });
}

export interface FrozenUpstreamStep {
  tag: string;
  sha256: string;
  supersededBy?: string;
}

export function parseFrozenUpstream(raw: unknown): FrozenUpstreamStep[] {
  return requireEntries(raw, "frozen set").map((entry) => {
    if (!isRecord(entry)) {
      throw new MigrationPlanError("Unexpected frozen set entry shape");
    }
    const step: FrozenUpstreamStep = {
      tag: requireString(entry, "tag"),
      sha256: requireString(entry, "sha256"),
    };
    if (entry.supersededBy !== undefined) {
      step.supersededBy = requireString(entry, "supersededBy");
    }
    return step;
  });
}

export function parseAlephAlteredTables(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.tables)) {
    throw new MigrationPlanError("Unexpected altered tables shape");
  }
  return raw.tables.map((table) => {
    if (typeof table !== "string" || table.length === 0) {
      throw new MigrationPlanError("Unexpected altered tables entry");
    }
    return table;
  });
}

function findCycle(aleph: readonly AlephStepSource[]): string | undefined {
  const byId = new Map(aleph.map((step) => [step.id, step]));
  for (const start of aleph) {
    const seen = new Set<string>([start.id]);
    let current = byId.get(start.after);
    while (current !== undefined) {
      if (seen.has(current.id)) {
        return `${start.id} -> ${[...seen].join(" -> ")} -> ${current.id}`;
      }
      seen.add(current.id);
      current = byId.get(current.after);
    }
  }
  return undefined;
}

function validateAlephIds(aleph: readonly AlephStepSource[]): void {
  for (const [index, step] of aleph.entries()) {
    const match = ALEPH_ID_PATTERN.exec(step.id);
    if (match === null) {
      throw new MigrationPlanError(
        `Aleph step id ${step.id} does not match A0000`,
      );
    }
    if (Number(match[1]) !== index + 1) {
      throw new MigrationPlanError(
        `Aleph steps are out of order: expected A${String(index + 1).padStart(4, "0")} at position ${index + 1} but found ${step.id}`,
      );
    }
  }
}

function validateReferences(
  upstreamTags: ReadonlySet<string>,
  aleph: readonly AlephStepSource[],
): void {
  const alephIds = new Set(aleph.map((step) => step.id));
  const anchors = new Map<string, string>();
  for (const step of aleph) {
    if (!upstreamTags.has(step.after) && !alephIds.has(step.after)) {
      throw new MigrationPlanError(
        `${step.id} declares unknown after target ${step.after}`,
      );
    }
    const previous = anchors.get(step.after);
    if (previous !== undefined) {
      throw new MigrationPlanError(
        `${previous} and ${step.id} both declare after ${step.after}`,
      );
    }
    anchors.set(step.after, step.id);
    if (step.supersedes !== undefined && !upstreamTags.has(step.supersedes)) {
      throw new MigrationPlanError(
        `${step.id} declares unknown supersedes target ${step.supersedes}`,
      );
    }
  }
}

function validateOrder(aleph: readonly AlephStepSource[]): void {
  const cycle = findCycle(aleph);
  if (cycle !== undefined) {
    throw new MigrationPlanError(`Aleph steps form a cycle: ${cycle}`);
  }
  for (const step of aleph) {
    if (ALEPH_ID_PATTERN.test(step.after) && step.after >= step.id) {
      throw new MigrationPlanError(
        `${step.id} is declared after ${step.after}, which does not come before it`,
      );
    }
  }
}

function sqlFile(tag: string): string {
  return `${tag}.sql`;
}

export function buildMigrationPlan(input: MigrationPlanInput): MigrationPlan {
  const upstreamTags = new Set<string>();
  for (const step of input.upstream) {
    if (upstreamTags.has(step.tag)) {
      throw new MigrationPlanError(`Duplicate upstream step ${step.tag}`);
    }
    upstreamTags.add(step.tag);
  }
  validateAlephIds(input.aleph);
  validateReferences(upstreamTags, input.aleph);
  validateOrder(input.aleph);

  const supersededBy = new Map<string, string>();
  for (const step of input.aleph) {
    if (step.supersedes === undefined) continue;
    const existing = supersededBy.get(step.supersedes);
    if (existing !== undefined) {
      throw new MigrationPlanError(
        `${step.supersedes} is superseded by both ${existing} and ${step.id}`,
      );
    }
    supersededBy.set(step.supersedes, step.id);
  }
  for (const step of input.aleph) {
    if (supersededBy.has(step.after)) {
      throw new MigrationPlanError(
        `${step.id} is declared after ${step.after}, which is superseded and never runs`,
      );
    }
  }

  const alephAfter = new Map(input.aleph.map((step) => [step.after, step]));
  const steps: MigrationPlanStep[] = [];
  const superseded: SupersededMigrationStep[] = [];

  const appendChain = (anchor: string): string[] => {
    const appended: string[] = [];
    let next = alephAfter.get(anchor);
    while (next !== undefined) {
      const entry: MigrationPlanStep = {
        namespace: "aleph",
        id: next.id,
        file: next.file,
        when: next.when,
        sha256: next.sha256,
      };
      if (next.supersedes !== undefined) entry.supersedes = next.supersedes;
      steps.push(entry);
      appended.push(next.id);
      next = alephAfter.get(next.id);
    }
    return appended;
  };

  let sinceRunning: string[] = [];
  let taken = new Set<string>();
  const supersedesById = new Map(
    input.aleph.map((step) => [step.id, step.supersedes]),
  );
  for (const step of input.upstream) {
    const replacement = supersededBy.get(step.tag);
    if (replacement !== undefined) {
      const position = sinceRunning.indexOf(replacement);
      if (position === -1) {
        throw new MigrationPlanError(
          `${replacement} supersedes ${step.tag} but does not take its position`,
        );
      }
      const earlier = sinceRunning
        .slice(0, position)
        .find((id) => supersedesById.get(id) !== undefined && !taken.has(id));
      if (earlier !== undefined) {
        throw new MigrationPlanError(
          `${replacement} supersedes ${step.tag} but ${earlier}, which supersedes ${supersedesById.get(earlier)}, comes before it`,
        );
      }
      taken.add(replacement);
      superseded.push({
        namespace: "upstream",
        id: step.tag,
        file: sqlFile(step.tag),
        when: step.when,
        sha256: step.sha256,
        supersededBy: replacement,
      });
    } else {
      steps.push({
        namespace: "upstream",
        id: step.tag,
        file: sqlFile(step.tag),
        when: step.when,
        sha256: step.sha256,
      });
      sinceRunning = [];
      taken = new Set<string>();
    }
    sinceRunning.push(...appendChain(step.tag));
  }

  if (
    steps.filter((step) => step.namespace === "aleph").length !==
    input.aleph.length
  ) {
    throw new MigrationPlanError(
      "Some Aleph steps are not reachable from an upstream step",
    );
  }
  return { steps, superseded };
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function loadMigrationPlanInput(
  folders: MigrationPlanFolders,
): MigrationPlanInput {
  const journal = parseUpstreamJournal(
    JSON.parse(
      readFileSync(
        join(folders.upstreamFolder, "meta", "_journal.json"),
        "utf8",
      ),
    ),
  );
  const manifest = parseAlephManifest(
    JSON.parse(
      readFileSync(join(folders.alephFolder, "manifest.json"), "utf8"),
    ),
  );
  return {
    upstream: journal.map((entry) => ({
      tag: entry.tag,
      when: entry.when,
      sha256: sha256OfFile(join(folders.upstreamFolder, sqlFile(entry.tag))),
    })),
    aleph: manifest.map((entry) => ({
      ...entry,
      sha256: sha256OfFile(join(folders.alephFolder, entry.file)),
    })),
  };
}

export function loadFrozenUpstream(
  folders: MigrationPlanFolders,
): FrozenUpstreamStep[] {
  return parseFrozenUpstream(
    JSON.parse(
      readFileSync(join(folders.alephFolder, "frozen-upstream.json"), "utf8"),
    ),
  );
}

export function loadMigrationPlan(
  folders: MigrationPlanFolders,
): MigrationPlan {
  const input = loadMigrationPlanInput(folders);
  verifyFrozenSet(loadFrozenUpstream(folders), input);
  return buildMigrationPlan(input);
}

export function planStepPath(
  folders: MigrationPlanFolders,
  step: Pick<MigrationPlanStep, "namespace" | "file">,
): string {
  return join(
    step.namespace === "upstream"
      ? folders.upstreamFolder
      : folders.alephFolder,
    step.file,
  );
}
