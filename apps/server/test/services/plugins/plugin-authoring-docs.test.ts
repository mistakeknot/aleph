import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import type { PluginMessageTransfer } from "@get-bb/plugin-sdk";

const REPO_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));

const SKILL_ROOT = join(
  REPO_ROOT,
  "plugins/bb-guide/skills/bb-plugin-authoring/",
);

const SDK_DECLARATIONS = join(
  REPO_ROOT,
  "packages/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts",
);

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

const PRIMITIVE_TYPE_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void;

const FIELD_DOCUMENTED_TYPES = [
  "PluginAppBuilder",
  "PluginContentScriptContext",
  "PluginContentScriptRegistration",
  "ThreadChatProps",
  "ThreadChatMessageAction",
  "ThreadChatMessageReference",
  "ExperimentalThreadActionTabProps",
];

function readSkillProse(directory = SKILL_ROOT): string {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) return readSkillProse(entryPath);
      return entry.name.endsWith(".md") && !entry.name.endsWith("-api-index.md")
        ? readFileSync(entryPath, "utf8")
        : [];
    })
    .join("\n");
}

function readReference(name: string): string {
  return readFileSync(join(SKILL_ROOT, "references", name), "utf8");
}

function readSurfacesSource(): string {
  return readFileSync(
    join(REPO_ROOT, "plugins/plugin-api-docs/src/surfaces.ts"),
    "utf8",
  );
}

function loadSdkTypes() {
  const program = ts.createProgram([SDK_DECLARATIONS], COMPILER_OPTIONS);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(SDK_DECLARATIONS);
  const moduleSymbol =
    sourceFile === undefined
      ? undefined
      : checker.getSymbolAtLocation(sourceFile);
  if (moduleSymbol === undefined) {
    throw new Error(`Cannot read the plugin SDK types at ${SDK_DECLARATIONS}`);
  }
  const exportsByName = new Map(
    checker
      .getExportsOfModule(moduleSymbol)
      .map((symbol) => [symbol.name, symbol]),
  );

  function parts(type: ts.Type): readonly ts.Type[] {
    return type.isUnion() ? type.types : [type];
  }

  function exported(name: string): ts.Type {
    const symbol = exportsByName.get(name);
    if (symbol === undefined) {
      throw new Error(`@get-bb/plugin-sdk does not export ${name}`);
    }
    return checker.getDeclaredTypeOfSymbol(
      symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol,
    );
  }

  function members(type: ts.Type): ts.Symbol[] {
    // A primitive has no fields of its own; its apparent members (the String
    // methods of a `query: string` parameter) are not part of the API.
    return parts(type)
      .filter((part) => (part.flags & PRIMITIVE_TYPE_FLAGS) === 0)
      .flatMap((part) => checker.getPropertiesOfType(part))
      .filter((member) => !member.name.startsWith("internal_DO_NOT_USE_"));
  }

  function fields(type: ts.Type): string[] {
    return [...new Set(members(type).map((member) => member.name))];
  }

  function receivedFields(member: ts.Symbol): string[] {
    const received = parts(
      checker.getNonNullableType(checker.getTypeOfSymbol(member)),
    )
      .flatMap((part) => [
        ...part.getCallSignatures(),
        ...part.getConstructSignatures(),
      ])
      .flatMap((signature) => signature.getParameters().slice(0, 1))
      .flatMap((parameter) => fields(checker.getTypeOfSymbol(parameter)));
    return [...new Set(received)];
  }

  function stringLiterals(type: ts.Type): string[] {
    return parts(type).flatMap((part) =>
      part.isStringLiteral() ? [part.value] : [],
    );
  }

  return {
    exported,
    members,
    fields,
    receivedFields,
    stringLiterals,
    typeOf: (symbol: ts.Symbol) => checker.getTypeOfSymbol(symbol),
  };
}

