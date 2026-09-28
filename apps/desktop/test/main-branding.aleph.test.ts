import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const mainPath = resolve(__dirname, "../src/main.ts");

const USER_VISIBLE_PROPERTIES = new Set([
  "detail",
  "details",
  "label",
  "message",
  "title",
]);

const ALLOWED_BB_NAMES = /\bbb Connect\b|\bbb-app\b/gu;

function collectStringTexts(node: ts.Node, texts: string[]): void {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    texts.push(node.text);
    return;
  }
  if (ts.isTemplateExpression(node)) {
    texts.push(node.head.text);
    for (const span of node.templateSpans) {
      texts.push(span.literal.text);
      collectStringTexts(span.expression, texts);
    }
    return;
  }
  if (
    ts.isBinaryExpression(node) ||
    ts.isConditionalExpression(node) ||
    ts.isParenthesizedExpression(node)
  ) {
    ts.forEachChild(node, (child) => {
      collectStringTexts(child, texts);
    });
  }
}

function userVisibleTexts(source: ts.SourceFile): string[] {
  const texts: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      USER_VISIBLE_PROPERTIES.has(node.name.text)
    ) {
      collectStringTexts(node.initializer, texts);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return texts;
}

describe("desktop main branding", () => {
  const source = ts.createSourceFile(
    mainPath,
    readFileSync(mainPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const texts = userVisibleTexts(source);

  it("finds the startup and log window strings it guards", () => {
    expect(texts).toContain("Opening Aleph");
    expect(texts).toContain(
      "Starting local services and opening the Aleph workspace.",
    );
    expect(texts).toContain("Aleph - Server & Daemon Logs");
  });

  it("names the app Aleph in user-visible window and view text", () => {
    const stale = texts.filter((text) =>
      /\bbb\b/u.test(text.replace(ALLOWED_BB_NAMES, "")),
    );

    expect(stale).toEqual([]);
  });
});
