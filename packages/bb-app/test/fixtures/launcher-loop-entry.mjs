import { join } from "node:path";
import { runBundledCliCommand } from "../../src/launcher.ts";

const dataDir = process.env.FIXTURE_DATA_DIR;
if (!dataDir) {
  throw new Error("fixture environment incomplete");
}

const daemonBundleDir = join(dataDir, "host-daemon");
const context = {
  appDistDir: join(dataDir, "app", "dist"),
  appVersion: "0.0.0-test",
  configFile: join(dataDir, "config.json"),
  daemonBundleDir,
  daemonEntry: join(daemonBundleDir, "daemon-bundle.mjs"),
  daemonLockDir: join(dataDir, "daemon.lock.lock"),
  daemonLockFile: join(dataDir, "daemon.lock"),
  daemonPort: 38887,
  dataDir,
  dbPath: join(dataDir, "bb.db"),
  envFile: join(dataDir, "env.json"),
  logDir: join(dataDir, "logs"),
  packageRoot: join(dataDir, "package"),
  serverEntry: join(dataDir, "server", "dist", "index.js"),
  serverPort: 38886,
  serverUrl: "http://127.0.0.1:38886",
};

process.exitCode = await runBundledCliCommand({
  args: process.argv.slice(2),
  context,
  env: process.env,
});
