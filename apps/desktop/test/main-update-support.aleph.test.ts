import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// main.ts runs Electron at import time, so this reads its source instead:
// resolveDesktopUpdateSupport only turns updates off for an Aleph build when
// main.ts hands it the running version.
const mainPath = resolve(__dirname, "../src/main.ts");

function objectArgumentsOf(
  source: ts.SourceFile,
  calleeName: string,
): ts.ObjectLiteralExpression[] {
  const found: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === calleeName
    ) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        found.push(argument);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function propertyText(
  object: ts.ObjectLiteralExpression,
  name: string,
): string | null {
  for (const property of object.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === name
    ) {
      return property.initializer.getText();
    }
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === name
    ) {
      return name;
    }
  }
  return null;
}

describe("desktop main update wiring", () => {
  const source = ts.createSourceFile(
    mainPath,
    readFileSync(mainPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  it("passes the running desktop version into resolveDesktopUpdateSupport", () => {
    const calls = objectArgumentsOf(source, "resolveDesktopUpdateSupport");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call === undefined) throw new Error("expected one call");

    const updateServices = objectArgumentsOf(
      source,
      "createDesktopUpdateService",
    );
    expect(updateServices).toHaveLength(1);
    const [updateService] = updateServices;
    if (updateService === undefined) throw new Error("expected one call");

    const runningVersion = propertyText(updateService, "currentVersion");
    expect(runningVersion).toBe("desktopVersion");
    expect(propertyText(call, "appVersion")).toBe(runningVersion);
  });
});
