import { readFile, stat } from "node:fs/promises";
import { createHash, createHmac } from "node:crypto";
import { join } from "node:path";
import {
  getPluginSettingsValues,
  setPluginSettingsValues,
  type DbConnection,
} from "@bb/db";
import type {
  PluginSettingDescriptor,
  PluginSettingDescriptors,
  PluginSettingValue,
} from "@get-bb/plugin-sdk";
import { coerceStoredPluginSettingValue } from "@get-bb/plugin-sdk/internal/host-policy";
import type { PluginSettingDescriptor as PublicPluginSettingDescriptor } from "@bb/server-contract";
import {
  deleteSecretFile,
  readOrCreateSecretFile,
  writeSecretFile,
} from "@bb/secret-storage";

export class PluginSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginSettingsValidationError";
  }
}

export class PluginSettingsConflictError extends Error {
  readonly code = "plugin_settings_conflict";
  constructor() {
    super("Plugin settings changed since they were read");
    this.name = "PluginSettingsConflictError";
  }
}

const storeLocks = new WeakMap<DbConnection, Map<string, Promise<void>>>();

async function withStoreLock<T>(
  args: PluginSettingsStoreArgs,
  run: () => Promise<T>,
): Promise<T> {
  let locks = storeLocks.get(args.db);
  if (!locks) {
    locks = new Map();
    storeLocks.set(args.db, locks);
  }
  const previous = locks.get(args.pluginId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(args.pluginId, current);
  await previous;
  try {
    return await run();
  } finally {
    release();
    if (locks.get(args.pluginId) === current) locks.delete(args.pluginId);
  }
}

async function storedSettingsDigest(
  args: PluginSettingsStoreArgs,
): Promise<string> {
  const stored = getPluginSettingsValues(args.db, args.pluginId);
  const entries: Array<[string, unknown]> = Object.keys(stored)
    .sort()
    .map((key) => [key, stored[key]]);
  const secrets: Array<[string, unknown]> = [];
  for (const key of Object.keys(args.descriptors).sort()) {
    if (!isSecret(args.descriptors[key])) continue;
    try {
      const secret = await readFile(
        secretFilePath(args.dataDir, args.pluginId, key),
        "utf8",
      );
      const versionKey = await readOrCreateSecretFile({
        dataDir: join(args.dataDir, "plugins"),
        fileName: ".settings-digest-key",
        bytes: 32,
        encoding: "hex",
      });
      const version = createHmac("sha256", versionKey)
        .update(JSON.stringify([args.pluginId, key, secret]))
        .digest("hex");
      secrets.push([key, { present: true, version }]);
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
      secrets.push([key, { present: false }]);
    }
  }
  return createHash("sha256")
    .update(JSON.stringify([args.pluginId, entries, secrets]))
    .digest("hex");
}

export function pluginSecretsDir(dataDir: string, pluginId: string): string {
  return join(dataDir, "plugins", pluginId, "secrets");
}

function secretFilePath(
  dataDir: string,
  pluginId: string,
  key: string,
): string {
  return join(pluginSecretsDir(dataDir, pluginId), key);
}

function isSecret(descriptor: PluginSettingDescriptor): boolean {
  return descriptor.type === "string" && descriptor.secret === true;
}

export async function readSecret(
  dataDir: string,
  pluginId: string,
  key: string,
): Promise<string | undefined> {
  try {
    return await readFile(secretFilePath(dataDir, pluginId, key), "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return undefined;
    throw error;
  }
}

interface PluginSettingsStoreArgs {
  db: DbConnection;
  dataDir: string;
  pluginId: string;
  descriptors: PluginSettingDescriptors;
}

function parseStoredSettingValue(
  descriptor: PluginSettingDescriptor,
  raw: string | undefined,
): PluginSettingValue | undefined {
  let parsed: unknown;
  if (raw !== undefined) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
  }
  return coerceStoredPluginSettingValue(descriptor, parsed);
}

export function readPluginSettingsValuesSync(
  args: Omit<PluginSettingsStoreArgs, "dataDir">,
): Record<string, PluginSettingValue | undefined> {
  const stored = getPluginSettingsValues(args.db, args.pluginId);
  const values: Record<string, PluginSettingValue | undefined> = {};
  for (const [key, descriptor] of Object.entries(args.descriptors)) {
    if (isSecret(descriptor)) continue;
    values[key] = parseStoredSettingValue(
      descriptor,
      Object.hasOwn(stored, key) ? stored[key] : undefined,
    );
  }
  return values;
}

export async function readPluginSettingsValues(
  args: PluginSettingsStoreArgs,
): Promise<Record<string, PluginSettingValue | undefined>> {
  const values = readPluginSettingsValuesSync(args);
  for (const [key, descriptor] of Object.entries(args.descriptors)) {
    if (!isSecret(descriptor)) continue;
    values[key] =
      (await readSecret(args.dataDir, args.pluginId, key)) ??
      descriptor.default;
  }
  return values;
}

export async function writePluginSettingsUpdate(
  args: PluginSettingsStoreArgs & {
    values: Record<string, unknown>;
    expectedDigest?: string;
  },
): Promise<void> {
  return withStoreLock(args, async () => {
    if (
      args.expectedDigest !== undefined &&
      args.expectedDigest !== (await storedSettingsDigest(args))
    ) {
      throw new PluginSettingsConflictError();
    }
    const rowUpdates: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(args.values)) {
      const descriptor = Object.hasOwn(args.descriptors, key)
        ? args.descriptors[key]
        : undefined;
      if (!descriptor) continue;
      if (isSecret(descriptor)) {
        const path = secretFilePath(args.dataDir, args.pluginId, key);
        if (value === null) await deleteSecretFile(path);
        else await writeSecretFile(path, value as string);
        continue;
      }
      rowUpdates[key] = value === null ? null : JSON.stringify(value);
    }
    if (Object.keys(rowUpdates).length > 0) {
      setPluginSettingsValues(args.db, args.pluginId, rowUpdates);
    }
  });
}

export interface PluginSettingsView {
  digest: string;
  schema: Record<string, PublicPluginSettingDescriptor>;
  values: Record<string, unknown>;
}

function publicSettingDescriptor(
  descriptor: PluginSettingDescriptor,
): PublicPluginSettingDescriptor {
  const publicDescriptor = { ...descriptor };
  delete publicDescriptor.experimental_schema;
  return publicDescriptor;
}

export async function buildPluginSettingsView(
  args: PluginSettingsStoreArgs,
): Promise<PluginSettingsView> {
  return withStoreLock(args, async () => {
    const effective = await readPluginSettingsValues(args);
    const values: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(args.descriptors)) {
      if (isSecret(descriptor)) {
        values[key] = {
          set: await stat(secretFilePath(args.dataDir, args.pluginId, key))
            .then(() => true)
            .catch(() => false),
        };
      } else if (effective[key] !== undefined) {
        values[key] = effective[key];
      }
    }
    return {
      digest: await storedSettingsDigest(args),
      schema: Object.fromEntries(
        Object.entries(args.descriptors).map(([key, descriptor]) => [
          key,
          publicSettingDescriptor(descriptor),
        ]),
      ),
      values,
    };
  });
}
