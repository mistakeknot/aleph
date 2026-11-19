import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
  stat,
  rename,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import {
  prepareSource,
  sourceManifest,
  copySkill,
  prepareDependencies,
  treeDigest,
} from "./sources.js";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const reference = z.strictObject({
  secretRef: z
    .string()
    .regex(/^(env:[A-Z_][A-Z0-9_]*|store:[A-Za-z0-9._/-]+)$/u),
});
type Value =
  | null
  | boolean
  | number
  | string
  | { [key: string]: Value }
  | Value[];
const value: z.ZodType<Value> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(value),
    z.record(z.string(), value),
  ]),
);
const settings = z.record(z.string(), value);
const source = z.union([
  z.strictObject({ builtin: name }),
  z.strictObject({ path: z.string().min(1) }),
  z.strictObject({
    git: z.url(),
    ref: z.string().regex(/^[0-9a-f]{40}$/u),
    subdir: z.string().default("."),
  }),
  z.strictObject({
    npm: z.string().regex(/^(@[a-z0-9-]+\/)?[a-z0-9-]+$/u),
    version: z.string().regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u),
  }),
]);
const agent = z.strictObject({ settings, hooks: settings });
export const rigSchema = z.strictObject({
  apiVersion: z.literal("bb.rig/v1"),
  kind: z.literal("Rig"),
  metadata: z.strictObject({ name }),
  compatibility: z.strictObject({ extensionPoints: z.array(z.string()) }),
  plugins: z.array(
    z.strictObject({
      id: name,
      source,
      version: z.string().min(1),
      enabled: z.boolean(),
      settings,
      requires: z.array(z.string()).default([]),
    }),
  ),
  skills: z.array(
    z.strictObject({
      id: name,
      source,
      targets: z.array(z.enum(["bb", "claude", "codex", "agents"])).min(1),
    }),
  ),
  agents: z.strictObject({ claude: agent, codex: agent }),
  accountPool: z.strictObject({
    settings,
    accounts: z.array(
      z.strictObject({
        id: name,
        provider: z.enum(["claude", "codex"]),
        credential: reference,
        config: settings,
      }),
    ),
  }),
});
export type Rig = z.infer<typeof rigSchema>;
export interface Install {
  dataDir: string;
  agentHome: string;
  rigDir?: string;
  builtinRoot?: string;
}
export interface Change {
  section: string;
  entry: string;
  kind: "added" | "removed" | "changed";
}
export interface Result {
  changes: Change[];
  unsupported: string[];
}
const sensitiveKey =
  /(?:secret|password|passwd|credential|authorization|cookie|(?:^|[_-])auth(?:$|[_-])|token$|key$|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)/iu;
const suspicious =
  /(?:\bBearer\s+\S+|\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+|-----BEGIN.*PRIVATE KEY|[A-Za-z0-9+/=_-]{48,}|(?:password|token|secret|api[_-]?key)\s*[=:]\s*\S+)/iu;
