import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const DATA_DIR = path.join(REPO_ROOT, "packages/db/src/data");
const AUDIT_PATH =
  process.env.COLD_TIER_READER_AUDIT ??
  path.join(REPO_ROOT, "docs/cold-tier-reader-audit.md");
const CLASS_PATTERN = /\b(KEEP|HYDRATE|EXCLUDE|GLOBAL|gated)\b/;

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function parseAuditRows(markdown: string): Map<string, string> {
  const classes = new Map<string, string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 2) continue;
    const classMatch = CLASS_PATTERN.exec(cells.slice(1).join("|"));
    if (classMatch === null) continue;
    for (const name of cells[0]!.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
      classes.set(name, classMatch[1]!);
  }
  return classes;
}

interface FunctionInfo {
  body: ts.Node;
  exported: boolean;
  name: string;
}

function collectFunctions(sf: ts.SourceFile): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  const isExported = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      out.push({
        body: statement.body,
        exported: isExported(statement),
        name: statement.name.text,
      });
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          init !== undefined &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        )
          out.push({
            body: init.body,
            exported: isExported(statement),
            name: declaration.name.text,
          });
      }
    }
  }
  return out;
}

const RAW_EVENTS_SQL = /\b(from|into|update|join)\s+events\b|\bevents\./i;

