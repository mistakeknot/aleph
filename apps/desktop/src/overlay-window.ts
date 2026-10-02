import type { BrowserWindowConstructorOptions } from "electron";
import {
  BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL,
  isValidOverlayAccelerator,
  type OverlayOpenPanelResult,
  type OverlaySettings,
} from "./overlay-contract.js";
import {
  isOverlayNavigationAllowed,
  parseOverlayOpenPanelRequest,
  resolveOverlayPanelUrl,
  type OverlayPluginRegistry,
} from "./overlay-panel.js";
import type { OverlaySettingsStore } from "./overlay-settings.js";

const OVERLAY_WIDTH = 520;
const OVERLAY_HEIGHT = 640;

interface OverlayNavigationEvent {
  preventDefault(): void;
}

interface OverlayInputEvent {
  preventDefault(): void;
}

interface OverlayInput {
  key: string;
  type: string;
}

interface OverlayFrame {
  url: string;
}

interface OverlayFrameNavigationEvent extends OverlayNavigationEvent {
  isMainFrame: boolean;
  url: string;
}

const filterOwners = new WeakMap<object, symbol>();

export interface OverlayBeforeRequestDetails {
  resourceType: string;
  url: string;
  webContentsId?: number;
}

export interface OverlaySession {
  webRequest: {
    onBeforeRequest(
      listener:
        | ((
            details: OverlayBeforeRequestDetails,
            callback: (response: { cancel?: boolean }) => void,
          ) => void)
        | null,
    ): void;
  };
}