function isRef(v: Value): v is { secretRef: string } {
  return reference.safeParse(v).success;
}
function unsafeString(v: string, key = ""): boolean {
  if (
    suspicious.test(v) &&
    !(
      key === "path" &&
      !/(?:Bearer|(?:sk|ghp|github_pat)[-_]|password=|token=)/iu.test(v)
    )
  )
    return true;
  try {
    const u = new URL(v);
    return Boolean(u.username || u.password || u.search || u.hash);
  } catch {
    return false;
  }
}
function verifyValues(v: Value, key = ""): void {
  if (isRef(v)) return;
  if (sensitiveKey.test(key) && v !== null)
    throw new Error("Sensitive fields require a named secret reference");
  if (typeof v === "string" && unsafeString(v, key))
    throw new Error("Inline secret-like value rejected; use a named reference");
  if (Array.isArray(v)) {
    for (const child of v) verifyValues(child);
  } else if (v && typeof v === "object")
    for (const [k, child] of Object.entries(v)) {
      if (
        /[\r\n\x00\x1b]/u.test(k) ||
        unsafeString(k) ||
        ["__proto__", "constructor", "prototype"].includes(k)
      )
        throw new Error("Unsafe configuration key");
      verifyValues(child, k);
    }
}
export function parseRig(input: unknown): Rig {
  const parsed = rigSchema.safeParse(input);
  if (!parsed.success) throw new Error("Invalid rig schema");
  const rig = parsed.data;
  for (const provider of ["claude", "codex"] as const)
    if ("hooks" in rig.agents[provider].settings)
      throw new Error("Put hooks in the hooks section");
  rig.plugins.sort((a, b) => a.id.localeCompare(b.id));
  rig.skills.sort((a, b) => a.id.localeCompare(b.id));
  rig.accountPool.accounts.sort((a, b) => a.id.localeCompare(b.id));
  for (const skill of rig.skills) skill.targets.sort();
  verifyValues(rig);
  for (const entries of [rig.plugins, rig.skills, rig.accountPool.accounts]) {
    if (new Set(entries.map((e) => e.id)).size !== entries.length)
      throw new Error("Duplicate identity");
  }
  for (const entry of [...rig.plugins, ...rig.skills]) {
    if ("path" in entry.source && isAbsolute(entry.source.path))
      throw new Error("Source path must be relative");
    if ("git" in entry.source) safeRelative(entry.source.subdir);
  }
  return rig;
}
export async function loadRig(file: string): Promise<Rig> {
  try {
    return parseRig(
      parseYaml(await readFile(file, "utf8"), { maxAliasCount: 0 }),
    );
  } catch {
    throw new Error("Invalid rig file; values suppressed");
  }
}
export function formatRig(rig: Rig): string {
  return stringifyYaml(parseRig(rig));
}
export function schemaJson(): object {
  return z.toJSONSchema(rigSchema);
}
function safeRelative(p: string): void {
  if (isAbsolute(p) || p.split(/[\\/]/u).includes("..") || p.includes("\0"))
    throw new Error("Source path must be relative");
}
async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "code" in e &&
      (e.code === "ENOENT" || e.code === "ENOTDIR")
    )
      return false;
    throw new Error("Cannot inspect install");
  }
}
async function json(p: string): Promise<Value> {
  if (!(await exists(p))) return {};
  try {
    return value.parse(JSON.parse(await readFile(p, "utf8")));
  } catch {
    throw new Error("Cannot parse install configuration; values suppressed");
  }
}
function object(v: Value): Record<string, Value> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Expected configuration object");
  return v;
}
function refName(path: string): string {
  return `store:rig/${createHash("sha256").update(path).digest("hex").slice(0, 24)}`;
}
function sanitize(v: Value, path: string, refs: string[], key = ""): Value {
  if (isRef(v)) return v;
  if (
    (sensitiveKey.test(key) && v !== null) ||
    (typeof v === "string" && unsafeString(v, key))
  ) {
    const ref = refName(path);
    refs.push(`${path} -> ${ref}`);
    return { secretRef: ref };
  }
  if (Array.isArray(v))
    return v.map((child, i) => sanitize(child, `${path}/${i}`, refs));
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).map(([k, child]) => {
        if (
          /[\r\n\x00\x1b]/u.test(k) ||
          unsafeString(k) ||
          ["__proto__", "constructor", "prototype"].includes(k)
        )
          throw new Error("Unsafe configuration key; export refused");
        return [k, sanitize(child, `${path}/${k}`, refs, k)];
      }),
    );
  return v;
}
function openDb(dataDir: string): DatabaseSync {
  return new DatabaseSync(join(dataDir, "bb.db"), { readOnly: true });
}
function rows(
  db: DatabaseSync,
  sql: string,
  ...params: (string | number)[]
): Record<string, Value>[] {
  return db
    .prepare(sql)
    .all(...params)
    .map((row) => object(value.parse(row)));
}
function text(v: Value | undefined): string {
  if (typeof v !== "string") throw new Error("Unsupported install schema");
  return v;
}
function decoded(v: Value | undefined): Value {
  try {
    return value.parse(JSON.parse(text(v)));
  } catch {
    throw new Error("Invalid stored configuration; values suppressed");
  }
}
function pluginSource(
  row: Record<string, Value>,
  rigDir: string,
): z.infer<typeof source> {
  if (row.source_kind === "builtin")
    return { builtin: text(row.source_builtin_name ?? row.id) };
  if (row.source_kind === "git" && typeof row.git_resolved_commit === "string")
    return {
      git: text(row.source_git_url),
      ref: row.git_resolved_commit,
      subdir:
        typeof row.source_git_subdirectory === "string"
          ? row.source_git_subdirectory
          : ".",
    };
  if (row.source_kind === "npm")
    return {
      npm: text(row.source_npm_package),
      version: text(row.npm_resolved_version ?? row.version),
    };
  const p = relative(rigDir, text(row.root_dir));
  return { path: p || "." };
}
async function readAgent(
  home: string,
  provider: "claude" | "codex",
): Promise<z.infer<typeof agent>> {
  const path = join(
    home,
    `.${provider}`,
    provider === "claude" ? "settings.json" : "config.toml",
  );
  let raw: Record<string, Value> = {};
  if (await exists(path)) {
    try {
      raw = object(
        value.parse(
          provider === "claude"
            ? JSON.parse(await readFile(path, "utf8"))
            : parseToml(await readFile(path, "utf8")),
        ),
      );
    } catch {
      throw new Error("Invalid provider configuration; values suppressed");
    }
  }
  const { hooks: embeddedHooks = {}, ...settings } = raw;
  const hooks =
    provider === "codex" && (await exists(join(home, ".codex/hooks.json")))
      ? await json(join(home, ".codex/hooks.json"))
      : embeddedHooks;
  return { settings, hooks: object(hooks) };
}
export async function exportRig(
  install: Install,
): Promise<{ rig: Rig; references: string[] }> {
  const refs: string[] = [];
  const managed = await readManaged(install.dataDir);
  if (!(await exists(join(install.dataDir, "bb.db")))) {
    const rig = parseRig(
      sanitize(
        {
          apiVersion: "bb.rig/v1",
          kind: "Rig",
          metadata: { name: "exported" },
          compatibility: { extensionPoints: [] },
          plugins: [],
          skills: [],
          agents: {
            claude: await readAgent(install.agentHome, "claude"),
            codex: await readAgent(install.agentHome, "codex"),
          },
          accountPool: { settings: {}, accounts: [] },
        },
        "rig",
        refs,
      ),
    );
    return { rig, references: refs };
  }
  const db = openDb(install.dataDir);
  try {
    const plugins: Rig["plugins"] = [];
    for (const row of rows(
      db,
      "SELECT * FROM plugins WHERE removed_at IS NULL ORDER BY id",
    )) {
      const id = text(row.id);
      const settings: Record<string, Value> = {};
      for (const setting of rows(
        db,
        "SELECT key,value FROM plugin_settings WHERE plugin_id=? ORDER BY key",
        id,
      ))
        settings[text(setting.key)] = decoded(setting.value);
      const secrets = join(install.dataDir, "plugins", id, "secrets");
      if (await exists(secrets))
        for (const entry of await readdir(secrets, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          const key = entry.name;
          if (!/^[A-Za-z0-9._-]+$/u.test(key))
            throw new Error("Unsafe secret name");
          const ref = refName(`plugins/${id}/${key}`);
          settings[key] = { secretRef: ref };
          refs.push(`plugins/${id}/${key} -> ${ref}`);
        }
      let saved = managed.plugins.find(
        (p) => p.id === id && p.root === row.root_dir,
      );
      if (saved && (await treeDigest(text(row.root_dir))) !== saved.digest)
        saved = undefined;
      plugins.push({
        id,
        source:
          saved?.source ?? pluginSource(row, install.rigDir ?? install.dataDir),
        version: text(row.version),
        enabled: row.enabled === 1,
        settings,
        requires: [],
      });
    }
    const accountPool: Rig["accountPool"] = { settings: {}, accounts: [] };
    if (plugins.some((p) => p.id === "account-pool")) {
      for (const row of rows(
        db,
        "SELECT key,value FROM plugin_kv WHERE plugin_id='account-pool' AND key IN ('config','accounts:v1') ORDER BY key",
      )) {
        if (row.key === "config")
          accountPool.settings = object(decoded(row.value));
        if (row.key === "accounts:v1") {
          const accounts = decoded(row.value);
          if (!Array.isArray(accounts))
            throw new Error("Invalid accounts metadata");
          for (const item of accounts) {
            const config = object(item);
            const id = text(config.id);
            const provider = z.enum(["claude", "codex"]).parse(config.provider);
            const { id: _id, provider: _provider, ...rest } = config;
            const ref = refName(`accountPool/${id}`);
            refs.push(`accountPool/${id}/credential -> ${ref}`);
            accountPool.accounts.push({
              id,
              provider,
              credential: { secretRef: ref },
              config: rest,
            });
          }
        }
      }
    }
    const skills: Rig["skills"] = [];
    for (const [target, root] of [
      ["bb", join(install.dataDir, "skills")],
      ["claude", join(install.agentHome, ".claude/skills")],
      ["codex", join(install.agentHome, ".codex/skills")],
      ["agents", join(install.agentHome, ".agents/skills")],
    ] as const) {
      if (!(await exists(root))) continue;
      for (const id of await skillDirectories(root)) {
        const skillPath = relative(
          install.rigDir ?? install.dataDir,
          await realpath(join(root, id)),
        );
        let saved = managed.skills.find(
          (s) => s.id === id && s.targets.includes(target),
        );
        if (saved && (await treeDigest(join(root, id))) !== saved.digest)
          saved = undefined;
        if (saved) {
          if (!skills.some((s) => s.id === saved.id))
            skills.push({
              id: saved.id,
              source: saved.source,
              targets: [target],
            });
          else skills.find((s) => s.id === saved.id)?.targets.push(target);
        } else
          skills.push({
            id: `${target}.${id.replaceAll("/", ".")}`,
            source: { path: skillPath },
            targets: [target],
          });
      }
    }
    let rig = parseRig(
      sanitize(
        {
          apiVersion: "bb.rig/v1",
          kind: "Rig",
          metadata: { name: "exported" },
          compatibility: { extensionPoints: [] },
          plugins,
          skills,
          agents: {
            claude: await readAgent(install.agentHome, "claude"),
            codex: await readAgent(install.agentHome, "codex"),
          },
          accountPool,
        },
        "rig",
        refs,
      ),
    );
    const bindingsPath = join(install.dataDir, "rig-secret-references.json");
    if (await exists(bindingsPath)) {
      const bindings = object(await json(bindingsPath));
      rig = parseRig(overlayReferences(rig, bindings));
    }
    return { rig, references: [...new Set(refs)].sort() };
  } finally {
    db.close();
  }
}
function canonical(v: Value): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k] ?? null)}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
function compare(a: Rig, b: Rig): Change[] {
  const changes: Change[] = [];
  for (const section of [
    "plugins",
    "skills",
    "agents",
    "accountPool",
  ] as const) {
    const entries = (rig: Rig): Record<string, Value> => {
      const v = rig[section];
      return Array.isArray(v) ? Object.fromEntries(v.map((e) => [e.id, e])) : v;
    };
    const actual = entries(a),
      desired = entries(b);
    for (const key of [
      ...new Set([...Object.keys(actual), ...Object.keys(desired)]),
    ].sort()) {
      if (canonical(actual[key] ?? null) === canonical(desired[key] ?? null))
        continue;
      changes.push({
        section,
        entry: key,
        kind: !(key in actual)
          ? "added"
          : !(key in desired)
            ? "removed"
            : "changed",
      });
    }
  }
  return changes;
}
export async function diffRig(rig: Rig, install: Install): Promise<Result> {
  const current = await exportRig(install);
  return { changes: compare(current.rig, parseRig(rig)), unsupported: [] };
}
function overlayReferences(
  v: Value,
  bindings: Record<string, Value>,
  path = "",
): Value {
  if (path in bindings) return bindings[path] ?? null;
  if (Array.isArray(v))
    return v.map((x, i) => overlayReferences(x, bindings, `${path}/${i}`));
  if (v && typeof v === "object") {
    const keys = new Set([
      ...Object.keys(v),
      ...Object.keys(bindings)
        .filter(
          (p) =>
            p.startsWith(`${path}/`) && !p.slice(path.length + 1).includes("/"),
        )
        .map((p) => p.slice(path.length + 1)),
    ]);
    return Object.fromEntries(
      [...keys].map((k) => [
        k,
        overlayReferences(v[k] ?? null, bindings, `${path}/${k}`),
      ]),
    );
  }
  return v;
}
function omitReferences(
  v: Value,
  bindings: Record<string, Value>,
  path = "",
): Value | undefined {
  if (isRef(v)) {
    bindings[path] = v;
    return undefined;
  }
  if (Array.isArray(v))
    return v.map(
      (child, i) => omitReferences(child, bindings, `${path}/${i}`) ?? null,
    );
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).flatMap(([k, child]) => {
        const childPath = `${path}/${k}`;
        if (
          containsRef(child) &&
          (/^\/agents\/(claude|codex)\/(settings|hooks)$/u.test(path) ||
            /^\/plugins\/\d+\/settings$/u.test(path) ||
            path === "/accountPool/settings")
        ) {
          bindings[childPath] = child;
          return [];
        }
        const plain = omitReferences(child, bindings, childPath);
        return plain === undefined ? [] : [[k, plain]];
      }),
    );
  return v;
}
function containsRef(v: Value): boolean {
  return (
    isRef(v) ||
    (Array.isArray(v)
      ? v.some(containsRef)
      : Boolean(
          v && typeof v === "object" && Object.values(v).some(containsRef),
        ))
  );
}
async function confined(root: string, path: string): Promise<void> {
  const rel = relative(root, resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel))
    throw new Error("Path outside target");
  let current = resolve(path);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1))
        throw new Error("Symlink or hardlink target refused");
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) throw new Error("Invalid target");
    current = parent;
  }
}
async function writeSafe(
  root: string,
  path: string,
  content: string,
): Promise<void> {
  await confined(root, path);
  await mkdir(dirname(path), { recursive: true });
  if ((await exists(path)) && (await readFile(path, "utf8")) === content)
    return;
  await writeFile(path, content, { mode: 0o600, flag: "w" });
}
export async function applyRig(
  input: Rig,
  install: Install & { target: string; dryRun: boolean },
): Promise<Result> {
  const rig = parseRig(input);
  validateHooks(rig);
  const target = resolve(install.target);
  if (target !== resolve(install.dataDir))
    throw new Error("Named target does not match install target");
  await confined(target, target);
  await confined(target, install.agentHome);
  if (await exists(join(target, "bb-app-runtime.json")))
    throw new Error("Running target refused");
  for (const name of ["bb.db", "bb.db-wal", "bb.db-shm"])
    await confined(target, join(target, name));
  const result = await diffRig(rig, install);
  const current = (await exportRig(install)).rig;
  if (await exists(join(target, "bb.db"))) {
    const probe = openDb(target);
    try {
      if (rows(probe, "SELECT id FROM threads LIMIT 1").length)
        throw new Error("Target is not fresh");
    } finally {
      probe.close();
    }
  }
  if (
    rig.compatibility.extensionPoints.length ||
    rig.plugins.some((p) => p.requires.length)
  )
    throw new Error("Target extension points cannot be verified");
  const unsupported: string[] = [];

  for (const plugin of rig.plugins) {
    if (
      "builtin" in plugin.source &&
      !current.plugins.some((p) => p.id === plugin.id) &&
      (!install.builtinRoot ||
        !(await exists(join(install.builtinRoot, plugin.source.builtin))))
    )
      unsupported.push(`plugins/${plugin.id}: builtin unavailable`);
  }

  const hasPool = rig.plugins.some(
    (p) =>
      p.id === "account-pool" &&
      !unsupported.some((item) => item.startsWith("plugins/account-pool:")),
  );
  if (
    !hasPool &&
    (Object.keys(rig.accountPool.settings).length ||
      rig.accountPool.accounts.length)
  )
    unsupported.push("accountPool");
  result.changes = result.changes.filter(
    (change) =>
      !(
        change.section === "accountPool" && unsupported.includes("accountPool")
      ) &&
      !(
        change.section === "plugins" &&
        unsupported.some((item) => item.startsWith(`plugins/${change.entry}:`))
      ),
  );
  const managed = await readManaged(target);
  const bindings: Record<string, Value> = {};
  const plain = object(omitReferences(rig, bindings) ?? {});
  if (Object.keys(bindings).length)
    unsupported.push(
      "secret references: activation requires native secret store",
    );
  result.unsupported = unsupported;
  for (const path of [
    join(target, "rig-managed.json"),
    join(target, "rig-secret-references.json"),
    join(target, "env.json"),
    join(install.agentHome, ".claude/settings.json"),
    join(install.agentHome, ".codex/config.toml"),
    join(install.agentHome, ".codex/hooks.json"),
    join(target, "rig-sources"),
    join(target, "skills"),
  ])
    await confined(target, path);
  const priorEnv = object(await json(join(target, "env.json")));
  if (
    Object.keys(priorEnv).some(
      (k) => k !== "CLAUDE_CONFIG_DIR" && k !== "CODEX_HOME",
    )
  )
    throw new Error("Existing target environment refused");
  if (install.dryRun) return result;
  if (!result.changes.length) return result;
  if (!(await exists(join(target, "bb.db")))) {
    await mkdir(target, { recursive: true });
    const { createConnection, migrate } = await import("@bb/db");
    const connection = createConnection(join(target, "bb.db"));
    try {
      migrate(connection);
    } finally {
      connection.$client.close();
    }
  }
  const { createConnection, upsertInstalledPlugin } = await import("@bb/db");
  const connection = createConnection(join(target, "bb.db"));
  const db = connection.$client;
  try {
    db.exec("BEGIN IMMEDIATE");
    for (const plugin of rig.plugins) {
      if (unsupported.some((item) => item.startsWith(`plugins/${plugin.id}:`)))
        continue;
      const existing = current.plugins.find((p) => p.id === plugin.id);
      if (
        !existing ||
        canonical(existing.source) !== canonical(plugin.source) ||
        existing.version !== plugin.version
      ) {
        const root = await prepareSource(plugin.source, {
          rigDir: install.rigDir ?? target,
          destination: join(
            target,
            "rig-sources",
            `${plugin.id}-${Date.now()}`,
          ),
          ...(install.builtinRoot ? { builtinRoot: install.builtinRoot } : {}),
        });
        const manifest = await sourceManifest(root);
        if (manifest.version !== plugin.version)
          throw new Error("Plugin version mismatch");
        if (!("builtin" in plugin.source)) await prepareDependencies(root);
        const kind = "builtin" in plugin.source ? "builtin" : "path";
        managed.plugins = managed.plugins.filter((p) => p.id !== plugin.id);
        managed.plugins.push({
          id: plugin.id,
          root,
          source: plugin.source,
          digest: await treeDigest(root),
        });
        upsertInstalledPlugin(connection, {
          id: plugin.id,
          source:
            kind === "builtin"
              ? `builtin:${"builtin" in plugin.source ? plugin.source.builtin : plugin.id}`
              : `path:${root}`,
          provenance: { kind: kind === "builtin" ? "builtin" : "direct" },
          sourceIntent:
            "builtin" in plugin.source
              ? { kind: "builtin", name: plugin.source.builtin }
              : { kind: "path", canonicalPath: root },
          exactResolution: { kind: kind === "builtin" ? "builtin" : "path" },
          updateState: {
            lastCheckAt: null,
            availableCompatibleVersion: null,
            newestIncompatibleVersion: null,
            statusDetail: null,
          },
          activeArtifactId: null,
          rootDir: root,
          version: plugin.version,
          enabled: plugin.enabled,
          enabledFollowsDefault: false,
        });
      }
      db.prepare("UPDATE plugins SET enabled=?,updated_at=? WHERE id=?").run(
        plugin.enabled ? 1 : 0,
        Date.now(),
        plugin.id,
      );
      db.prepare("DELETE FROM plugin_settings WHERE plugin_id=?").run(
        plugin.id,
      );
      for (const [key, v] of Object.entries(plugin.settings)) {
        if (containsRef(v)) continue;
        db.prepare(
          "INSERT INTO plugin_settings(plugin_id,key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        ).run(plugin.id, key, JSON.stringify(v), Date.now());
      }
    }
    for (const plugin of current.plugins)
      if (!rig.plugins.some((p) => p.id === plugin.id))
        db.prepare(
          "UPDATE plugins SET enabled=0,removed_at=?,updated_at=? WHERE id=?",
        ).run(Date.now(), Date.now(), plugin.id);
    if (hasPool) {
      for (const [key, v] of [
        ["config", object(object(plain.accountPool ?? {}).settings ?? {})],
        [
          "accounts:v1",
          rig.accountPool.accounts.map((a) => ({
            ...a.config,
            id: a.id,
            provider: a.provider,
          })),
        ],
      ] as const) {
        if (containsRef(v))
          throw new Error("Account metadata cannot contain references");
        db.prepare(
          "INSERT INTO plugin_kv(plugin_id,key,value,updated_at) VALUES('account-pool',?,?,?) ON CONFLICT(plugin_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        ).run(key, JSON.stringify(v), Date.now());
      }
    }
    for (const existing of current.skills) {
      const desired = rig.skills.find((s) => s.id === existing.id);
      for (const provider of existing.targets) {
        if (desired?.targets.includes(provider)) continue;
        const root =
          provider === "bb"
            ? join(target, "skills")
            : join(install.agentHome, `.${provider}`, "skills");
        const name = managed.skills.some((s) => s.id === existing.id)
          ? existing.id
          : existing.id.slice(provider.length + 1).replaceAll(".", "/");
        const destination = join(root, name);
        await confined(target, destination);
        if (await exists(destination)) {
          const retained = join(
            target,
            "rig-retained",
            `${existing.id}-${provider}-${Date.now()}`,
          );
          await confined(target, retained);
          await mkdir(dirname(retained), { recursive: true });
          await rename(destination, retained);
        }
      }
    }
    managed.skills = managed.skills.filter((s) =>
      rig.skills.some((desired) => desired.id === s.id),
    );
    for (const skill of rig.skills) {
      const existing = current.skills.find((s) => s.id === skill.id);
      if (existing && canonical(existing) === canonical(skill)) continue;
      const root = await prepareSource(skill.source, {
        rigDir: install.rigDir ?? target,
        destination: join(target, "rig-sources", `${skill.id}-${Date.now()}`),
      });
      managed.skills = managed.skills.filter((s) => s.id !== skill.id);
      managed.skills.push({ ...skill, digest: await treeDigest(root) });
      for (const provider of skill.targets) {
        const destination =
          provider === "bb"
            ? join(target, "skills", skill.id)
            : join(install.agentHome, `.${provider}`, "skills", skill.id);
        await confined(target, destination);
        if (await exists(destination)) {
          const retained = join(
            target,
            "rig-retained",
            `${skill.id}-${provider}-${Date.now()}`,
          );
          await confined(target, retained);
          await mkdir(dirname(retained), { recursive: true });
          await rename(destination, retained);
        }
        await copySkill(root, destination);
      }
    }
    const agents = object(plain.agents ?? {});
    for (const provider of ["claude", "codex"] as const) {
      const config = object(agents[provider] ?? {});
      const body = {
        ...object(config.settings ?? {}),
        ...(provider === "claude" &&
        Object.keys(object(config.hooks ?? {})).length
          ? { hooks: config.hooks }
          : {}),
      };
      if (
        Object.keys(body).length ||
        (await exists(
          join(
            install.agentHome,
            `.${provider}`,
            provider === "claude" ? "settings.json" : "config.toml",
          ),
        ))
      )
        await writeSafe(
          target,
          join(
            install.agentHome,
            `.${provider}`,
            provider === "claude" ? "settings.json" : "config.toml",
          ),
          provider === "claude"
            ? JSON.stringify(body, null, 2) + "\n"
            : stringifyToml(body),
        );
      if (
        provider === "codex" &&
        (Object.keys(object(config.hooks ?? {})).length ||
          (await exists(join(install.agentHome, ".codex/hooks.json"))))
      )
        await writeSafe(
          target,
          join(install.agentHome, ".codex/hooks.json"),
          JSON.stringify(config.hooks ?? {}, null, 2) + "\n",
        );
    }
    const env = object(await json(join(target, "env.json")));
    if (
      Object.keys(env).some(
        (k) => k !== "CLAUDE_CONFIG_DIR" && k !== "CODEX_HOME",
      )
    )
      throw new Error("Existing target environment refused");
    await writeSafe(
      target,
      join(target, "rig-managed.json"),
      JSON.stringify(managed, null, 2) + "\n",
    );
    await writeSafe(
      target,
      join(target, "env.json"),
      JSON.stringify(
        {
          ...env,
          CLAUDE_CONFIG_DIR: join(install.agentHome, ".claude"),
          CODEX_HOME: join(install.agentHome, ".codex"),
        },
        null,
        2,
      ) + "\n",
    );
    await writeSafe(
      target,
      join(target, "rig-secret-references.json"),
      JSON.stringify(bindings, null, 2) + "\n",
    );
    db.exec("COMMIT");
  } catch {
    db.exec("ROLLBACK");
    throw new Error("Apply failed; values suppressed");
  } finally {
    db.close();
  }
  return result;
}

const managedSchema = z.strictObject({
  plugins: z.array(
    z.strictObject({
      id: name,
      root: z.string(),
      source,
      digest: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
  ),
  skills: z.array(
    rigSchema.shape.skills.element.extend({
      digest: z.string().regex(/^[0-9a-f]{64}$/u),
    }),
  ),
});
async function readManaged(
  root: string,
): Promise<z.infer<typeof managedSchema>> {
  if (!(await exists(join(root, "rig-managed.json"))))
    return { plugins: [], skills: [] };
  const parsed = managedSchema.safeParse(
    await json(join(root, "rig-managed.json")),
  );
  if (!parsed.success) throw new Error("Invalid managed source map");
  return parsed.data;
}

async function skillDirectories(
  root: string,
  prefix = "",
  seen = new Set<string>(),
  depth = 0,
): Promise<string[]> {
  if (depth > 8) return [];
  const canonical = await realpath(root);
  if (seen.has(canonical)) return [];
  seen.add(canonical);
  const found: string[] = [];
  for (const id of (await readdir(root)).sort()) {
    if (id === "node_modules" || id === ".git") continue;
    const child = join(root, id);
    const rel = prefix ? `${prefix}/${id}` : id;
    if (await exists(join(child, "SKILL.md"))) found.push(rel);
    else {
      try {
        if ((await exists(child)) && (await stat(child)).isDirectory())
          found.push(...(await skillDirectories(child, rel, seen, depth + 1)));
      } catch {
        throw new Error("Cannot inspect skill directory");
      }
    }
  }
  return found;
}

function validateHooks(rig: Rig): void {
  const claude = new Set(
    "PreToolUse PostToolUse PostToolUseFailure PostToolBatch Notification UserPromptSubmit UserPromptExpansion SessionStart SessionEnd Stop StopFailure SubagentStart SubagentStop PreCompact PostCompact PreModelSwitch PostModelSwitch PermissionRequest PermissionDenied Setup TeammateIdle TaskCreated TaskCompleted Elicitation ElicitationResult ConfigChange WorktreeCreate WorktreeRemove InstructionsLoaded CwdChanged FileChanged DirectoryAdded MessageDisplay".split(
      " ",
    ),
  );
  const codex = new Set(
    "preToolUse permissionRequest postToolUse preCompact postCompact sessionStart sessionEnd userPromptSubmit subagentStart subagentStop stop".split(
      " ",
    ),
  );
  for (const provider of ["claude", "codex"] as const) {
    const raw = rig.agents[provider].hooks;
    const events =
      provider === "codex" && "hooks" in raw ? object(raw.hooks ?? {}) : raw;
    for (const [event, handlers] of Object.entries(events)) {
      const normalized = event.slice(0, 1).toLowerCase() + event.slice(1);
      if (
        !(provider === "claude" ? claude.has(event) : codex.has(normalized)) ||
        !Array.isArray(handlers)
      )
        throw new Error("Unsupported native hook event or structure");
    }
  }
}
