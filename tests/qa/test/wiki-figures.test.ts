import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const wikiSrc = path.join(repoRoot, "docs/wiki/src");

function read(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

function dirs(relative: string, withFile?: string): string[] {
  return readdirSync(path.join(repoRoot, relative), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter(
      (entry) =>
        withFile === undefined ||
        existsSync(path.join(repoRoot, relative, entry.name, withFile)),
    )
    .map((entry) => entry.name);
}

function constant(file: string, pattern: RegExp): string {
  const match = pattern.exec(read(file));
  if (match?.[1] === undefined) {
    throw new Error(`${file} does not match ${pattern}`);
  }
  return match[1];
}

function expectedFigures(): Record<string, string> {
  const version = (
    JSON.parse(read("packages/bb-app/package.json")) as { version: string }
  ).version;
  const [upstream, aleph] = version.split("+aleph.");
  const desktopVersion = (
    JSON.parse(read("apps/desktop/package.json")) as { version: string }
  ).version;
  if (desktopVersion !== version) {
    throw new Error("desktop and bb-app versions differ");
  }
  const marketplace = JSON.parse(read("plugins/bb-official.json")) as object;
  const poolStore = "plugins/account-pool/src/store.ts";
  const poolHub = "plugins/account-pool/src/hub.ts";
  const idleMs = constant(
    poolHub,
    /AFFINITY_IDLE_TTL_MS = (\d+ \* \d+ \* [\d_]+);/u,
  );
  const graceMs = constant(
    poolStore,
    /HUB_TOKEN_GRACE_MS = (\d+ \* \d+ \* [\d_]+);/u,
  );
  const minutes = (expression: string): string =>
    String(
      expression
        .replaceAll("_", "")
        .split("*")
        .map((term) => Number(term.trim()))
        .reduce((a, b) => a * b) / 60_000,
    );
  const plugins = dirs("plugins", "package.json");
  return {
    "aleph-version": aleph!,
    "upstream-version": upstream!,
    "package-version": version,
    apps: String(dirs("apps", "package.json").length),
    packages: String(dirs("packages", "package.json").length),
    plugins: String(plugins.length),
    "official-plugins": String(
      Object.keys(marketplace).filter((name) => plugins.includes(name)).length,
    ),
    "provider-plugins": String(
      plugins.filter((name) => name.startsWith("provider-")).length,
    ),
    "environment-plugins": String(
      plugins.filter((name) => name.startsWith("environment-")).length,
    ),
    "switch-threshold": constant(
      "plugins/account-pool/src/contracts.ts",
      /switchThreshold: ([\d.]+),/u,
    ),
    "affinity-idle-minutes": minutes(idleMs),
    "affinity-max-bindings": constant(
      poolHub,
      /MAX_AFFINITY_BINDINGS = ([\d_]+);/u,
    ).replaceAll("_", ""),
    "token-grace-minutes": minutes(graceMs),
    "nested-default": constant(
      "plugins/account-pool/src/contracts.ts",
      /nestedLaunchThreadIds: nestedLaunchThreadIdsSchema\.default\((\[\])\),/u,
    ),
    journeys: String(
      readdirSync(path.join(repoRoot, "docs/cujs")).filter((name) =>
        /^aleph-\d+-.*\.md$/u.test(name),
      ).length,
    ),
  };
}

describe("wiki figures match the code", () => {
  const expected = expectedFigures();
  const found = new Map<string, string[]>();
  let opened = 0;
  let wellFormed = 0;
  for (const page of readdirSync(wikiSrc).filter((f) => f.endsWith(".md"))) {
    const text = readFileSync(path.join(wikiSrc, page), "utf8");
    opened += text.match(/<!--fig:/gu)?.length ?? 0;
    for (const match of text.matchAll(
      /<!--fig:([a-z-]+)=([^\s>]+?)-->`?([\w.+[\]-]+)`?(?=[.,;:)]?(?:\s|$))/gu,
    )) {
      wellFormed += 1;
      const visible = match[3]!.replace(/\.+$/u, "");
      found.set(match[1]!, [
        ...(found.get(match[1]!) ?? []),
        match[2]!,
        visible,
      ]);
    }
  }

  for (const [name, value] of Object.entries(expected)) {
    it(`figure ${name} is on the wiki and equals ${value}`, () => {
      expect(found.get(name), `no marker for ${name}`).toBeDefined();
      for (const stated of found.get(name)!) {
        expect(stated).toBe(value);
      }
    });
  }

  it("has no malformed marker", () => {
    expect(wellFormed).toBe(opened);
  });

  it("has no marker for an unknown figure", () => {
    expect([...found.keys()].filter((name) => !(name in expected))).toEqual([]);
  });

  it("lists every page in SUMMARY.md", () => {
    const summary = readFileSync(path.join(wikiSrc, "SUMMARY.md"), "utf8");
    for (const page of readdirSync(wikiSrc).filter(
      (f) => f.endsWith(".md") && f !== "SUMMARY.md",
    )) {
      expect(summary).toContain(`(${page})`);
    }
  });
});