export interface OverlayWebContents {
  id: number;
  loadURL(url: string): Promise<void>;
  mainFrame: OverlayFrame;
  session: OverlaySession;
  on(
    eventName: "will-frame-navigate",
    listener: (event: OverlayFrameNavigationEvent) => void,
  ): void;
  on(
    eventName: "will-navigate" | "will-redirect" | "will-attach-webview",
    listener: (event: OverlayNavigationEvent, url: string) => void,
  ): void;
  on(
    eventName: "before-input-event",
    listener: (event: OverlayInputEvent, input: OverlayInput) => void,
  ): void;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

export interface OverlayBrowserWindow {
  center(): void;
  destroy(): void;
  focus(): void;
  hide(): void;
  isDestroyed(): boolean;
  isVisible(): boolean;
  on(eventName: "blur" | "closed", listener: () => void): void;
  setAlwaysOnTop(flag: boolean, level: "floating"): void;
  show(): void;
  webContents: OverlayWebContents;
}

export interface OverlayIpcInvokeEvent {
  sender: OverlayWebContents;
  senderFrame: OverlayFrame | null;
}

export interface OverlayIpcMain {
  handle(
    channel: string,
    listener: (
      event: OverlayIpcInvokeEvent,
      payload: unknown,
    ) => Promise<OverlayOpenPanelResult>,
  ): void;
  removeHandler(channel: string): void;
}

export interface OverlayGlobalShortcut {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

interface CreateOverlayControllerArgs {
  createWindow(options: BrowserWindowConstructorOptions): OverlayBrowserWindow;
  getAppOrigin(): string | null;
  globalShortcut: OverlayGlobalShortcut;
  ipcMain: OverlayIpcMain;
  preloadPath: string;
  registry: OverlayPluginRegistry;
  report(message: string): void;
  settingsStore: OverlaySettingsStore;
}

const FRAME_RESOURCE_TYPES = new Set(["mainFrame", "subFrame"]);

export type OverlayShortcutResult =
  | { accelerator: string; ok: true }
  | { ok: false; reason: string };

export interface OverlayController {
  dispose(): void;
  getRegisteredAccelerator(): string | null;
  rebind(accelerator: string): Promise<OverlayShortcutResult>;
  start(): Promise<OverlayShortcutResult>;
  toggle(): Promise<void>;
}

export function createOverlayWindowOptions(args: {
  preloadPath: string;
}): BrowserWindowConstructorOptions {
  return {
    alwaysOnTop: true,
    frame: false,
    fullscreenable: false,
    height: OVERLAY_HEIGHT,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    title: "bb overlay",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      preload: args.preloadPath,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
    width: OVERLAY_WIDTH,
  };
}

export function createOverlayController(
  args: CreateOverlayControllerArgs,
): OverlayController {
  let overlayWindow: OverlayBrowserWindow | null = null;
  let loadedOrigin: string | null = null;
  let registeredAccelerator: string | null = null;
  let overlayReleaseSession: (() => void) | null = null;
  let disposed = false;
  // Bumped by every new operation and every hide/dispose; an operation that
  // finds its token stale after an await must not touch the window again.
  let generation = 0;
  let pendingToken: number | null = null;

  function liveWindow(): OverlayBrowserWindow | null {
    return overlayWindow !== null && !overlayWindow.isDestroyed()
      ? overlayWindow
      : null;
  }

  function registerAccelerator(accelerator: string): OverlayShortcutResult {
    if (!isValidOverlayAccelerator(accelerator)) {
      return { ok: false, reason: `"${accelerator}" is not a valid shortcut.` };
    }
    let registered = false;
    try {
      registered = args.globalShortcut.register(accelerator, () => {
        void controller.toggle();
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `Registering ${accelerator} failed: ${detail}`,
      };
    }
    if (!registered) {
      return {
        ok: false,
        reason: `${accelerator} is unavailable; another application may already own it.`,
      };
    }
    registeredAccelerator = accelerator;
    return { accelerator, ok: true };
  }

  function unregisterCurrent(): void {
    if (registeredAccelerator === null) {
      return;
    }
    try {
      args.globalShortcut.unregister(registeredAccelerator);
    } catch (error) {
      args.report(
        `Unregistering ${registeredAccelerator} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    registeredAccelerator = null;
  }

  function cancelOperations(): void {
    generation += 1;
    pendingToken = null;
  }

  function hideWindow(window: OverlayBrowserWindow): void {
    cancelOperations();
    if (!window.isDestroyed()) {
      window.hide();
    }
  }

  function ensureWindow(): OverlayBrowserWindow {
    const existing = liveWindow();
    if (existing !== null) {
      return existing;
    }
    const created = args.createWindow(
      createOverlayWindowOptions({ preloadPath: args.preloadPath }),
    );
    created.setAlwaysOnTop(true, "floating");
    created.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const guardNavigation = (
      event: OverlayNavigationEvent,
      url: string,
    ): void => {
      if (
        !isOverlayNavigationAllowed({ appOrigin: args.getAppOrigin(), url })
      ) {
        event.preventDefault();
      }
    };
    created.webContents.on("will-navigate", guardNavigation);
    created.webContents.on("will-redirect", guardNavigation);
    // will-navigate only covers the main frame; this covers <iframe> loads and
    // subframe navigations. It is not emitted for loadURL or for redirects, so
    // the webRequest filter below is the authoritative gate.
    created.webContents.on("will-frame-navigate", (event) => {
      guardNavigation(event, event.url);
    });
    // The overlay shares the default session on purpose: the panel needs the
    // app's own cookies, and a separate partition would log it out. Requests
    // are therefore filtered by owning webContents so the main window and the
    // browser tabs are untouched. The listener sees every redirect hop and
    // direct document loads. webRequest allows one listener per session, so
    // nothing else in the app may register one on the default session.
    const overlaySession = created.webContents.session;
    const contentsId = created.webContents.id;
    const requestFilter: Parameters<
      typeof overlaySession.webRequest.onBeforeRequest
    >[0] = (details, callback) => {
      if (
        details.webContentsId !== contentsId ||
        !FRAME_RESOURCE_TYPES.has(details.resourceType)
      ) {
        callback({});
        return;
      }
      callback({
        cancel: !isOverlayNavigationAllowed({
          appOrigin: args.getAppOrigin(),
          url: details.url,
        }),
      });
    };
    const ownershipToken = Symbol("overlay-request-filter");
    overlaySession.webRequest.onBeforeRequest(requestFilter);
    filterOwners.set(overlaySession, ownershipToken);
    // Electron keeps one listener per session and has no remove-by-reference,
    // so only clear it while it is still ours. A later registration on the
    // same session takes ownership and makes this release a no-op.
    const releaseSession = (): void => {
      if (filterOwners.get(overlaySession) !== ownershipToken) {
        return;
      }
      filterOwners.delete(overlaySession);
      try {
        overlaySession.webRequest.onBeforeRequest(null);
      } catch {
        // The session is already gone with the window.
      }
    };
    created.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    created.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        hideWindow(created);
      }
    });
    created.on("blur", () => {
      hideWindow(created);
    });
    created.on("closed", () => {
      if (overlayWindow === created) {
        overlayWindow = null;
        loadedOrigin = null;
        cancelOperations();
        releaseSession();
      }
    });
    overlayReleaseSession = releaseSession;
    overlayWindow = created;
    return created;
  }

  // An operation is current while the controller is alive, nothing newer or a
  // hide superseded it, and the app origin it started with is still the app.
  function isCurrent(token: number, appOrigin: string): boolean {
    return (
      !disposed && token === generation && args.getAppOrigin() === appOrigin
    );
  }

  async function loadPanel(
    target: NonNullable<OverlaySettings["target"]>,
    token: number,
    stillAuthorized: () => boolean,
  ): Promise<OverlayOpenPanelResult> {
    const stale: OverlayOpenPanelResult = {
      ok: false,
      reason: "The overlay request was superseded.",
    };
    const appOrigin = args.getAppOrigin();
    if (appOrigin === null) {
      return { ok: false, reason: "The app is not loaded." };
    }
    let available: boolean;
    try {
      available = await args.registry.isPanelRouteAvailable(target);
    } catch {
      available = false;
    }
    if (!isCurrent(token, appOrigin) || !stillAuthorized()) {
      return stale;
    }
    if (!available) {
      return { ok: false, reason: "Unknown plugin or panel route." };
    }
    const url = resolveOverlayPanelUrl({ appOrigin, request: target });
    if (!isOverlayNavigationAllowed({ appOrigin, url })) {
      return { ok: false, reason: "Unknown plugin or panel route." };
    }
    const window = ensureWindow();
    loadedOrigin = null;
    try {
      await window.webContents.loadURL(url);
    } catch (error) {
      if (!isCurrent(token, appOrigin)) {
        return stale;
      }
      return {
        ok: false,
        reason: `Loading the panel failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (
      !isCurrent(token, appOrigin) ||
      !stillAuthorized() ||
      window.isDestroyed() ||
      liveWindow() !== window
    ) {
      return stale;
    }
    loadedOrigin = appOrigin;
    return { ok: true };
  }

  async function handleOpenPanel(
    event: OverlayIpcInvokeEvent,
    payload: unknown,
  ): Promise<OverlayOpenPanelResult> {
    const window = liveWindow();
    const appOrigin = args.getAppOrigin();
    const senderOk = (): boolean => {
      const current = liveWindow();
      return (
        !disposed &&
        current !== null &&
        current === window &&
        event.sender === current.webContents &&
        event.senderFrame !== null &&
        event.senderFrame === current.webContents.mainFrame &&
        isOverlayNavigationAllowed({
          appOrigin: args.getAppOrigin(),
          url: event.senderFrame.url,
        })
      );
    };
    if (appOrigin === null || !senderOk()) {
      return { ok: false, reason: "Sender is not the overlay." };
    }
    const request = parseOverlayOpenPanelRequest(payload);
    if (request === null) {
      return { ok: false, reason: "Invalid panel request." };
    }
    generation += 1;
    pendingToken = null;
    return loadPanel(request, generation, senderOk);
  }

  const controller: OverlayController = {
    dispose() {
      disposed = true;
      cancelOperations();
      unregisterCurrent();
      args.ipcMain.removeHandler(BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL);
      const window = liveWindow();
      overlayWindow = null;
      loadedOrigin = null;
      overlayReleaseSession?.();
      overlayReleaseSession = null;
      window?.destroy();
    },
    getRegisteredAccelerator() {
      return registeredAccelerator;
    },
    async rebind(accelerator) {
      if (disposed) {
        return { ok: false, reason: "The overlay is shut down." };
      }
      if (!isValidOverlayAccelerator(accelerator)) {
        return {
          ok: false,
          reason: `"${accelerator}" is not a valid shortcut.`,
        };
      }
      const previous = registeredAccelerator;
      if (previous === accelerator) {
        return { accelerator, ok: true };
      }
      unregisterCurrent();
      const result = registerAccelerator(accelerator);
      if (!result.ok) {
        let reason = result.reason;
        if (previous !== null) {
          const restored = registerAccelerator(previous);
          if (!restored.ok) {
            reason = `${result.reason} The previous shortcut ${previous} could not be restored: ${restored.reason} No overlay shortcut is registered.`;
          }
        }
        args.report(reason);
        return { ok: false, reason };
      }
      try {
        await args.settingsStore.save({
          ...args.settingsStore.get(),
          accelerator,
        });
      } catch (error) {
        args.report(
          `Saving the overlay shortcut failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return result;
    },
    async start() {
      args.ipcMain.handle(
        BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL,
        handleOpenPanel,
      );
      const result = registerAccelerator(args.settingsStore.get().accelerator);
      if (!result.ok) {
        args.report(result.reason);
      }
      return result;
    },
    async toggle() {
      if (disposed) {
        return;
      }
      const window = liveWindow();
      if (window !== null && window.isVisible()) {
        hideWindow(window);
        return;
      }
      if (pendingToken !== null) {
        // A second toggle while the first is still loading means "close":
        // cancel the pending show instead of starting another load.
        cancelOperations();
        if (window !== null) {
          hideWindow(window);
        }
        return;
      }
      const target = args.settingsStore.get().target;
      if (target === null) {
        args.report("No overlay panel is configured.");
        return;
      }
      generation += 1;
      const token = generation;
      pendingToken = token;
      const sameTarget = (): boolean => {
        const latest = args.settingsStore.get().target;
        return (
          latest !== null &&
          latest.pluginId === target.pluginId &&
          latest.panelId === target.panelId
        );
      };
      try {
        const appOrigin = args.getAppOrigin();
        if (window === null || loadedOrigin !== appOrigin) {
          const loaded = await loadPanel(target, token, sameTarget);
          if (token !== generation) {
            return;
          }
          if (!loaded.ok) {
            args.report(loaded.reason);
            return;
          }
        }
        const shown = liveWindow();
        if (
          shown === null ||
          token !== generation ||
          disposed ||
          loadedOrigin !== args.getAppOrigin() ||
          !sameTarget()
        ) {
          return;
        }
        shown.center();
        shown.show();
        shown.focus();
      } catch (error) {
        args.report(
          `Showing the overlay failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (pendingToken === token) {
          pendingToken = null;
        }
      }
    },
  };
  return controller;
}
