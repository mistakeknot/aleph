import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_LAUNCHER_MARKER } from "@bb/config/cli-command";
import { cliOverrideLoopsBackToLauncher } from "../src/cli-override-guard.js";

describe.skipIf(process.platform === "win32")(
  "cliOverrideLoopsBackToLauncher",
  () => {
    let root = "";
    let entry = "";

    function script(name: string, content: string): string {
      const path = join(root, name);
      writeFileSync(path, content);
      chmodSync(path, 0o755);
      return path;
    }

    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "bb-override-guard-"));
      mkdirSync(join(root, "dist"));
      entry = join(root, "dist", "bb.js");
      writeFileSync(entry, "");
    });

    afterAll(() => {
      rmSync(root, { force: true, recursive: true });
    });

    it("flags the launcher entry itself and a symlink to it", () => {
      const link = join(root, "entry-link");
      symlinkSync(entry, link);

      expect(
        cliOverrideLoopsBackToLauncher({ entryPath: entry, override: entry }),
      ).toBe(true);
      expect(
        cliOverrideLoopsBackToLauncher({ entryPath: entry, override: link }),
      ).toBe(true);
    });

    it("flags a shim carrying the machine launcher marker", () => {
      const shim = script(
        "marked",
        `#!/bin/sh\n# ${CLI_LAUNCHER_MARKER}\nexec node /elsewhere/entry.js "$@"\n`,
      );

      expect(
        cliOverrideLoopsBackToLauncher({ entryPath: null, override: shim }),
      ).toBe(true);
    });

    it("flags a shim whose exec line resolves to the entry through its own assignments", () => {
      const shim = script(
        "exec-shim",
        `#!/bin/sh\nentry='${entry}'\nexec node "$entry" "$@"\n`,
      );
      const link = join(root, "exec-shim-link");
      symlinkSync(shim, link);

      expect(
        cliOverrideLoopsBackToLauncher({ entryPath: entry, override: shim }),
      ).toBe(true);
      expect(
        cliOverrideLoopsBackToLauncher({ entryPath: entry, override: link }),
      ).toBe(true);
    });

    it("flags a shim that reaches the entry through a relative path", () => {
      const shim = script("rel-shim", '#!/bin/sh\nexec node dist/bb.js "$@"\n');

      expect(
        cliOverrideLoopsBackToLauncher({ entryPath: entry, override: shim }),
      ).toBe(true);
    });

    it("leaves an unrelated script and a missing path alone", () => {
      const other = script(
        "other",
        '#!/bin/sh\nexec node /somewhere/else.js "$@"\n',
      );

      expect(
        cliOverrideLoopsBackToLauncher({ entryPath: entry, override: other }),
      ).toBe(false);
      expect(
        cliOverrideLoopsBackToLauncher({
          entryPath: entry,
          override: join(root, "missing"),
        }),
      ).toBe(false);
    });

    it("ignores a non-script file even when it mentions the entry", () => {
      const binary = script("binary", `not a script ${entry}\n`);

      expect(
        cliOverrideLoopsBackToLauncher({ entryPath: entry, override: binary }),
      ).toBe(false);
    });
  },
);
