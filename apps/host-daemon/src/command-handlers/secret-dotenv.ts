import { parseEnv } from "node:util";

interface DotenvReconcileResult {
  content: string;
  added: number;
  updated: number;
  unchanged: number;
}

function assignmentPattern(name: string): RegExp {
  return new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=\\s*)(.*)$`, "u");
}

const ANY_ASSIGNMENT_PATTERN =
  /^\s*(?:export\s+)?[\w.-]+(?:\s*=\s*|:\s+)(.*)$/u;

type QuoteCharacter = "'" | '"' | "`";

function hasClosingQuote(value: string, quote: QuoteCharacter): boolean {
  let escaped = false;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return true;
  }
  return false;
}

function assertNoMultilineQuotedAssignments(content: string): void {
  for (const line of content.split(/\r?\n/u)) {
    const value = ANY_ASSIGNMENT_PATTERN.exec(line)?.[1] ?? "";
    const quote = value[0];
    if (
      (quote === "'" || quote === '"' || quote === "`") &&
      !hasClosingQuote(value, quote)
    ) {
      throw new Error(
        "Dotenv files with multiline quoted values cannot be reconciled safely.",
      );
    }
  }
}

export function assertNoDuplicateAssignments(
  content: string,
  names: readonly string[],
): void {
  assertNoMultilineQuotedAssignments(content);
  const lines = content.split(/\r?\n/u);
  for (const name of names) {
    const colonPattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*:\\s`, "u");
    if (lines.some((line) => colonPattern.test(line))) {
      throw new Error(`Dotenv file uses unsupported syntax for ${name}.`);
    }
    const pattern = assignmentPattern(name);
    const count = lines.filter((line) => pattern.test(line)).length;
    if (count > 1) {
      throw new Error(
        `Dotenv file contains duplicate assignments for ${name}.`,
      );
    }
  }
}

const DOTENV_LINE =
  /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/u;

function decodeValue(raw: string): string {
  let value = raw.trim();
  const maybeQuote = value[0];
  value = value.replace(/^(['"`])([\s\S]*)\1$/u, "$2");
  if (maybeQuote === '"') {
    value = value.replace(/\\n/gu, "\n").replace(/\\r/gu, "\r");
  }
  return value;
}

function parseAssignedValue(line: string): string | null {
  const match = DOTENV_LINE.exec(line);
  if (!match) return null;
  return decodeValue(match[2] ?? "");
}

const DOTENV_FILE_LINE =
  /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gmu;

function parseDotenvFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  const normalized = content.replace(/\r\n?/gu, "\n");
  for (const match of normalized.matchAll(DOTENV_FILE_LINE)) {
    const name = match[1];
    if (name === undefined) continue;
    result.set(name, decodeValue(match[2] ?? ""));
  }
  return result;
}

function parseNodeFile(content: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [name, value] of Object.entries(parseEnv(content))) {
    if (value !== undefined) result.set(name, value);
  }
  return result;
}

function assertSameParse(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  values: Readonly<Record<string, string>>,
): void {
  const expected = new Map(before);
  for (const [name, value] of Object.entries(values)) {
    expected.set(name, value);
  }
  let same = expected.size === after.size;
  if (same) {
    for (const [name, value] of expected) {
      if (after.get(name) !== value) {
        same = false;
        break;
      }
    }
  }
  if (!same) {
    throw new Error("Dotenv file cannot be reconciled safely.");
  }
}

function assertReconciledSafely(
  before: string,
  after: string,
  values: Readonly<Record<string, string>>,
): void {
  assertSameParse(parseDotenvFile(before), parseDotenvFile(after), values);
  assertSameParse(parseNodeFile(before), parseNodeFile(after), values);
}

export function assertReconcilable(
  content: string,
  names: readonly string[],
): void {
  const placeholders: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const name of names) placeholders[name] = "probe-value";
  reconcileDotenv(content, placeholders);
}

function nodeParse(line: string): string | undefined {
  return parseEnv(line)["K"];
}

function roundTrips(encoded: string, value: string): boolean {
  const line = `K=${encoded}`;
  if (parseAssignedValue(line) !== value) return false;
  if (nodeParse(line) !== value) return false;
  try {
    assertNoMultilineQuotedAssignments(line);
  } catch {
    return false;
  }
  return true;
}

function encodeValue(value: string): string {
  const candidates = (["'", '"', "`"] as const)
    .filter((quote) => !value.includes(quote))
    .map((quote) => `${quote}${value}${quote}`);
  candidates.push(value);
  for (const candidate of candidates) {
    if (roundTrips(candidate, value)) return candidate;
  }
  throw new Error(
    "A secret value cannot be represented safely in a single dotenv assignment.",
  );
}

function trailingComment(rest: string): string {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < rest.length; index += 1) {
    const character = rest[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = quote === character ? null : (quote ?? character);
      continue;
    }
    if (character !== "#" || quote !== null || index === 0) continue;
    if (!/\s/u.test(rest[index - 1] ?? "")) continue;
    let suffixStart = index;
    while (suffixStart > 0 && /\s/u.test(rest[suffixStart - 1] ?? "")) {
      suffixStart -= 1;
    }
    return rest.slice(suffixStart);
  }
  return "";
}

export function reconcileDotenv(
  content: string,
  values: Readonly<Record<string, string>>,
): DotenvReconcileResult {
  const names = Object.keys(values);
  assertNoDuplicateAssignments(content, names);
  const parts = content.length === 0 ? [] : content.split(/(\r\n|\n)/u);
  const lines: string[] = [];
  const separators: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 2 === 0) lines.push(parts[index] ?? "");
    else separators.push(parts[index] ?? "");
  }
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const lineEnding = separators[separators.length - 1] ?? "\n";

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const missing = new Set(names);
  const next = lines.map((line) => {
    for (const name of names) {
      const match = assignmentPattern(name).exec(line);
      if (!match) continue;
      missing.delete(name);
      const replacement = `${match[1]}${encodeValue(values[name] ?? "")}${trailingComment(match[2] ?? "")}`;
      if (replacement === line) unchanged += 1;
      else updated += 1;
      return replacement;
    }
    return line;
  });
  const appended: string[] = [];
  for (const name of names) {
    if (!missing.has(name)) continue;
    appended.push(`${name}=${encodeValue(values[name] ?? "")}`);
    added += 1;
  }

  let result = "";
  for (let index = 0; index < next.length; index += 1) {
    const isLast = index === next.length - 1;
    const separator =
      separators[index] ?? (isLast && appended.length === 0 ? "" : lineEnding);
    result += `${next[index] ?? ""}${separator}`;
  }
  for (const line of appended) result += `${line}${lineEnding}`;

  assertReconciledSafely(content, result, values);
  return { content: result, added, updated, unchanged };
}
