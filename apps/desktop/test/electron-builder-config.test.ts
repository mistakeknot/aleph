import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  alephBundleVersion,
  desktopAppVersion,
} from "../scripts/desktop-release-channel.mjs";
import {
  resolveElectronBuilderConfig,
  type ElectronBuilderConfigSources,
} from "../scripts/run-electron-builder.mjs";
import { describe, expect, it } from "vitest";

const desktopPackageRoot = process.cwd();
const require = createRequire(resolve(desktopPackageRoot, "package.json"));
const nativeModulesScript: {
  parseStandaloneArguments(argv: string[]): {
    appOutDir: string | undefined;
    options: {
      arch: string;
      electronVersion?: string;
      platform: string;
    };
  };
  resolveBetterSqlite3PrebuildArguments(options: {
    arch: string;
    electronVersion: string;
    platform: string;
  }): string[];
} = require("./scripts/prepare-native-modules.cjs");

const macConfigSchema = z
  .object({
    entitlements: z.string().min(1),
    entitlementsInherit: z.string().min(1),
    extendInfo: z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional(),
    gatekeeperAssess: z.literal(false),
    hardenedRuntime: z.literal(true),
    icon: z.string().min(1),
    identity: z.string().nullable().optional(),
    notarize: z.boolean(),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("dmg"),
        })
        .passthrough(),
      z
        .object({
          arch: z.tuple([z.literal("arm64")]),
          target: z.literal("zip"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const linuxConfigSchema = z
  .object({
    category: z.literal("Development"),
    executableName: z.enum(["bb", "bb-nightly", "aleph"]),
    icon: z.string().min(1),
    target: z.tuple([
      z
        .object({
          arch: z.tuple([z.literal("x64")]),
          target: z.literal("AppImage"),
        })
        .passthrough(),
    ]),
  })
  .passthrough();

const electronBuilderFileSetSchema = z
  .object({
    filter: z.array(z.string().min(1)),
    from: z.string().min(1),
    to: z.string().min(1),
  })
  .passthrough();

const electronBuilderFilePatternSchema = z.union([
  z.string().min(1),
  electronBuilderFileSetSchema,
]);

const electronBuilderConfigSchema = z
  .object({
    afterPack: z.string().min(1),
    asarUnpack: z.array(z.string().min(1)),
    buildVersion: z.string().min(1).optional(),
    extraMetadata: z
      .object({
        AlephUnpublishable: z.boolean().optional(),
        version: z.string().min(1),
      })
      .optional(),
    copyright: z.string().min(1).optional(),
    dmg: z
      .object({
        sign: z.boolean(),
      })
      .passthrough(),
    files: z.array(electronBuilderFilePatternSchema),
    linux: linuxConfigSchema,
    mac: macConfigSchema,
    npmRebuild: z.literal(false),
    appId: z.string().min(1),
    artifactName: z.string().min(1),
    productName: z.string().min(1),
    publish: z.undefined(),
    toolsets: z.object({
      appimage: z.literal("1.0.3"),
    }),
  })
  .passthrough();

const desktopPackageJsonSchema = z
  .object({
    main: z.literal("dist/main.js"),
    version: z.string().min(1),
    optionalDependencies: z.record(z.string(), z.string()).optional(),
    type: z.never().optional(),
  })
  .passthrough();

const workspacePackageJsonSchema = z
  .object({
    pnpm: z.object({
      supportedArchitectures: z.object({
        cpu: z.array(z.string().min(1)),
        os: z.array(z.string().min(1)),
      }),
    }),
  })
  .passthrough();

const signingEnvironmentKeys = [
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_ID",
  "APPLE_TEAM_ID",
  "CSC_IDENTITY_AUTO_DISCOVERY",
  "CSC_KEY_PASSWORD",
  "CSC_LINK",
  "CSC_NAME",
];
const audioInputEntitlementPattern =
  /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/u;

type ElectronBuilderConfig = z.infer<typeof electronBuilderConfigSchema>;
type EnvironmentOverrides = Record<string, string | undefined>;
type ScriptRunResult = {
  exitCode: number | null;
  stderr: string;
  stdout: string;
};
type ReadResolvedConfigResult = {
  config: ElectronBuilderConfig;
};
type CreateScriptEnvironment = (
  overrides: EnvironmentOverrides,
) => NodeJS.ProcessEnv;
type RunConfigScript = (
  overrides: EnvironmentOverrides,
) => Promise<ScriptRunResult>;
type ReadResolvedConfig = (
  overrides: EnvironmentOverrides,
) => Promise<ReadResolvedConfigResult>;
type RunNativePrepScript = (
  appOutDir: string,
  args?: string[],
) => Promise<ScriptRunResult>;

const stockPackageJsonDirectory = mkdtempSync(
  resolve(tmpdir(), "bb-desktop-stock-package-"),
);
const stockPackageJsonPath = resolve(stockPackageJsonDirectory, "package.json");
writeFileSync(
  stockPackageJsonPath,
  JSON.stringify({ name: "@bb/desktop", version: "0.44.0" }),
);

const createScriptEnvironment: CreateScriptEnvironment = (overrides) => {
  const env: NodeJS.ProcessEnv = { ...process.env, ALEPH_BUNDLE_REBUILD: "0" };

  for (const key of signingEnvironmentKeys) {
    delete env[key];
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  return env;
};

const runConfigScript: RunConfigScript = async (overrides) => {
  const child = spawn(
    process.execPath,
    ["scripts/run-electron-builder.mjs", "--print-config"],
    {
      cwd: desktopPackageRoot,
      env: createScriptEnvironment(overrides),
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const runNativePrepScript: RunNativePrepScript = async (
  appOutDir,
  args = [],
) => {
  const child = spawn(
    process.execPath,
    ["scripts/prepare-native-modules.cjs", appOutDir, ...args],
    {
      cwd: desktopPackageRoot,
    },
  );
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  child.stdout.on("data", (chunk) => {
    stdoutChunks.push(String(chunk));
  });
  child.stderr.on("data", (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const exitCode = await new Promise<number | null>((resolveExitCode) => {
    child.on("close", resolveExitCode);
  });

  return {
    exitCode,
    stderr: stderrChunks.join(""),
    stdout: stdoutChunks.join(""),
  };
};

const resolveInProcess = async (
  overrides: Record<string, string | undefined>,
  sources: ElectronBuilderConfigSources,
) => {
  const baseConfig: unknown = JSON.parse(
    await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    ),
  );
  const { config } = resolveElectronBuilderConfig(
    baseConfig,
    createScriptEnvironment(overrides),
    sources,
  );
  return electronBuilderConfigSchema.parse(config);
};

const readResolvedConfig: ReadResolvedConfig = async (overrides) => {
  const result = await runConfigScript(overrides);

  expect(result.exitCode).toBe(0);
  return {
    config: electronBuilderConfigSchema.parse(JSON.parse(result.stdout)),
  };
};

describe("electron-builder signing config", () => {
  it("keeps package metadata compatible with electron universal's CJS entry asar", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.main).toBe("dist/main.js");
    expect(packageJson).not.toHaveProperty("type");
  });

  it("ships no plugin build toolchain binaries", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "package.json"),
      "utf8",
    );
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(Object.keys(packageJson.optionalDependencies ?? {})).not.toEqual(
      expect.arrayContaining(["@esbuild/darwin-arm64", "@esbuild/darwin-x64"]),
    );
  });

  it("unpacks the ESM bb-app bridge with an explicit module extension", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.asarUnpack).toContain("dist/bb-app-bridge.mjs");
    expect(config.asarUnpack).not.toContain("dist/bb-app-bridge.js");
  });

  it("runs a native module preparation hook after packaging", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const hookPath = "scripts/prepare-native-modules.cjs";

    expect(config.afterPack).toBe(hookPath);
    await expect(
      access(resolve(desktopPackageRoot, hookPath)),
    ).resolves.toBeUndefined();
  });

  it("passes the standalone platform through to better-sqlite3 prebuild-install", () => {
    const { options } = nativeModulesScript.parseStandaloneArguments([
      "/tmp/linux-unpacked",
      "--electron-version=44.3.0",
      "--arch=x64",
      "--platform=linux",
    ]);
    const electronVersion = options.electronVersion;
    if (electronVersion === undefined) {
      throw new Error("Expected the standalone Electron version argument");
    }

    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: options.arch,
        electronVersion,
        platform: options.platform,
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=44.3.0",
      "--arch=x64",
      "--platform=linux",
    ]);
  });

  it("preserves the macOS better-sqlite3 prebuild-install arguments", () => {
    expect(
      nativeModulesScript.resolveBetterSqlite3PrebuildArguments({
        arch: "arm64",
        electronVersion: "44.3.0",
        platform: "darwin",
      }),
    ).toEqual([
      "--runtime=electron",
      "--target=44.3.0",
      "--arch=arm64",
      "--platform=darwin",
    ]);
  });

  it("installs native plugin build packages for arm64 and x64", async () => {
    const packageJsonText = await readFile(
      resolve(desktopPackageRoot, "..", "..", "package.json"),
      "utf8",
    );
    const packageJson = workspacePackageJsonSchema.parse(
      JSON.parse(packageJsonText),
    );

    expect(packageJson.pnpm.supportedArchitectures).toEqual({
      cpu: ["arm64", "x64"],
      os: ["current"],
    });
  });

  it("disables in-place native rebuilds so the shared pnpm store is not mutated", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.npmRebuild).toBe(false);
  });

  it("excludes source maps from packaged app files", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.files).toContain("!**/*.map");
  });

  it("copies the app scaffold template as a dedicated file set", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.files).toContainEqual({
      filter: ["**/*"],
      from: "node_modules/bb-app/server/dist/app-scaffold-template",
      to: "node_modules/bb-app/server/dist/app-scaffold-template",
    });
  });

  it("patches packaged node-pty helper path handling", async () => {
    const appOutDir = await mkdtemp(
      resolve(tmpdir(), "bb-desktop-native-modules-"),
    );
    const nodePtyPackageDir = resolve(
      appOutDir,
      "bb.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "node-pty",
    );
    const rebuiltNativeDir = resolve(nodePtyPackageDir, "build", "Release");
    const unixTerminalPath = resolve(
      nodePtyPackageDir,
      "lib",
      "unixTerminal.js",
    );
    const helperPath = resolve(
      nodePtyPackageDir,
      "prebuilds",
      "darwin-arm64",
      "spawn-helper",
    );
    const rebuiltHelperPath = resolve(rebuiltNativeDir, "spawn-helper");

    try {
      await mkdir(rebuiltNativeDir, { recursive: true });
      await writeFile(resolve(rebuiltNativeDir, "pty.node"), "rebuilt");
      await writeFile(rebuiltHelperPath, "rebuilt-helper");
      await chmod(rebuiltHelperPath, 0o644);
      await mkdir(dirname(unixTerminalPath), { recursive: true });
      await writeFile(
        unixTerminalPath,
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      await mkdir(dirname(helperPath), { recursive: true });
      await writeFile(helperPath, "helper");
      await chmod(helperPath, 0o644);
      const result = await runNativePrepScript(appOutDir);

      expect(result.exitCode).toBe(0);
      await expect(
        access(resolve(rebuiltNativeDir, "pty.node")),
      ).resolves.toBeUndefined();
      await expect(readFile(unixTerminalPath, "utf8")).resolves.toContain(
        "helperPath.replace(/app\\.asar(?!\\.unpacked)/g, 'app.asar.unpacked')",
      );
      expect((await stat(helperPath)).mode & 0o777).toBe(0o755);
      expect((await stat(rebuiltHelperPath)).mode & 0o777).toBe(0o755);
    } finally {
      await rm(appOutDir, { force: true, recursive: true });
    }
  });

  it("validates bundled N-API SQLite without using the legacy prebuild installer", async () => {
    const appOutDir = await mkdtemp(resolve(tmpdir(), "bb-desktop-napi-"));
    const nodeModules = resolve(appOutDir, "node_modules");
    const requireFromRuntime = createRequire(
      resolve(desktopPackageRoot, "../../packages/bb-app/package.json"),
    );
    try {
      const ptyLib = resolve(nodeModules, "node-pty/lib");
      await mkdir(ptyLib, { recursive: true });
      await writeFile(
        resolve(ptyLib, "unixTerminal.js"),
        "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');",
      );
      await cp(
        dirname(requireFromRuntime.resolve("better-sqlite3/package.json")),
        resolve(nodeModules, "better-sqlite3"),
        { recursive: true },
      );
      const result = await runNativePrepScript(appOutDir, [
        "--electron-version=44.3.0",
      ]);
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      const binaryPath = resolve(
        nodeModules,
        "better-sqlite3/prebuilds",
        `${process.platform}-${process.arch}.node`,
      );
      await writeFile(binaryPath, "invalid native binary");
      const invalidResult = await runNativePrepScript(appOutDir, [
        "--electron-version=44.3.0",
      ]);
      expect(invalidResult.exitCode).not.toBe(0);
      expect(invalidResult.stderr).toContain(binaryPath);
      expect(invalidResult.stderr).not.toContain("prebuild-install");
    } finally {
      await rm(appOutDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("points mac signing entitlements at checked-in plist files", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.entitlements).toBe("build/entitlements.mac.plist");
    expect(config.mac.entitlementsInherit).toBe(
      "build/entitlements.mac.inherit.plist",
    );

    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlements)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, config.mac.entitlementsInherit)),
    ).resolves.toBeUndefined();
  });

  it("packages macOS artifacts for arm64 only", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.mac.target).toEqual([
      { arch: ["arm64"], target: "dmg" },
      { arch: ["arm64"], target: "zip" },
    ]);
  });

  it("packages a Linux AppImage for x64", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));

    expect(config.linux).toMatchObject({
      category: "Development",
      executableName: "bb",
      target: [{ arch: ["x64"], target: "AppImage" }],
    });
    expect(config.toolsets.appimage).toBe("1.0.3");
    await expect(
      access(resolve(desktopPackageRoot, config.linux.icon)),
    ).resolves.toBeUndefined();
  });

  it("grants audio input to the signed app and helper processes", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );
    const config = electronBuilderConfigSchema.parse(JSON.parse(configText));
    const entitlementPaths = [
      config.mac.entitlements,
      config.mac.entitlementsInherit,
    ];

    for (const entitlementPath of entitlementPaths) {
      const entitlements = await readFile(
        resolve(desktopPackageRoot, entitlementPath),
        "utf8",
      );

      expect(entitlements).toMatch(audioInputEntitlementPattern);
    }
  });

  it("declares no update feed in the checked-in config or any channel", async () => {
    const configText = await readFile(
      resolve(desktopPackageRoot, "electron-builder.config.json"),
      "utf8",
    );

    expect(JSON.parse(configText)).not.toHaveProperty("publish");
    for (const channel of ["latest", "nightly", "aleph"]) {
      const config = await resolveInProcess(
        { BB_DESKTOP_RELEASE_CHANNEL: channel },
        channel === "aleph" ? {} : { packageJsonPath: stockPackageJsonPath },
      );
      expect(config.publish).toBeUndefined();
    }
  });

  it("creates a separate nightly app identity and update feed", async () => {
    const config = await resolveInProcess(
      { BB_DESKTOP_RELEASE_CHANNEL: "nightly" },
      { packageJsonPath: stockPackageJsonPath },
    );

    expect(config.appId).toBe("dev.bb.desktop.nightly");
    expect(config.productName).toBe("bb Nightly");
    expect(config.artifactName).toBe("bb-nightly-${version}-${arch}.${ext}");
    expect(config.linux.icon).toBe("assets/icon-nightly.png");
    expect(config.linux.executableName).toBe("bb-nightly");
    expect(config.mac.icon).toBe("assets/icon-nightly.icns");
    await expect(
      access(resolve(desktopPackageRoot, config.mac.icon)),
    ).resolves.toBeUndefined();
    await expect(
      access(resolve(desktopPackageRoot, "assets/icon-nightly.png")),
    ).resolves.toBeUndefined();
  });

  it("renames the packaged app to Aleph under its own bundle id", async () => {
    const { config } = await readResolvedConfig({
      BB_DESKTOP_RELEASE_CHANNEL: "aleph",
    });

    expect(config.appId).toBe("com.generalsystemsventures.aleph");
    expect(config.productName).toBe("Aleph");
    expect(config.artifactName).toBe("Aleph-${version}-${arch}.${ext}");
    expect(config.linux.executableName).toBe("aleph");
  });

  it("stamps the Aleph bundle with the plain release, a monotonic CFBundleVersion and the upstream base", async () => {
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(
        await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
      ),
    );
    const { config } = await readResolvedConfig({
      BB_DESKTOP_RELEASE_CHANNEL: "aleph",
    });

    expect(config.extraMetadata).toEqual({
      version: desktopAppVersion("aleph", packageJson.version),
    });
    expect(config.extraMetadata?.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(config.buildVersion).toBe(alephBundleVersion(packageJson.version));
    expect(config.mac.extendInfo).toEqual({
      AlephUpstreamBase: packageJson.version.split("+")[0],
    });
  });

  it("honors an explicit rebuild counter", async () => {
    const { config } = await readResolvedConfig({
      ALEPH_BUNDLE_REBUILD: "2",
      BB_DESKTOP_RELEASE_CHANNEL: "aleph",
    });

    expect(Number(config.buildVersion) % 100).toBe(2);
  });

  it("refuses an Aleph build with no explicit rebuild counter", async () => {
    const result = await runConfigScript({ ALEPH_BUNDLE_REBUILD: undefined });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("ALEPH_BUNDLE_REBUILD is required");
  });

  it("lets a local unpublishable Aleph build omit the counter and skip the checked-in ledger", async () => {
    const { config } = await readResolvedConfig({
      ALEPH_BUNDLE_REBUILD: undefined,
      ALEPH_UNPUBLISHABLE_BUILD: "1",
    });

    expect(config.buildVersion).toBeDefined();
  });

  it("fails a publishable build whose CFBundleVersion does not exceed the ledger", async () => {
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(
        await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
      ),
    );
    const derived = alephBundleVersion(packageJson.version);
    const equalLedger = resolve(stockPackageJsonDirectory, "equal-ledger.json");
    const newerLedger = resolve(stockPackageJsonDirectory, "newer-ledger.json");
    await writeFile(
      equalLedger,
      JSON.stringify({
        releases: [
          { bundleVersion: derived, rebuild: 0, version: "already-shipped" },
        ],
      }),
    );
    await writeFile(
      newerLedger,
      JSON.stringify({
        releases: [
          {
            bundleVersion: String(Number(derived) + 100),
            rebuild: 0,
            version: "newer-release",
          },
        ],
      }),
    );

    await expect(
      resolveInProcess({}, { ledgerPath: equalLedger }),
    ).rejects.toThrow("already ledgered");
    await expect(
      resolveInProcess({}, { ledgerPath: newerLedger }),
    ).rejects.toThrow("is not greater than ledgered");
  });

  it("accepts a publishable build that exceeds every ledger entry", async () => {
    const packageJson = desktopPackageJsonSchema.parse(
      JSON.parse(
        await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
      ),
    );
    const ledgerPath = resolve(stockPackageJsonDirectory, "older-ledger.json");
    await writeFile(
      ledgerPath,
      JSON.stringify({
        releases: [
          {
            bundleVersion: String(
              Number(alephBundleVersion(packageJson.version)) - 100,
            ),
            rebuild: 0,
            version: "older",
          },
        ],
      }),
    );

    const config = await resolveInProcess({}, { ledgerPath });

    expect(config.buildVersion).toBe(alephBundleVersion(packageJson.version));
  });

  it("marks an unpublishable build and configures it differently from a publishable one", async () => {
    const publishable = await readResolvedConfig({});
    const unpublishable = await readResolvedConfig({
      ALEPH_UNPUBLISHABLE_BUILD: "1",
    });

    expect(unpublishable.config).not.toEqual(publishable.config);
    expect(unpublishable.config.mac.extendInfo).toMatchObject({
      AlephUnpublishable: true,
    });
    expect(unpublishable.config.extraMetadata).toMatchObject({
      AlephUnpublishable: true,
    });
    expect(unpublishable.config.mac.identity).toBeNull();
    expect(unpublishable.config.mac.notarize).toBe(false);
    expect(unpublishable.config.artifactName).toContain("UNPUBLISHABLE");
    expect(publishable.config.mac.extendInfo).not.toHaveProperty(
      "AlephUnpublishable",
    );
    expect(publishable.config.artifactName).not.toContain("UNPUBLISHABLE");
  });

  it("refuses an unpublishable build combined with signing credentials", async () => {
    const result = await runConfigScript({
      ALEPH_UNPUBLISHABLE_BUILD: "1",
      CSC_LINK: "x",
      CSC_KEY_PASSWORD: "x",
      APPLE_ID: "x",
      APPLE_APP_SPECIFIC_PASSWORD: "x",
      APPLE_TEAM_ID: "x",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("cannot be combined with signing");
  });

  it("lets no environment variable redirect the ledger or version source on the CLI path", async () => {
    const ledgerPath = resolve(stockPackageJsonDirectory, "real-ledger.json");
    const derived = alephBundleVersion(
      desktopPackageJsonSchema.parse(
        JSON.parse(
          await readFile(resolve(desktopPackageRoot, "package.json"), "utf8"),
        ),
      ).version,
    );
    await writeFile(
      ledgerPath,
      JSON.stringify({
        releases: [
          { bundleVersion: derived, rebuild: 0, version: "already-shipped" },
        ],
      }),
    );

    for (const vitest of ["true", undefined]) {
      const ledgerOverride = await runConfigScript({
        ALEPH_BUILD_LEDGER: ledgerPath,
        VITEST: vitest,
      });
      const packageOverride = await runConfigScript({
        BB_DESKTOP_PACKAGE_JSON: stockPackageJsonPath,
        BB_DESKTOP_RELEASE_CHANNEL: "latest",
        VITEST: vitest,
      });
      const unpublishableOverride = await runConfigScript({
        ALEPH_BUILD_LEDGER: ledgerPath,
        ALEPH_UNPUBLISHABLE_BUILD: "1",
        BB_DESKTOP_PACKAGE_JSON: stockPackageJsonPath,
        VITEST: vitest,
      });

      expect(ledgerOverride.exitCode).toBe(0);
      expect(packageOverride.exitCode).toBe(1);
      expect(packageOverride.stderr).toContain(
        "contradicts the Aleph package version",
      );
      expect(unpublishableOverride.exitCode).toBe(0);
      expect(JSON.parse(unpublishableOverride.stdout).appId).toBe(
        "com.generalsystemsventures.aleph",
      );
    }
  });

  it("leaves non-Aleph channels without Aleph bundle keys", async () => {
    const config = await resolveInProcess(
      { BB_DESKTOP_RELEASE_CHANNEL: "nightly" },
      { packageJsonPath: stockPackageJsonPath },
    );

    expect(config.buildVersion).toBeUndefined();
    expect(config.extraMetadata).toBeUndefined();
    expect(config.mac.extendInfo).toBeUndefined();
  });

  it("refuses a non-Aleph channel on an Aleph package instead of enabling stock identity", async () => {
    for (const channel of ["latest", "nightly"]) {
      const result = await runConfigScript({
        BB_DESKTOP_RELEASE_CHANNEL: channel,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("contradicts the Aleph package version");
    }
  });

  it("packages the Aleph build with General Systems Ventures as the Info.plist copyright holder", async () => {
    const { config } = await readResolvedConfig({
      BB_DESKTOP_RELEASE_CHANNEL: "aleph",
    });

    expect(config.copyright).toMatch(
      /^Copyright © \d{4} General Systems Ventures$/,
    );
    expect(config.copyright).toContain(String(new Date().getFullYear()));
  });

  it("derives the aleph channel automatically from this checkout's +aleph package version", async () => {
    const { config } = await readResolvedConfig({});

    expect(config.productName).toBe("Aleph");
  });

  it("rejects unknown desktop release channels", async () => {
    const result = await runConfigScript({
      BB_DESKTOP_RELEASE_CHANNEL: "canary",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "BB_DESKTOP_RELEASE_CHANNEL must be latest, nightly, or aleph",
    );
  });

  it("signs local builds via keychain auto-discovery when signing secrets are absent", async () => {
    const { config } = await readResolvedConfig({});

    expect(config.mac).not.toHaveProperty("identity");
    expect(config.mac.notarize).toBe(false);
    expect(config.dmg.sign).toBe(false);
  });

  it("keeps builds unsigned when keychain auto-discovery is explicitly disabled", async () => {
    const { config } = await readResolvedConfig({
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
    });

    expect(config.mac.identity).toBeNull();
    expect(config.mac.notarize).toBe(false);
  });

  it("rejects partial signing secret sets", async () => {
    const partialAppleCredentials = await runConfigScript({
      APPLE_ID: "sawyer@example.com",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
    });

    expect(partialAppleCredentials.exitCode).toBe(1);
    expect(partialAppleCredentials.stderr).toContain(
      "Incomplete macOS signing/notarization environment.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Present: CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID.",
    );
    expect(partialAppleCredentials.stderr).toContain(
      "Missing: APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID.",
    );
  });

  it("enables app signing and notarization when signing and Apple credentials are complete", async () => {
    const completeAppleCredentials = await readResolvedConfig({
      APPLE_APP_SPECIFIC_PASSWORD: "app-password",
      APPLE_ID: "sawyer@example.com",
      APPLE_TEAM_ID: "TEAMID1234",
      CSC_KEY_PASSWORD: "p12-password",
      CSC_LINK: "base64-p12",
      CSC_NAME: "Sawyer Hood (TEAMID1234)",
    });

    expect(completeAppleCredentials.config.mac.identity).toBe(
      "Sawyer Hood (TEAMID1234)",
    );
    expect(completeAppleCredentials.config.mac.notarize).toBe(true);
    expect(completeAppleCredentials.config.dmg.sign).toBe(false);
  });
});
