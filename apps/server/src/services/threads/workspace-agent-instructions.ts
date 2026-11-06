import fs from "node:fs";
import path from "node:path";
import type { ServerLogger } from "../../types.js";
import { isFsErrorWithCode } from "../lib/fs-errors.js";

export const DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH = "AGENTS.md";

export const WORKSPACE_AGENT_INSTRUCTIONS_RELATIVE_PATH = ".bb/AGENTS.md";

function readAgentInstructionsFile(
  logger: ServerLogger,
  filePath: string,
): string | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && isFsErrorWithCode(error, "ENOENT")) {
      return null;
    }
    logger.warn(
      {
        filePath,
        reason: error instanceof Error ? error.message : String(error),
      },
      "Skipping unreadable agent instructions file",
    );
    return null;
  }

  const trimmed = content.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readDataDirAgentInstructions(
  logger: ServerLogger,
  dataDir: string,
): string | null {
  return readAgentInstructionsFile(
    logger,
    path.join(dataDir, DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH),
  );
}

const CLAUDE_MD_RELATIVE_PATHS = [
  "CLAUDE.md",
  path.join(".claude", "CLAUDE.md"),
];

const AGENTS_IMPORT_PATTERN = /(^|\s)@(\.\/)?AGENTS\.md(?=$|[\s.,;:!?)\]])/m;

function realPathOrNull(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
}

function claudeMdImportsAgentsMd(directory: string): boolean | null {
  let found = false;
  for (const relativePath of CLAUDE_MD_RELATIVE_PATHS) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(directory, relativePath), "utf8");
    } catch {
      continue;
    }
    found = true;
    if (AGENTS_IMPORT_PATTERN.test(content)) {
      return true;
    }
  }
  return found ? false : null;
}

export function claudeCodeWalkUpLoadsDataDirAgentInstructions(
  dataDir: string,
  cwd: string,
): boolean {
  const target = realPathOrNull(
    path.join(dataDir, DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH),
  );
  const start = realPathOrNull(cwd);
  if (target === null || start === null) {
    return false;
  }
  let directory = start;
  for (;;) {
    const candidate = realPathOrNull(
      path.join(directory, DATA_DIR_AGENT_INSTRUCTIONS_RELATIVE_PATH),
    );
    if (candidate === target) {
      const imported = claudeMdImportsAgentsMd(directory);
      if (imported === null || imported) {
        return true;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return false;
    }
    directory = parent;
  }
}
