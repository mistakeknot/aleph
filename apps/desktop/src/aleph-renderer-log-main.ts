import type { IpcMain, WebContents } from "electron";
import {
  buildRendererConsoleRecord,
  parseRendererDiagnosticEvent,
  type RendererConsoleLevel,
  type RendererLogWriter,
} from "./aleph-renderer-log.js";
import { BB_DESKTOP_ALEPH_DIAGNOSTIC_CHANNEL } from "./aleph-renderer-log-ipc.js";

interface AlephRendererLogArgs {
  ipcMain: Pick<IpcMain, "on">;
  isApplicationWebContents: (webContentsId: number) => boolean;
  writer: RendererLogWriter;
}

export interface AlephRendererLog {
  attachConsole(webContents: Pick<WebContents, "on">): void;
}

interface ConsoleMessageDetails {
  level: RendererConsoleLevel;
  lineNumber: number;
  message: string;
  sourceId: string;
}

export function registerAlephRendererLog({
  ipcMain,
  isApplicationWebContents,
  writer,
}: AlephRendererLogArgs): AlephRendererLog {
  ipcMain.on(
    BB_DESKTOP_ALEPH_DIAGNOSTIC_CHANNEL,
    (event, payload: unknown) => {
      if (!isApplicationWebContents(event.sender.id)) {
        return;
      }
      const diagnostic = parseRendererDiagnosticEvent(payload);
      if (diagnostic !== null) {
        writer.write(diagnostic);
      }
    },
  );
  return {
    attachConsole(webContents) {
      webContents.on("console-message", (event) => {
        const details: ConsoleMessageDetails = event;
        const record = buildRendererConsoleRecord({
          level: details.level,
          line: details.lineNumber,
          message: details.message,
          sourceId: details.sourceId,
        });
        if (record !== null) {
          writer.write({ kind: "console", ...record });
        }
      });
    },
  };
}
