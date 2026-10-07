import { alephReleaseVersion } from "./aleph-version.js";

export type AlephMigration = {
  tag: string;
  when: number;
  sha256: string;
};

export type AlephManifestEntry = {
  aleph: string;
  version: string;
  upstreamBase: string;
  migrations: readonly AlephMigration[];
  artifactKeys: readonly string[];
};

export type AlephRevocation = {
  aleph: string;
  reason: string;
  sequence: number;
};

export type AlephUpdateSelection =
  | "up-to-date"
  | "available"
  | "migration-required"
  | "installed-revoked"
  | "not-comparable";

export type AlephUpdateSelectionResult = {
  selection: AlephUpdateSelection;
  target: string | null;
};

export class AlephManifestEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlephManifestEntryError";
  }
}

const RELEASE_PATTERN =
  /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export function parseAlephRelease(
  value: string,
): [number, number, number] | null {
  const match = RELEASE_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareAlephRelease(a: string, b: string): number {
  const left = parseAlephRelease(a);
  const right = parseAlephRelease(b);
  if (left === null || right === null) {
    throw new AlephManifestEntryError(
      `Not a normalized Aleph release: ${left === null ? a : b}`,
    );
  }
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

function validateMigrations(entry: AlephManifestEntry): void {
  for (const migration of entry.migrations) {
    if (
      typeof migration.tag !== "string" ||
      migration.tag === "" ||
      typeof migration.when !== "number" ||
      !Number.isSafeInteger(migration.when) ||
      typeof migration.sha256 !== "string" ||
      !SHA256_PATTERN.test(migration.sha256)
    ) {
      throw new AlephManifestEntryError(
        `Release ${entry.aleph} has a migration without a valid tag, when and sha256.`,
      );
    }
  }
}

function sameMigrations(
  a: readonly AlephMigration[],
  b: readonly AlephMigration[],
): boolean {
  return (
    a.length === b.length &&
    a.every((migration, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        migration.tag === other.tag &&
        migration.when === other.when &&
        migration.sha256 === other.sha256
      );
    })
  );
}

function isConsistent(entry: AlephManifestEntry): boolean {
  if (parseAlephRelease(entry.aleph) === null) {
    return false;
  }
  if (alephReleaseVersion(entry.version) !== entry.aleph) {
    return false;
  }
  return entry.version.startsWith(`${entry.upstreamBase}+`);
}

export function selectAlephUpdate(input: {
  installedVersion: string;
  entries: readonly AlephManifestEntry[];
  revocations: readonly AlephRevocation[];
  artifactKey: string;
}): AlephUpdateSelectionResult {
  const seen = new Set<string>();
  for (const entry of input.entries) {
    if (seen.has(entry.aleph)) {
      throw new AlephManifestEntryError(
        `Duplicate release ${entry.aleph} in manifest.`,
      );
    }
    seen.add(entry.aleph);
    validateMigrations(entry);
  }

  const installedRelease = alephReleaseVersion(input.installedVersion);
  if (
    installedRelease === null ||
    parseAlephRelease(installedRelease) === null
  ) {
    return { selection: "not-comparable", target: null };
  }
  const installedEntry = input.entries.find(
    (entry) => entry.aleph === installedRelease && isConsistent(entry),
  );
  if (installedEntry === undefined) {
    return { selection: "not-comparable", target: null };
  }

  const revoked = new Set(input.revocations.map((entry) => entry.aleph));
  const target = input.entries
    .filter(
      (entry) =>
        isConsistent(entry) &&
        !revoked.has(entry.aleph) &&
        entry.artifactKeys.includes(input.artifactKey) &&
        compareAlephRelease(entry.aleph, installedRelease) > 0,
    )
    .sort((a, b) => compareAlephRelease(b.aleph, a.aleph))[0];

  const installedRevoked = revoked.has(installedRelease);
  if (target === undefined) {
    return {
      selection: installedRevoked ? "installed-revoked" : "up-to-date",
      target: null,
    };
  }
  if (installedRevoked) {
    return { selection: "installed-revoked", target: target.aleph };
  }
  return {
    selection: sameMigrations(installedEntry.migrations, target.migrations)
      ? "available"
      : "migration-required",
    target: target.aleph,
  };
}
