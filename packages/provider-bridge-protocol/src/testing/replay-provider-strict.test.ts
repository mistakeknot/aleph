import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each([false, true])(
  "strict replay rejects unmatched requests (stalled: %s)",
  async (stalled) => {
    const dir = mkdtempSync(join(tmpdir(), "replay-strict-"));
    if (stalled) {
      writeFileSync(
        join(dir, "bridge→provider.ndjson"),
        JSON.stringify({
          run: 1,
          seq: 1,
          ts: 1,
          dir: "bridge→provider",
          line: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
        }) + "\n",
      );
    }
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./replay-provider-child.mjs", import.meta.url)),
      "--recording",
      dir,
      "--dialect",
      "json-rpc",
      "--state",
      dir,
      "--strict",
    ]);
    const closed = once(child, "close");
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    try {
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: 99, method: "unexpected" }) + "\n",
      );
      expect((await closed)[0]).not.toBe(0);
      expect(errors).toContain("Strict replay:");
      expect(errors).toContain(
        stalled
          ? "stall: unmatched request unexpected"
          : "past end of segment: unmatched request unexpected",
      );
      expect(output).toBe("");
    } finally {
      child.kill();
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  10_000,
);
