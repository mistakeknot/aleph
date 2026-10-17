interface CloseWindowRequestWindow {
  close(): void;
  isDestroyed(): boolean;
}

export interface CloseWindowRequestTracker {
  request(
    webContentsId: number,
    browserWindow: CloseWindowRequestWindow,
    sendRequest: () => void,
  ): void;
  respond(
    webContentsId: number,
    rendererHandled: unknown,
    browserWindow: CloseWindowRequestWindow | null,
  ): void;
}

export function createCloseWindowRequestTracker(
  timeoutMs: number,
): CloseWindowRequestTracker {
  const pending = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    request(webContentsId, browserWindow, sendRequest) {
      const existing = pending.get(webContentsId);
      if (existing !== undefined) {
        clearTimeout(existing);
      }
      pending.set(
        webContentsId,
        setTimeout(() => {
          pending.delete(webContentsId);
          if (!browserWindow.isDestroyed()) {
            browserWindow.close();
          }
        }, timeoutMs),
      );
      sendRequest();
    },
    respond(webContentsId, rendererHandled, browserWindow) {
      const existing = pending.get(webContentsId);
      if (existing !== undefined) {
        clearTimeout(existing);
        pending.delete(webContentsId);
      }
      if (rendererHandled === false) {
        browserWindow?.close();
      }
    },
  };
}
