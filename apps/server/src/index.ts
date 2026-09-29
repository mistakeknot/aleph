import { join } from "node:path";
import { homedir } from "node:os";
import {
  exitCodeForLaunchFailure,
  resolveLaunchVersion,
  runLaunchGuard,
} from "@bb/config/launch-guard";
import { loadServerConfig } from "@bb/config/server";
import {
  installSafeProcessDiagnostics,
  writeSafeProcessDiagnosticReport,
} from "@bb/process-utils";

const serverConfig = loadServerConfig();
const diagnosticsLogsDir = join(serverConfig.BB_DATA_DIR, "logs");

installSafeProcessDiagnostics({
  logsDir: diagnosticsLogsDir,
  processName: "server",
});

function reportStartupFailure(error: unknown): void {
  try {
    writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir: diagnosticsLogsDir,
      processName: "server",
      error,
    });
  } catch {}

  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = exitCodeForLaunchFailure(error);
}

async function main(): Promise<void> {
  runLaunchGuard({
    dataDir: serverConfig.BB_DATA_DIR,
    homeDir: homedir(),
    role: "embedded-server",
    version: resolveLaunchVersion(process.env),
  });
  const serverModule = await import("./start-server.js");
  await serverModule.runServer(serverConfig);
}

void main().catch(reportStartupFailure);
