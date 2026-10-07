import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ALEPH_UPDATE_NOTIFY_COMMAND_ENV,
  ALEPH_UPDATE_NOTIFY_MAX_BYTES,
  createAlephUpdateNotifyFromEnv,
} from "../../src/services/system/aleph-update-notify-command.js";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aleph-notify-"));
});

afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

function command(script: string): string {
  return JSON.stringify([process.execPath, "-e", script, join(dir, "out")]);
}

const WRITE_STDIN =
  "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>require('fs').writeFileSync(process.argv[1],d))";

describe("aleph update notify command", () => {
  it("is a no-op when the variable is unset", async () => {
    const notify = createAlephUpdateNotifyFromEnv({});
    await expect(notify("hello")).resolves.toBeUndefined();
  });

  it("is a no-op for a value that is not a non-empty string array", async () => {
    for (const value of ["", "not json", "{}", "[]", "[1]", '["a", 2]']) {
      const notify = createAlephUpdateNotifyFromEnv({
        [ALEPH_UPDATE_NOTIFY_COMMAND_ENV]: value,
      });
      await expect(notify("hello")).resolves.toBeUndefined();
    }
  });

  it("runs the fixed argv without a shell and sends the message on stdin", async () => {
    const notify = createAlephUpdateNotifyFromEnv({
      [ALEPH_UPDATE_NOTIFY_COMMAND_ENV]: command(WRITE_STDIN),
    });
    await notify("Aleph update request abc: started; $(touch pwned)");
    expect(await readFile(join(dir, "out"), "utf8")).toBe(
      "Aleph update request abc: started; $(touch pwned)",
    );
  });

  it("bounds the payload", async () => {
    const notify = createAlephUpdateNotifyFromEnv({
      [ALEPH_UPDATE_NOTIFY_COMMAND_ENV]: command(WRITE_STDIN),
    });
    await notify("x".repeat(ALEPH_UPDATE_NOTIFY_MAX_BYTES * 4));
    const written = await readFile(join(dir, "out"), "utf8");
    expect(Buffer.byteLength(written)).toBeLessThanOrEqual(
      ALEPH_UPDATE_NOTIFY_MAX_BYTES,
    );
  });

  it("gives the command only a minimal environment", async () => {
    const notify = createAlephUpdateNotifyFromEnv({
      [ALEPH_UPDATE_NOTIFY_COMMAND_ENV]: command(
        "require('fs').writeFileSync(process.argv[1],JSON.stringify(Object.keys(process.env).sort()))",
      ),
      HOME: "/home/example",
      LANG: "C.UTF-8",
      PATH: "/usr/bin",
      PROVIDER_API_KEY: "sentinel-secret",
      SESSION_TOKEN: "sentinel-token",
    });
    await notify("hello");
    const keys: string[] = JSON.parse(await readFile(join(dir, "out"), "utf8"));
    expect(keys.filter((key) => !["HOME", "LANG", "PATH"].includes(key))).toEqual(
      [],
    );
    expect(keys).toEqual(expect.arrayContaining(["HOME", "LANG", "PATH"]));
  });

  it("rejects when the command exits nonzero", async () => {
    const notify = createAlephUpdateNotifyFromEnv({
      [ALEPH_UPDATE_NOTIFY_COMMAND_ENV]: command("process.exit(3)"),
    });
    await expect(notify("hello")).rejects.toThrow();
  });

  it("rejects a command that is not found", async () => {
    const notify = createAlephUpdateNotifyFromEnv({
      [ALEPH_UPDATE_NOTIFY_COMMAND_ENV]: JSON.stringify([join(dir, "missing")]),
    });
    await expect(notify("hello")).rejects.toThrow();
  });

  it("kills a command that outlives the timeout", async () => {
    const notify = createAlephUpdateNotifyFromEnv(
      {
        [ALEPH_UPDATE_NOTIFY_COMMAND_ENV]: command("setTimeout(()=>{},60000)"),
      },
      { timeoutMs: 200 },
    );
    const started = Date.now();
    await expect(notify("hello")).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
