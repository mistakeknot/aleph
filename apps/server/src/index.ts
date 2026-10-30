import {
  hostToolchain,
  installSafeProcessDiagnostics,
  installSocketTypeOfServiceGuard,
  writeSafeProcessDiagnosticReport,
} from "@bb/process-utils";
import { join } from "node:path";
import { loadServerConfig } from "@bb/config/server";

const serverConfig = loadServerConfig();
const diagnosticsLogsDir = join(serverConfig.BB_DATA_DIR, "logs");

installSafeProcessDiagnostics({
  logsDir: diagnosticsLogsDir,
  processName: "server",
});
installSocketTypeOfServiceGuard();

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
  process.exitCode = 1;
}

async function main(): Promise<void> {
  void hostToolchain.refresh();
  const serverModule = await import("./start-server.js");
  const { createAlephUpdateNotifyFromEnv } =
    await import("./services/system/aleph-update-notify-command.js");
  await serverModule.runServer(serverConfig, {
    alephDirectStart:
      process.env["ALEPH_UPDATE_DIRECT_START"] === "allow" ? "allow" : "deny",
    alephUpdateNotify: createAlephUpdateNotifyFromEnv(process.env),
  });
}

void main().catch(reportStartupFailure);
