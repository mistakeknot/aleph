import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { matchesGlob } from "node:path";
import { createRequire } from "node:module";

const shards = JSON.parse(readFileSync("scripts/ci-test-shards.json", "utf8"));
const full = {
  tests: {
    include: shards.tests.map((entry) => ({
      ...entry,
      mobile: matchesFilter("@bb/mobile", entry.filter),
    })),
  },
  "windows-tests": {
    include: shards["windows-tests"].map((entry) => ({
      ...entry,
      mobile: matchesFilter("@bb/mobile", entry.filter),
    })),
  },
  foundation: true,
  packaging: true,
  providers: true,
  forks: true,
  buildFilters: "",
  staticFilters: "",
  buildNeeded: true,
  staticNeeded: true,
  appBuild: true,
  sdkBuild: true,
  renderInvariants: true,
  reason: "Full cross-platform coverage",
};

function matchesFilter(name, filter) {
  const patterns = filter.split(/\s+/u).map((part) => {
    if (!part.startsWith("--filter=")) throw new Error("Unsupported CI filter");
    return part.slice(9).replaceAll("'", "");
  });
  const match = (pattern) =>
    new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
        .join(".*")}$`,
      "u",
    ).test(name);
  const positive = patterns.filter((pattern) => !pattern.startsWith("!"));
  return (
    (positive.length === 0 || positive.some(match)) &&
    !patterns.some(
      (pattern) => pattern.startsWith("!") && match(pattern.slice(1)),
    )
  );
}

function pluginHasApp(name) {
  const manifest = `plugins/${name}/package.json`;
  if (!existsSync(manifest)) return true;
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  return typeof parsed?.bb?.app === "string";
}

function touchesRenderedClient(path) {
  if (
    /^(?:apps\/app\/|packages\/(?:client-core|core-ui|plugin-sdk|shared-ui|thread-view)\/|tests\/(?:render-invariants|scripted-echo-provider)\/|tests\/integration\/helpers\/)/u.test(
      path,
    )
  ) {
    return true;
  }
  const plugin = /^plugins\/([^/]+)\//u.exec(path);
  return plugin !== null && pluginHasApp(plugin[1]);
}

export function parseTurbo(text) {
  const ts = createRequire(import.meta.url)("typescript");
  const result = ts.parseConfigFileTextToJson("turbo.json", text);
  if (result.error || !result.config?.tasks)
    throw new Error("Invalid Turbo JSONC");
  return result.config;
}

export function sharedTestInputs(turbo) {
  const pending = Object.keys(turbo.tasks).filter(
    (name) => name === "test" || name.endsWith("#test"),
  );
  const visited = new Set();
  const inputs = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    const task = turbo.tasks[name];
    if (!task) continue;
    for (const input of task.inputs ?? []) {
      if (input.startsWith("$TURBO_ROOT$/")) inputs.add(input.slice(13));
    }
    for (const dep of task.dependsOn ?? []) {
      const base = dep.replace(/^\^/, "").split("#").at(-1);
      pending.push(
        ...Object.keys(turbo.tasks).filter(
          (key) => key === dep || key === base || key.endsWith(`#${base}`),
        ),
      );
    }
  }
  return [...inputs].sort();
}

export function knownCiPath(path) {
  return /^(?:apps|packages|plugins|examples\/plugins|tests)\//u.test(path);
}

export function parseAffectedTasks(paths, result) {
  const items = result?.data?.affectedTasks?.items;
  if (!Array.isArray(items) || result.errors?.length)
    throw new Error("Invalid Turbo change query");
  const tasks = items.map((item) => {
    if (
      typeof item?.name !== "string" ||
      typeof item?.package?.name !== "string" ||
      (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(item.package.name) &&
        item.package.name !== "//")
    )
      throw new Error("Invalid affected task");
    return { name: item.name, package: item.package.name };
  });
  if (paths.length && !tasks.length)
    throw new Error("Changed files without affected tasks");
  return tasks;
}

export function evaluateChanges(paths, result, turbo) {
  const known =
    /^(?:apps|packages|plugins|tests)\/[^/]+\/(?:src|test|tests)\/.+\.(?:ts|tsx|js|jsx|mjs|cjs)$|^examples\/plugins\/[^/]+\/(?:src|test|tests)\/.+\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;
  if (
    !paths.length ||
    paths.some(
      (path) =>
        !knownCiPath(path) ||
        !known.test(path) ||
        /(^|\/)(scripts?|data|fixtures|__fixtures__|config)(\/|\.)|(^|\/)[^/]*config[^/]*\./i.test(
          path,
        ),
    )
  )
    return "full";
  const inputs = sharedTestInputs(turbo);
  const touchesSharedInput = paths.some((path) =>
    inputs.some((input) => matchesGlob(path, input)),
  );
  if (touchesSharedInput) return "full";
  return parseAffectedTasks(paths, result);
}