function referencesEventsTable(node: ts.Node): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(current) && current.text === "events") {
      const parent = current.parent;
      const isMemberName =
        ts.isPropertyAccessExpression(parent) && parent.name === current;
      const isPropertyKey =
        ts.isPropertyAssignment(parent) && parent.name === current;
      if (!isMemberName && !isPropertyKey) found = true;
    }
    if (
      (ts.isStringLiteral(current) ||
        ts.isNoSubstitutionTemplateLiteral(current) ||
        ts.isTemplateHead(current) ||
        ts.isTemplateMiddle(current) ||
        ts.isTemplateTail(current)) &&
      RAW_EVENTS_SQL.test(current.text)
    )
      found = true;
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function calledNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (current: ts.Node): void => {
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression))
      names.add(current.expression.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

function exportedEventsReaders(): string[] {
  const result: string[] = [];
  for (const file of listTsFiles(DATA_DIR)) {
    if (path.basename(file) === "event-cold-tier.ts") continue;
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const functions = collectFunctions(sf);
    const touching = new Set(
      functions
        .filter((fn) => referencesEventsTable(fn.body))
        .map((fn) => fn.name),
    );
    const callees = new Map(
      functions.map((fn) => [fn.name, calledNames(fn.body)]),
    );
    for (let changed = true; changed; ) {
      changed = false;
      for (const fn of functions) {
        if (touching.has(fn.name)) continue;
        if ([...(callees.get(fn.name) ?? [])].some((n) => touching.has(n))) {
          touching.add(fn.name);
          changed = true;
        }
      }
    }
    for (const fn of functions)
      if (fn.exported && touching.has(fn.name))
        result.push(`${path.relative(REPO_ROOT, file)}#${fn.name}`);
  }
  return result.sort();
}

describe("cold tier reader audit guard", () => {
  it.skipIf(!fs.existsSync(AUDIT_PATH))(
    "every exported db data function touching events appears in the audit with a class",
    () => {
      const audited = parseAuditRows(fs.readFileSync(AUDIT_PATH, "utf8"));
      const readers = exportedEventsReaders();
      expect(readers.length).toBeGreaterThan(20);
      const missing = readers.filter(
        (entry) => !audited.has(entry.split("#")[1]!),
      );
      expect(missing).toEqual([]);
    },
  );

  it("the scanner finds known events readers and writers", () => {
    const readers = exportedEventsReaders();
    expect(readers).toContain("packages/db/src/data/events.ts#insertEvents");
    expect(readers).toContain(
      "packages/db/src/data/events.ts#getLatestThreadSequence",
    );
    expect(readers).toContain(
      "packages/db/src/data/thread-pruning.ts#advanceThreadPruning",
    );
  });
});

const PLAN_LISTED_ENVIRONMENT_WRITERS = [
  "bindEnvironmentPath",
  "findBlockingEnvironmentPathClaim",
  "markProviderEnvironmentAttached",
  "releaseFinishedEnvironmentPreparationOwners",
  "reserveEnvironment",
  "updatePreparingEnvironment",
  "writeEnvironment",
];

const CURRENT_LIFECYCLE_ENVIRONMENT_WRITERS = [
  "applyEnvironmentLifecycleEventInTransaction",
  "markHostEnvironmentsDestroyed",
];

function enclosingFunctionName(node: ts.Node): string {
  for (
    let current: ts.Node | undefined = node;
    current;
    current = current.parent
  ) {
    if (ts.isFunctionDeclaration(current) && current.name)
      return current.name.text;
    if (ts.isMethodDeclaration(current)) return current.name.getText();
    if (
      ts.isVariableDeclaration(current) &&
      ts.isIdentifier(current.name) &&
      current.initializer !== undefined &&
      (ts.isArrowFunction(current.initializer) ||
        ts.isFunctionExpression(current.initializer))
    )
      return current.name.text;
  }
  return "<module>";
}

function environmentOwnerOrStatusWriters(): string[] {
  const roots = [
    path.join(REPO_ROOT, "packages/db/src/data/environments.ts"),
    ...listTsFiles(path.join(REPO_ROOT, "apps/server/src")).filter((file) =>
      fs.readFileSync(file, "utf8").includes("update(environments)"),
    ),
    ...listTsFiles(path.join(REPO_ROOT, "packages/db/src")).filter((file) =>
      fs.readFileSync(file, "utf8").includes("update(environments)"),
    ),
  ];
  const files = [...new Set(roots)];
  const configPath = path.join(REPO_ROOT, "apps/server/tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    path.dirname(configPath),
  );
  const program = ts.createProgram(files, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const writers = new Set<string>();
  for (const file of files) {
    const sf = program.getSourceFile(file);
    if (sf === undefined) throw new Error(`Missing source file ${file}`);
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "set" &&
        ts.isCallExpression(node.expression.expression)
      ) {
        const update = node.expression.expression;
        const target = update.arguments[0];
        if (
          ts.isPropertyAccessExpression(update.expression) &&
          update.expression.name.text === "update" &&
          target !== undefined &&
          ts.isIdentifier(target) &&
          target.text === "environments" &&
          node.arguments[0] !== undefined
        ) {
          const names = checker
            .getPropertiesOfType(checker.getTypeAtLocation(node.arguments[0]))
            .map((property) => property.name);
          if (names.includes("ownerThreadId") || names.includes("status"))
            writers.add(enclosingFunctionName(node));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return [...writers].sort();
}

describe("environment owner and status writer inventory", () => {
  it("every update(environments).set that can write ownerThreadId or status is listed", () => {
    const writers = environmentOwnerOrStatusWriters();
    const unlisted = writers.filter(
      (name) =>
        !PLAN_LISTED_ENVIRONMENT_WRITERS.includes(name) &&
        !CURRENT_LIFECYCLE_ENVIRONMENT_WRITERS.includes(name),
    );
    expect(unlisted).toEqual([]);
    for (const name of PLAN_LISTED_ENVIRONMENT_WRITERS)
      expect(writers).toContain(name);
  }, 60_000);

  it("raw SQL updates of environments outside tests stay in the startup migration", () => {
    const offenders = listTsFiles(path.join(REPO_ROOT, "packages/db/src"))
      .concat(listTsFiles(path.join(REPO_ROOT, "apps/server/src")))
      .filter((file) =>
        /UPDATE\s+environments\b/i.test(fs.readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(REPO_ROOT, file));
    expect(offenders).toEqual(["packages/db/src/migrate.ts"]);
  });
});
