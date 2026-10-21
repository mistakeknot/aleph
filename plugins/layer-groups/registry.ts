import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { z } from "zod";
import { layerAccent } from "./accent";

export interface Layer {
  key: string;
  letter: string;
  name: string;
  rank: number | null;
  order: number;
  accent: string;
}

export interface Hull {
  slug: string | null;
  project: string | null;
  layer: string;
}

export interface LayerSnapshot {
  catalogVersion: "4";
  sha256: string;
  commit: string | null;
  dirty: boolean | null;
  readAt: number;
  layers: Layer[];
  hulls: Hull[];
}

export type RegistryReadResult =
  | { kind: "fresh"; snapshot: LayerSnapshot }
  | { kind: "unchanged"; snapshot: LayerSnapshot }
  | { kind: "stale"; snapshot: LayerSnapshot; ageMs: number; error: string }
  | { kind: "unavailable"; error: string };

export interface GitInfo {
  commit: string | null;
  dirty: boolean | null;
}

const EXPECTED_LETTERS = [..."ABCDEFGHIJKX"];
const registrySchema = z.object({
  catalogVersion: z.literal("4"),
  layers: z
    .array(
      z.object({
        letter: z.string(),
        name: z.string(),
        rank: z.number().nullable(),
      }),
    )
    .refine((layers) => {
      const letters = new Set(layers.map((layer) => layer.letter));
      return (
        layers.length === EXPECTED_LETTERS.length &&
        letters.size === EXPECTED_LETTERS.length &&
        EXPECTED_LETTERS.every((letter) => letters.has(letter))
      );
    }, "Expected exactly the layers A..K and X"),
  entries: z.array(
    z
      .object({
        slug: z.string().nullable(),
        project: z.string().nullable(),
        layer: z
          .string()
          .refine(
            (letter) =>
              letter === "STUDIO" || EXPECTED_LETTERS.includes(letter),
            "Unknown layer",
          ),
      })
      .passthrough(),
  ),
});

export function parseRegistry(
  raw: Buffer,
  meta: { sha256: string; readAt: number } & GitInfo,
): LayerSnapshot {
  const registry = registrySchema.parse(JSON.parse(raw.toString("utf8")));
  const layers: Layer[] = registry.layers
    .sort((a, b) => {
      if (a.rank === null && b.rank === null)
        return a.letter.localeCompare(b.letter);
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    })
    .map((layer, i) => ({
      ...layer,
      key: layer.letter,
      order: i + 1,
      accent: layerAccent(layer.letter),
    }));
  layers.push({
    key: "STUDIO",
    letter: "GSV",
    name: "Studio",
    rank: null,
    order: layers.length + 1,
    accent: layerAccent("STUDIO"),
  });
  return {
    catalogVersion: registry.catalogVersion,
    ...meta,
    layers,
    hulls: registry.entries.map(({ slug, project, layer }) => ({
      slug,
      project,
      layer,
    })),
  };
}

export async function readRegistry(args: {
  path: string;
  lastGood: LayerSnapshot | null;
  now: number;
  readFile?: (path: string) => Promise<Buffer>;
  gitInfo?: (path: string) => Promise<GitInfo>;
}): Promise<RegistryReadResult> {
  try {
    const raw = await (args.readFile ?? readFile)(args.path);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    if (args.lastGood?.sha256 === sha256) {
      return { kind: "unchanged", snapshot: args.lastGood };
    }
    let git: GitInfo;
    try {
      git = await (args.gitInfo ?? defaultGitInfo)(args.path);
    } catch {
      git = { commit: null, dirty: null };
    }
    const snapshot = parseRegistry(raw, { sha256, readAt: args.now, ...git });
    return { kind: "fresh", snapshot };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return args.lastGood
      ? {
          kind: "stale",
          snapshot: args.lastGood,
          ageMs: args.now - args.lastGood.readAt,
          error,
        }
      : { kind: "unavailable", error };
  }
}

export type ExecFileFn = (
  file: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    encoding: "utf8";
    timeout: number;
    killSignal: "SIGKILL";
  },
  callback: (error: Error | null, stdout: string, stderr: string) => void,
) => void;

export async function defaultGitInfo(
  path: string,
  exec: ExecFileFn = execFile,
): Promise<GitInfo> {
  const separator = path.lastIndexOf("/");
  const dir = separator < 0 ? "." : path.slice(0, separator) || "/";
  const base = path.slice(separator + 1);
  const run = (args: string[]) =>
    new Promise<string>((resolve, reject) => {
      exec(
        "git",
        ["-C", dir, ...args, "--", base],
        {
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
          encoding: "utf8",
          timeout: 5000,
          killSignal: "SIGKILL",
        },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout.trim());
        },
      );
    });
  try {
    const commit = await run(["log", "-1", "--format=%H"]);
    const status = await run(["status", "--porcelain"]);
    return { commit: commit || null, dirty: status.length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}
