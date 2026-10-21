import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defaultGitInfo,
  parseRegistry,
  readRegistry,
  type ExecFileFn,
} from "./registry";

const raw = readFileSync(
  new URL("./test/fixtures/registry-v4.json", import.meta.url),
);
const fixture = z
  .object({
    catalogVersion: z.string(),
    layers: z.array(
      z.object({
        letter: z.string(),
        name: z.string(),
        rank: z.number().nullable(),
      }),
    ),
    entries: z.array(
      z
        .object({
          slug: z.string().nullable(),
          project: z.string().nullable(),
          layer: z.string(),
        })
        .passthrough(),
    ),
  })
  .parse(JSON.parse(raw.toString("utf8")));
const sha256 = createHash("sha256").update(raw).digest("hex");
const meta = { sha256, readAt: 1000, commit: "abc123", dirty: true };
const path = "/synthetic/registry.json";

function read(bytes = raw) {
  return readRegistry({
    path,
    lastGood: null,
    now: meta.readAt,
    readFile: async () => bytes,
    gitInfo: async () => ({ commit: meta.commit, dirty: meta.dirty }),
  });
}

describe("registry snapshots", () => {
  it("reads a fresh snapshot with ordered taxonomy and provenance", async () => {
    const result = await read();
    expect(result.kind).toBe("fresh");
    if (result.kind !== "fresh") throw new Error("Expected fresh snapshot");
    expect(result.snapshot).toMatchObject({ catalogVersion: "4", ...meta });
    expect(result.snapshot.layers.map((layer) => layer.key)).toEqual([
      ..."ABCDEFGHIJKX",
      "STUDIO",
    ]);
    expect(result.snapshot.layers.map((layer) => layer.order)).toEqual(
      Array.from({ length: 13 }, (_, i) => i + 1),
    );
    expect(result.snapshot.layers.slice(0, 12)).toEqual(
      fixture.layers.map((layer, i) => ({
        ...layer,
        key: layer.letter,
        order: i + 1,
        accent: expect.stringMatching(/^#[0-9a-f]{6}$/),
      })),
    );
    expect(result.snapshot.layers[12]).toEqual({
      key: "STUDIO",
      letter: "GSV",
      name: "Studio",
      rank: null,
      order: 13,
      accent: "#d9b38c",
    });
    expect(result.snapshot.hulls).toEqual(
      fixture.entries.map(({ slug, project, layer }) => ({
        slug,
        project,
        layer,
      })),
    );
    for (const hull of result.snapshot.hulls) {
      expect(Object.keys(hull).sort()).toEqual(["layer", "project", "slug"]);
    }
  });

  it("returns the last snapshot unchanged for identical bytes", async () => {
    const lastGood = parseRegistry(raw, meta);
    const result = await readRegistry({
      path,
      lastGood,
      now: 6000,
      readFile: async () => raw,
      gitInfo: async () => {
        throw new Error("git unavailable");
      },
    });
    expect(result).toEqual({ kind: "unchanged", snapshot: lastGood });
    if (result.kind !== "unchanged")
      throw new Error("Expected unchanged snapshot");
    expect(result.snapshot).toBe(lastGood);
  });

  it("sorts ranked layers before unranked layers regardless of input order", () => {
    const input = structuredClone(fixture);
    input.layers.reverse();
    const a = input.layers.find((layer) => layer.letter === "A");
    if (!a) throw new Error("Missing A");
    a.rank = null;
    expect(
      parseRegistry(Buffer.from(JSON.stringify(input)), meta).layers.map(
        (layer) => layer.key,
      ),
    ).toEqual([..."BCDEFGHIJKA", "X", "STUDIO"]);
  });

  it("keeps a fresh snapshot when git metadata fails", async () => {
    const result = await readRegistry({
      path,
      lastGood: null,
      now: 1000,
      readFile: async () => raw,
      gitInfo: async () => {
        throw new Error("git unavailable");
      },
    });
    expect(result).toMatchObject({
      kind: "fresh",
      snapshot: { commit: null, dirty: null },
    });
  });
});

const invalidInputs = [
  ["invalid JSON", Buffer.from("{")],
  ["unsupported version", { ...fixture, catalogVersion: "5" }],
  [
    "unknown entry layer",
    { ...fixture, entries: [{ slug: "invented", project: null, layer: "Z" }] },
  ],
  [
    "extra layer",
    {
      ...fixture,
      layers: [...fixture.layers, { letter: "Z", name: "Extra", rank: null }],
      entries: [{ slug: null, project: null, layer: "Z" }],
    },
  ],
  [
    "missing layer",
    {
      ...fixture,
      layers: fixture.layers.filter((layer) => layer.letter !== "F"),
      entries: fixture.entries.filter((entry) => entry.layer !== "F"),
    },
  ],
  [
    "registry STUDIO layer",
    {
      ...fixture,
      layers: [
        ...fixture.layers,
        { letter: "STUDIO", name: "Studio", rank: null },
      ],
    },
  ],
  [
    "duplicate letter",
    { ...fixture, layers: [...fixture.layers, fixture.layers[0]] },
  ],
  ["missing slug", { ...fixture, entries: [{ project: null, layer: "A" }] }],
  ["missing project", { ...fixture, entries: [{ slug: null, layer: "A" }] }],
] as const;

describe("registry failures", () => {
  const failures = [
    {
      name: "missing file",
      readFile: async (): Promise<Buffer> => {
        throw new Error("ENOENT");
      },
    },
    ...invalidInputs.map(([name, input]) => ({
      name,
      readFile: async () =>
        Buffer.isBuffer(input) ? input : Buffer.from(JSON.stringify(input)),
    })),
  ];

  it.each(failures)(
    "preserves the last good snapshot on $name",
    async ({ readFile }) => {
      const lastGood = parseRegistry(raw, meta);
      const result = await readRegistry({
        path,
        lastGood,
        now: lastGood.readAt + 5000,
        readFile,
        gitInfo: async () => ({ commit: null, dirty: null }),
      });
      expect(result).toEqual({
        kind: "stale",
        snapshot: lastGood,
        ageMs: 5000,
        error: expect.any(String),
      });
      if (result.kind !== "stale") throw new Error("Expected stale snapshot");
      expect(result.snapshot).toBe(lastGood);
      expect(result.error.length).toBeGreaterThan(0);
    },
  );

  it.each(failures)(
    "reports unavailable without a snapshot on $name",
    async ({ readFile }) => {
      expect(
        await readRegistry({
          path,
          lastGood: null,
          now: 1000,
          readFile,
          gitInfo: async () => ({ commit: null, dirty: null }),
        }),
      ).toEqual({ kind: "unavailable", error: expect.any(String) });
    },
  );

  it.each(invalidInputs)("parseRegistry throws on %s", (_name, input) => {
    const bytes = Buffer.isBuffer(input)
      ? input
      : Buffer.from(JSON.stringify(input));
    expect(() => parseRegistry(bytes, meta)).toThrow();
  });
});

describe("defaultGitInfo", () => {
  it.each([
    [" M registry.json\n", true],
    ["", false],
  ])(
    "reads path-scoped git metadata with porcelain %j",
    async (status, dirty) => {
      const calls: {
        file: string;
        args: string[];
        optionalLocks: string | undefined;
        timeout: number;
        killSignal: string;
      }[] = [];
      const exec: ExecFileFn = (file, args, options, callback) => {
        calls.push({
          file,
          args,
          optionalLocks: options.env.GIT_OPTIONAL_LOCKS,
          timeout: options.timeout,
          killSignal: options.killSignal,
        });
        callback(null, args.includes("log") ? "abc123\n" : status, "");
      };
      expect(await defaultGitInfo(path, exec)).toEqual({
        commit: "abc123",
        dirty,
      });
      expect(calls).toEqual([
        {
          file: "git",
          args: [
            "-C",
            "/synthetic",
            "log",
            "-1",
            "--format=%H",
            "--",
            "registry.json",
          ],
          optionalLocks: "0",
          timeout: 5000,
          killSignal: "SIGKILL",
        },
        {
          file: "git",
          args: [
            "-C",
            "/synthetic",
            "status",
            "--porcelain",
            "--",
            "registry.json",
          ],
          optionalLocks: "0",
          timeout: 5000,
          killSignal: "SIGKILL",
        },
      ]);
    },
  );

  it("returns unknown metadata when git fails", async () => {
    const exec: ExecFileFn = (_file, _args, _options, callback) =>
      callback(new Error("not a repository"), "", "");
    expect(await defaultGitInfo(path, exec)).toEqual({
      commit: null,
      dirty: null,
    });
  });

  it.each(["log", "status"])(
    "keeps a fresh snapshot when git %s is killed on timeout",
    async (command) => {
      const exec: ExecFileFn = (_file, args, _options, callback) => {
        if (args.includes(command)) {
          callback(
            Object.assign(new Error("git timed out"), {
              killed: true,
              signal: "SIGKILL",
            }),
            "",
            "",
          );
        } else callback(null, "abc123", "");
      };
      expect(
        await readRegistry({
          path,
          lastGood: null,
          now: 1000,
          readFile: async () => raw,
          gitInfo: (file) => defaultGitInfo(file, exec),
        }),
      ).toMatchObject({
        kind: "fresh",
        snapshot: { sha256, commit: null, dirty: null },
      });
    },
  );
});