describe("bb-plugin-authoring skill", () => {
  const skill = readSkillProse();
  const sdk = loadSdkTypes();

  it("typechecks the machine provider guide example against the public SDK", () => {
    const source = readReference("backend-machines.md").match(
      /```ts\n([\s\S]*?)```/u,
    )?.[1];
    expect(source).toBeDefined();
    const filename = fileURLToPath(
      new URL("./machine-guide-example.ts", import.meta.url),
    );
    const host = ts.createCompilerHost(COMPILER_OPTIONS);
    const readSource = host.getSourceFile.bind(host);
    host.getSourceFile = (
      file,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) =>
      resolve(file) === filename
        ? ts.createSourceFile(file, source!, languageVersion)
        : readSource(file, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([filename], COMPILER_OPTIONS, host);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ),
    ).toEqual([]);
  });

  it("documents every BbPluginApi property", () => {
    const undocumented = sdk
      .fields(sdk.exported("BbPluginApi"))
      .filter((key) => !skill.includes(`bb.${key}`));
    expect(undocumented).toEqual([]);
  });

  it("documents every settings descriptor type", () => {
    const types = sdk
      .members(sdk.exported("PluginSettingDescriptor"))
      .filter((member) => member.name === "type")
      .flatMap((member) => sdk.stringLiterals(sdk.typeOf(member)));
    expect(types.length).toBeGreaterThan(0);
    expect(types.filter((type) => !skill.includes(`type: "${type}"`))).toEqual(
      [],
    );
  });

  it("documents every http auth mode", () => {
    const modes = sdk.stringLiterals(sdk.exported("PluginHttpAuthMode"));
    expect(modes.length).toBeGreaterThan(0);
    expect(modes.filter((mode) => !skill.includes(`"${mode}"`))).toEqual([]);
  });

  it("documents every thread event and its payload fields", () => {
    const events = sdk.members(sdk.exported("PluginThreadEventPayloads"));
    expect(events.length).toBeGreaterThan(0);
    const undocumented = events.flatMap((event) => [
      ...(skill.includes(`"${event.name}"`) ? [] : [event.name]),
      ...sdk
        .fields(sdk.typeOf(event))
        .filter((field) => !skill.includes(field))
        .map((field) => `${event.name}: ${field}`),
    ]);
    expect(undocumented).toEqual([]);
  });

  it("documents every field of the types plugins fill in or read directly", () => {
    const undocumented = FIELD_DOCUMENTED_TYPES.flatMap((name) =>
      sdk
        .fields(sdk.exported(name))
        .filter((field) => !skill.includes(field))
        .map((field) => `${name}.${field}`),
    );
    expect(undocumented).toEqual([]);
    expect(skill).toContain("not a security sandbox");
    expect(skill).toContain("reverse registration order");
  });

  it("documents every frontend slot, its registration fields, and what bb passes to its components and callbacks", () => {
    const slots = sdk.members(sdk.exported("PluginAppSlots"));
    expect(slots.length).toBeGreaterThan(0);
    const undocumented = slots.flatMap((slot) => {
      const registration = sdk
        .typeOf(slot)
        .getCallSignatures()
        .flatMap((signature) => signature.getParameters().slice(0, 1))
        .map((parameter) => sdk.typeOf(parameter));
      const registrationMembers = registration.flatMap((type) =>
        sdk.members(type),
      );
      const names = new Set([
        slot.name,
        ...registrationMembers.map((member) => member.name),
        ...registrationMembers.flatMap((member) => sdk.receivedFields(member)),
      ]);
      return [...names]
        .filter((name) => !skill.includes(name))
        .map((name) => `${slot.name}: ${name}`);
    });
    expect(undocumented).toEqual([]);
  });

  it("documents the message.transferred delivery semantics and a null-safe example", () => {
    const events = readReference("backend-events.md");
    const transferFields = [
      "eventId",
      "operationId",
      "entryId",
      "kind",
      "state",
      "rowId",
      "sourceRowId",
      "originId",
    ] as const satisfies readonly (keyof PluginMessageTransfer)[];
    for (const field of transferFields) {
      expect(events, `transfer field ${field} is not documented`).toContain(
        `\`${field}\``,
      );
    }
    for (const phrase of [
      "PluginMessageTransfer",
      "`null`",
      "at-least-once",
      "awaits every",
      "including to listeners that already handled it successfully",
      "idempotently",
      "`pending`",
      "`terminal`",
      "`redirected`",
      "`residual`",
      "`not_forwardable`",
    ]) {
      expect(events, `"${phrase}" is missing from backend-events.md`).toContain(
        phrase,
      );
    }
    expect(events).not.toMatch(/[^?]entry\.waitingOn\?\.kind/);
    expect(events).toContain("entry?.waitingOn?.kind");
    expect(readSurfacesSource()).toContain("PluginMessageTransfer");
  });

  it("keeps environment app symbols and composer and event guidance current", () => {
    const frontendIndex = readReference("frontend-api-index.md");
    const appSymbols = [
      "experimental_BranchPicker",
      "BranchPickerProps",
      "experimental_useBranches",
      "UseBranchesArgs",
      "BranchesState",
      "experimental_useCheckoutState",
      "UseCheckoutStateArgs",
      "CheckoutState",
      "PluginEnvironmentProviderInputsChange",
      "PluginEnvironmentProviderInputsProps",
      "PluginEnvironmentProviderInputsRegistration",
    ];
    for (const symbol of appSymbols) {
      expect(frontendIndex).toContain(`\`${symbol}\``);
    }

    expect(readReference("frontend-components.md")).not.toContain(
      'workspace: { type: "personal" }',
    );
    expect(readReference("backend-events.md")).toContain("Nineteen events.");
    expect(readReference("backend-events.md")).toContain(
      "The seven `thread.*` ones",
    );
    expect(readReference("testing.md")).toContain(
      "Thread events are observe-only; there are exactly seven",
    );
  });
});
