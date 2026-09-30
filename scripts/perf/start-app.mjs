import { homedir } from "node:os";
import { runNativeModulePreflight } from "../start-bb.mjs";

const { resolveWorktreeRuntimePolicy, runBbApp, runLauncherEntry } =
  await import("../../packages/bb-app/src/launcher.ts");

runLauncherEntry(() =>
  runBbApp([], {
    beforeServerStart: () => runNativeModulePreflight({ checkOnly: true }),
    worktreePolicy: resolveWorktreeRuntimePolicy({
      env: process.env,
      homeDir: homedir(),
    }),
  }),
);
