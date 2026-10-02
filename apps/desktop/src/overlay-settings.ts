import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  overlaySettingsSchema,
  type OverlaySettings,
} from "./overlay-contract.js";

interface OverlaySettingsFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, encoding: "utf8"): Promise<void>;
}

const defaultFs: OverlaySettingsFs = { mkdir, readFile, writeFile };

interface CreateOverlaySettingsStoreArgs {
  fs?: OverlaySettingsFs;
  storagePath: string;
}

export interface OverlaySettingsStore {
  get(): OverlaySettings;
  load(): Promise<void>;
  save(settings: OverlaySettings): Promise<void>;
}

function parseOverlaySettings(raw: string): OverlaySettings | null {
  try {
    const parsed = overlaySettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function createOverlaySettingsStore(
  args: CreateOverlaySettingsStoreArgs,
): OverlaySettingsStore {
  const fsImpl = args.fs ?? defaultFs;
  let settings = overlaySettingsSchema.parse({});
  return {
    get() {
      return { ...settings };
    },
    async load() {
      try {
        settings =
          parseOverlaySettings(
            await fsImpl.readFile(args.storagePath, "utf8"),
          ) ?? overlaySettingsSchema.parse({});
      } catch {
        settings = overlaySettingsSchema.parse({});
      }
    },
    async save(next) {
      const validated = overlaySettingsSchema.parse(next);
      await fsImpl.mkdir(dirname(args.storagePath), { recursive: true });
      await fsImpl.writeFile(
        args.storagePath,
        `${JSON.stringify(validated, null, 2)}\n`,
        "utf8",
      );
      settings = validated;
    },
  };
}
