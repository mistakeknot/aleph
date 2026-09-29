import type { IpcMain, WebContents, WebFrameMain } from "electron";
import { DIAGNOSTIC_CONSOLE_FALLBACK_CODE } from "@bb/desktop-contract";
import {
  buildRendererConsoleRecord,
  parseRendererDiagnosticEvent,
  type RendererConsoleLevel,
  type RendererLogWriter,
} from "./aleph-renderer-log.js";
import { BB_DESKTOP_ALEPH_DIAGNOSTIC_CHANNEL } from "./aleph-renderer-log-ipc.js";

interface AlephRendererLogArgs {
  ipcMain: Pick<IpcMain, "on">;
  getApplicationMainFrame: (webContentsId: number) => WebFrameMain | null;
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
  getApplicationMainFrame,
  writer,
}: AlephRendererLogArgs): AlephRendererLog {
  ipcMain.on(BB_DESKTOP_ALEPH_DIAGNOSTIC_CHANNEL, (event, payload: unknown) => {
    const senderFrame = event.senderFrame;
    if (
      senderFrame === null ||
      senderFrame.isDestroyed() ||
      senderFrame !== getApplicationMainFrame(event.sender.id)
    ) {
      return;
    }
    const diagnostic = parseRendererDiagnosticEvent(payload);
    if (diagnostic !== null) {
      writer.write(diagnostic);
    }
  });
  return {
    attachConsole(webContents) {
      let uncategorizedCount = 0;
      webContents.on("console-message", (event) => {
        const details: ConsoleMessageDetails = event;
        const record = buildRendererConsoleRecord({
          level: details.level,
          lineNumber: details.lineNumber,
          message: details.message,
          sourceId: details.sourceId,
        });
        if (record === null) {
          return;
        }
        if (record.code === DIAGNOSTIC_CONSOLE_FALLBACK_CODE) {
          uncategorizedCount += 1;
          writer.write({
            kind: "console",
            ...record,
            count: uncategorizedCount,
          });
          return;
        }
        writer.write({ kind: "console", ...record });
      });
    },
  };
}
