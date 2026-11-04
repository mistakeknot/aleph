import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { CLI_LAUNCHER_MARKER } from "@bb/config/cli-command";

const SHIM_READ_LIMIT_BYTES = 64 * 1024;
const SHELL_ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;
const SHELL_EXEC = /^\s*exec\s+(.*)$/u;

interface CliOverrideLoopArgs {
  entryPath: string | null;
  override: string;
}

function tryRealpath(path: string): string | null {
  try {
    return realpathSync(resolve(path));
  } catch {
    return null;
  }
}

function tryReadShim(path: string): string | null {
  try {
    const buffer = readFileSync(path);
    if (buffer.byteLength > SHIM_READ_LIMIT_BYTES) {
      return null;
    }
    const text = buffer.toString("utf8");
    return text.startsWith("#!") ? text : null;
  } catch {
    return null;
  }
}

function unquote(word: string): string {
  const single = /^'([^']*)'/u.exec(word);
  if (single !== null) {
    return single[1] ?? "";
  }
  const double = /^"([^"]*)"/u.exec(word);
  if (double !== null) {
    return double[1] ?? "";
  }
  return word.split(/\s/u)[0] ?? "";
}

function readShellAssignments(text: string): Map<string, string> {
  const assignments = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = SHELL_ASSIGNMENT.exec(line);
    if (match !== null && match[1] !== undefined && match[2] !== undefined) {
      assignments.set(match[1], unquote(match[2].trim()));
    }
  }
  return assignments;
}

function expandShellWord(
  word: string,
  assignments: Map<string, string>,
): string {
  return word.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu,
    (_whole, braced: string | undefined, bare: string | undefined) =>
      assignments.get(braced ?? bare ?? "") ?? "",
  );
}

function splitShellWords(text: string): string[] {
  const words: string[] = [];
  const pattern = /'([^']*)'|"([^"]*)"|([^\s'"]+)/gu;
  for (const match of text.matchAll(pattern)) {
    words.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return words;
}

function readShimExecTargets(text: string, shimPath: string): string[] {
  const assignments = readShellAssignments(text);
  const targets: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = SHELL_EXEC.exec(line);
    if (match === null || match[1] === undefined) {
      continue;
    }
    for (const word of splitShellWords(match[1])) {
      const expanded = expandShellWord(word, assignments);
      if (expanded.length === 0 || expanded.startsWith("-")) {
        continue;
      }
      targets.push(
        isAbsolute(expanded) ? expanded : resolve(dirname(shimPath), expanded),
      );
    }
  }
  return targets;
}

export function cliOverrideLoopsBackToLauncher(
  args: CliOverrideLoopArgs,
): boolean {
  const overridePath = tryRealpath(args.override);
  if (overridePath === null) {
    return false;
  }
  const entryPath =
    args.entryPath === null ? null : tryRealpath(args.entryPath);
  if (entryPath !== null && overridePath === entryPath) {
    return true;
  }
  const shim = tryReadShim(overridePath);
  if (shim === null) {
    return false;
  }
  if (shim.includes(CLI_LAUNCHER_MARKER)) {
    return true;
  }
  if (entryPath === null) {
    return false;
  }
  return readShimExecTargets(shim, overridePath).some(
    (target) => tryRealpath(target) === entryPath,
  );
}
