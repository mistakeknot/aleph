import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const BRANDED_SOURCE_FILES = [
  "desktop-browser-view.ts",
  "existing-server-dialog.ts",
  "local-view.ts",
  "log-viewer.ts",
  "main.ts",
  "menu.ts",
  "moved-machine-service.ts",
  "remote-server-load.ts",
  "server-moved.ts",
  "server-probe.ts",
  "server-url-dialog.ts",
];

const ALLOWED_BB_NAMES =
  /\bbb Connect\b|[\w.:-]*[-.:(]bb\b[\w.:-]*|\bbb[-:)][\w.:-]*/gu;

const LOG_PREFIX = "[desktop]";

function readSource(fileName: string): ts.SourceFile {
  const path = resolve(__dirname, "../src", fileName);
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

function literalTexts(node: ts.Node): string[] | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isTemplateExpression(node)) {
    return [
      node.head.text,
      ...node.templateSpans.map((span) => span.literal.text),
    ];
  }
  return null;
}

function staleBbStrings(source: ts.SourceFile): string[] {
  const stale: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      return;
    }
    const texts = literalTexts(node);
    if (texts !== null && !(texts[0] ?? "").startsWith(LOG_PREFIX)) {
      for (const text of texts) {
        if (/\bbb\b/u.test(text.replace(ALLOWED_BB_NAMES, ""))) {
          const { line } = source.getLineAndCharacterOfPosition(
            node.getStart(),
          );
          stale.push(`${String(line + 1)}: ${text}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return stale;
}

function allLiteralTexts(source: ts.SourceFile): string[] {
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    texts.push(...(literalTexts(node) ?? []));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return texts;
}

describe("desktop branding", () => {
  it("finds the startup and log window strings it guards", () => {
    const texts = allLiteralTexts(readSource("main.ts"));

    expect(texts).toContain("Opening Aleph");
    expect(texts).toContain(
      "Starting local services and opening the Aleph workspace.",
    );
    expect(texts).toContain("Aleph - Server & Daemon Logs");
  });

  it("allows bb Connect, identifiers, and log lines", () => {
    expect(
      "sign in to bb Connect, x-bb-connect-machine, persist:bb-browser, .bb, (bb)".replace(
        ALLOWED_BB_NAMES,
        "",
      ),
    ).not.toMatch(/\bbb\b/u);
    expect("Your bb server moved".replace(ALLOWED_BB_NAMES, "")).toMatch(
      /\bbb\b/u,
    );
  });

  it.each(BRANDED_SOURCE_FILES)(
    "names the app Aleph in user-visible strings in %s",
    (fileName) => {
      expect(staleBbStrings(readSource(fileName))).toEqual([]);
    },
  );
});
