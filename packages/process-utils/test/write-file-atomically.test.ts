import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptUrl = new URL(
  "../scripts/write-file-atomically.mjs",
  import.meta.url,
);
const { writeFileAtomically } = (await import(scriptUrl.href)) as {
  writeFileAtomically: (destination: string, contents: string) => Promise<void>;
};

describe("writeFileAtomically", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true });
    }
  });

  async function scratch(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "bb-atomic-write-"));
    roots.push(root);
    return root;
  }

  it("creates missing directories and leaves only the destination", async () => {
    const root = await scratch();
    const destination = join(root, "nested", "out.ts");
    await writeFileAtomically(destination, "complete");
    expect(await readFile(destination, "utf8")).toBe("complete");
    expect(await readdir(join(root, "nested"))).toEqual(["out.ts"]);
  });

  it("never exposes a partial destination while the replacement is written", async () => {
    const root = await scratch();
    const destination = join(root, "out.ts");
    const previous = "p".repeat(1024);
    await writeFile(destination, previous);
    const replacement = "n".repeat(8 * 1024 * 1024);
    let writing = true;
    const observed = new Set<number>();
    const reader = (async () => {
      while (writing) {
        observed.add((await readFile(destination, "utf8")).length);
      }
    })();
    await writeFileAtomically(destination, replacement);
    writing = false;
    await reader;
    expect(await readFile(destination, "utf8")).toBe(replacement);
    for (const length of observed) {
      expect([previous.length, replacement.length]).toContain(length);
    }
  });

  it("removes its temporary file when the destination cannot be replaced", async () => {
    const root = await scratch();
    const destination = join(root, "occupied");
    await writeFileAtomically(join(destination, "child"), "x");
    await expect(writeFileAtomically(destination, "y")).rejects.toThrow();
    expect(await readdir(root)).toEqual(["occupied"]);
  });
});
