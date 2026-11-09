export type HullNameDesignations = Readonly<Record<string, string>>;

export function normalizeHullName(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function hullTitlePrefix(title: string): string | null {
  const index = title.indexOf(" | ");
  if (index < 0) return null;
  const prefix = title.slice(0, index).trim();
  return prefix.length > 0 ? prefix : null;
}

function own(
  record: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function resolveHullDesignation({
  threadId,
  projectId,
  title,
  designations,
  names,
}: {
  threadId: string;
  projectId: string;
  title: string;
  designations: Readonly<Record<string, string>>;
  names: HullNameDesignations;
}): string | undefined {
  const byThread = own(designations, threadId);
  if (byThread !== undefined) return byThread;
  const prefix = hullTitlePrefix(title);
  if (prefix !== null) {
    const normalized = normalizeHullName(prefix);
    if (normalized.length > 0) {
      const byName = own(names, normalized);
      if (byName !== undefined) return byName;
    }
  }
  return own(designations, projectId);
}