function select(values) {
  if (values.full) return full;
  if (!values.base || !values.affected)
    throw new Error("Missing change evidence");
  const paths = execFileSync(
    "git",
    ["diff", "--name-only", "--no-renames", "-z", values.base, "HEAD", "--"],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  if (
    paths.length > 0 &&
    paths.every((path) =>
      /^docs\/(?:ci-performance|windows-ci|debugging-and-qa|filing-issues|cli-guide-and-skill)\.md$/u.test(
        path,
      ),
    )
  ) {
    return {
      ...full,
      tests: { include: [] },
      "windows-tests": { include: [] },
      foundation: false,
      packaging: false,
      providers: false,
      forks: false,
      buildNeeded: false,
      staticNeeded: false,
      appBuild: false,
      sdkBuild: false,
      renderInvariants: false,
      reason: "CI and contributor documentation only",
    };
  }
  if (paths.some((path) => !knownCiPath(path))) return full;
  const tasks = parseAffectedTasks(
    paths,
    JSON.parse(readFileSync(values.affected, "utf8")),
  );
  const tests = new Set(
    tasks.filter((task) => task.name === "test").map((task) => task.package),
  );
  const packagesFor = (names) =>
    [
      ...new Set(
        tasks
          .filter((task) => names.includes(task.name))
          .map((task) => task.package),
      ),
    ].filter((name) => name !== "//");
  const buildPackages = packagesFor(["build"]);
  const staticPackages = packagesFor(["lint", "lint:type-aware", "typecheck"]);
  const filtersFor = (packages) =>
    packages
      .sort()
      .map((name) => `--filter=${name}`)
      .join(" ");
  const uiOnly = paths.every((path) =>
    /^(?:apps\/(?:app|web)\/(?:src|public)\/|packages\/(?:core-ui|shared-ui|thread-view|client-core|mobile-bridge)\/(?:src|test|tests)\/)/u.test(
      path,
    ),
  );
  const appOnly = paths.every((path) =>
    /^apps\/(?:app|web)\/(?:src|public)\//u.test(path),
  );
  const packaging = paths.some((path) =>
    /^(?:apps\/(?:desktop\/|app\/(?:vite\.config|scripts\/|package\.json))|packages\/(?:bb-app|server-archive|plugin-build|bundled-plugins|plugin-sdk|sdk|templates)\/)/u.test(
      path,
    ),
  );
  const matrix = (entries) => ({
    include: entries.flatMap((entry) => {
      const selected = [...tests].filter((name) =>
        matchesFilter(name, entry.filter),
      );
      return selected.length === 0
        ? []
        : [
            {
              ...entry,
              mobile: selected.includes("@bb/mobile"),
              filter: selected
                .sort()
                .map((name) => `--filter=${name}`)
                .join(" "),
            },
          ];
    }),
  });
  return {
    tests: matrix(shards.tests),
    "windows-tests": uiOnly ? { include: [] } : matrix(shards["windows-tests"]),
    foundation:
      !uiOnly &&
      shards.foundation.some((name) =>
        tasks.some((task) => task.package === name),
      ),
    packaging,
    providers: paths.some((path) =>
      /^(?:plugins\/provider-|packages\/(?:agent-runtime|provider-bridge-))/u.test(
        path,
      ),
    ),
    forks:
      !appOnly && tasks.some((task) => task.package.startsWith("bb-plugin-")),
    buildNeeded: buildPackages.length > 0,
    staticNeeded: staticPackages.length > 0,
    appBuild: tasks.some(
      (task) => task.package === "@bb/app" && task.name === "build",
    ),
    sdkBuild: tasks.some(
      (task) => task.package === "@get-bb/plugin-sdk" && task.name === "build",
    ),
    renderInvariants: paths.some(touchesRenderedClient),
    buildFilters: filtersFor(buildPackages),
    staticFilters: filtersFor(staticPackages),
    reason: `Affected checks for ${paths.length} changed paths`,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      full: { type: "boolean", default: false },
      base: { type: "string" },
      affected: { type: "string" },
    },
  });
  try {
    process.stdout.write(`${JSON.stringify(select(values))}\n`);
  } catch (error) {
    console.error(
      `Change selection unavailable; running full CI: ${error.message}`,
    );
    process.stdout.write(`${JSON.stringify(full)}\n`);
  }
}
