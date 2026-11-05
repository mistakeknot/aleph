import path from "node:path";
import { PluginCliError } from "@get-bb/plugin-sdk";
import { detectKeyShape } from "./key-shape.js";
import { secretNameSchema } from "./secret-request.js";

export interface ParsedRequest {
  names: string[];
  project: string;
  purpose: string | null;
  descriptions: Map<string, string>;
  writeEnv: string;
}

const DESCRIBE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const DESCRIBE_SPELLINGS = new Set([
  "--describe",
  "--description",
  "--describe-variable",
]);
const PROJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/u;
const TEXT_MAX_LENGTH = 500;

export function cliError(message: string, code: string, hint?: string): never {
  throw new PluginCliError(message, {
    code,
    ...(hint === undefined ? {} : { hint }),
  });
}

function parseSecretName(value: string, label: string): string {
  if (value.includes("=")) {
    cliError(
      `${label} must be a bare variable name; values are typed into the secure form, never passed as arguments.`,
      "value_in_argv",
    );
  }
  const parsed = secretNameSchema.safeParse(value);
  if (!parsed.success) {
    cliError(
      `${label} must start with a letter or underscore and contain only letters, digits, and underscores.`,
      "invalid_variable_name",
    );
  }
  return parsed.data;
}

export function foldDescribePairs(argv: readonly string[]): string[] {
  const folded: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const name = argv[index + 1];
    const description = argv[index + 2];
    if (
      !DESCRIBE_SPELLINGS.has(token) ||
      name === undefined ||
      description === undefined ||
      !DESCRIBE_NAME_PATTERN.test(name) ||
      description.startsWith("--")
    ) {
      folded.push(token);
      continue;
    }
    folded.push(`--describe=${name}=${description}`);
    index += 2;
  }
  return folded;
}

function checkFreeText(text: string, label: string): void {
  if (text.length > TEXT_MAX_LENGTH) {
    cliError(`${label} is too long.`, "text_too_long");
  }
  if (/[\0\r\n]/u.test(text)) {
    cliError(`${label} must be a single line.`, "invalid_text");
  }
  if (detectKeyShape(text) !== null) {
    cliError(
      `${label} looks like a credential. Describe what is needed, never include a value.`,
      "key_shaped_text",
    );
  }
}

function parseDescriptions(
  entries: readonly string[],
  names: readonly string[],
): Map<string, string> {
  const descriptions = new Map<string, string>();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0) {
      cliError(
        "--describe requires NAME and DESCRIPTION.",
        "invalid_describe",
        "Write --describe NAME 'text' or --describe NAME=text.",
      );
    }
    const name = parseSecretName(
      entry.slice(0, separator).trim(),
      "--describe NAME",
    );
    const description = entry.slice(separator + 1).trim();
    if (description.length === 0) {
      cliError(
        "--describe requires NAME and DESCRIPTION.",
        "invalid_describe",
        "Write --describe NAME 'text' or --describe NAME=text.",
      );
    }
    checkFreeText(description, "--describe text");
    if (descriptions.has(name))
      cliError(`Duplicate --describe for ${name}.`, "duplicate_describe");
    if (!names.includes(name)) {
      cliError(
        `--describe references unrequested variable ${name}.`,
        "unrequested_describe",
      );
    }
    descriptions.set(name, description);
  }
  return descriptions;
}

export function parseRequest(input: {
  names: readonly string[];
  project: string;
  purpose: string | undefined;
  describe: readonly string[];
  writeEnv: string;
}): ParsedRequest {
  const names = input.names.map((name) =>
    parseSecretName(name, "Variable name"),
  );
  if (names.length === 0 || names.length > 64) {
    cliError("Request between 1 and 64 variables.", "invalid_variable_count");
  }
  if (new Set(names).size !== names.length)
    cliError("Variable names must be unique.", "duplicate_variable_name");
  const project = input.project.trim();
  if (!PROJECT_PATTERN.test(project)) {
    cliError(
      "--project must be an allowlisted project name.",
      "invalid_project",
    );
  }
  const purpose = input.purpose?.trim();
  if (purpose !== undefined && purpose.length === 0) {
    cliError(
      "--purpose requires a non-empty description.",
      "invalid_purpose",
      "Write --purpose 'why these credentials are needed'.",
    );
  }
  if (purpose !== undefined) checkFreeText(purpose, "--purpose");
  const writeEnv = input.writeEnv.trim();
  if (writeEnv.length === 0)
    cliError("--write-env requires a path.", "invalid_write_env");
  return {
    names,
    project,
    purpose: purpose ?? null,
    descriptions: parseDescriptions(input.describe, names),
    writeEnv,
  };
}

export function resolveDestinationPath(cwd: string, candidate: string): string {
  if (/[\0\\]/u.test(candidate) || candidate.endsWith("/")) {
    cliError("--write-env must be a normalized path.", "path_not_normalized");
  }
  const segments = candidate.split("/");
  const body = path.posix.isAbsolute(candidate) ? segments.slice(1) : segments;
  if (body.some((part) => part === "" || part === "." || part === "..")) {
    cliError("--write-env must be a normalized path.", "path_not_normalized");
  }
  if (path.posix.isAbsolute(candidate)) return candidate;
  if (!path.posix.isAbsolute(cwd)) {
    cliError(
      "bb secret request needs a POSIX working directory.",
      "invalid_cwd",
    );
  }
  return path.posix.join(cwd, candidate);
}
