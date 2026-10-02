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

export interface OverlayWebContents {
  loadURL(url: string): Promise<void>;
  mainFrame: OverlayFrame;
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
    created.webContents.on("will-attach-webview", (event) => {
      event.preventDefault();
    });
    created.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "Escape") {
        event.preventDefault();
        created.hide();
      }
    });
    created.on("blur", () => {
      if (!created.isDestroyed()) {
        created.hide();
      }
    });
    created.on("closed", () => {
      if (overlayWindow === created) {
        overlayWindow = null;
        loadedOrigin = null;
      }
    });
    overlayWindow = created;
    return created;
  }

  async function loadPanel(
    target: NonNullable<OverlaySettings["target"]>,
  ): Promise<OverlayOpenPanelResult> {
    const appOrigin = args.getAppOrigin();
    if (appOrigin === null) {
      return { ok: false, reason: "The app is not loaded." };
    }
    if (!(await args.registry.isPanelRouteAvailable(target))) {
      return { ok: false, reason: "Unknown plugin or panel route." };
    }
    const url = resolveOverlayPanelUrl({ appOrigin, request: target });
    if (!isOverlayNavigationAllowed({ appOrigin, url })) {
      return { ok: false, reason: "Unknown plugin or panel route." };
    }
    const window = ensureWindow();
    try {
      await window.webContents.loadURL(url);
    } catch (error) {
      return {
        ok: false,
        reason: `Loading the panel failed: ${error instanceof Error ? error.message : String(error)}`,
      };
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
    if (
      window === null ||
      event.sender !== window.webContents ||
      event.senderFrame === null ||
      event.senderFrame !== window.webContents.mainFrame ||
      !isOverlayNavigationAllowed({
        appOrigin,
        url: event.senderFrame.url,
      })
    ) {
      return { ok: false, reason: "Sender is not the overlay." };
    }
    const request = parseOverlayOpenPanelRequest(payload);
    if (request === null) {
      return { ok: false, reason: "Invalid panel request." };
    }
    return loadPanel(request);
  }

  const controller: OverlayController = {
    dispose() {
      unregisterCurrent();
      args.ipcMain.removeHandler(BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL);
      const window = liveWindow();
      overlayWindow = null;
      loadedOrigin = null;
      window?.destroy();
    },
    getRegisteredAccelerator() {
      return registeredAccelerator;
    },
    async rebind(accelerator) {
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
        if (previous !== null) {
          registerAccelerator(previous);
        }
        args.report(result.reason);
        return result;
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
      const window = liveWindow();
      if (window !== null && window.isVisible()) {
        window.hide();
        return;
      }
      const target = args.settingsStore.get().target;
      if (target === null) {
        args.report("No overlay panel is configured.");
        return;
      }
      if (window === null || loadedOrigin !== args.getAppOrigin()) {
        const loaded = await loadPanel(target);
        if (!loaded.ok) {
          args.report(loaded.reason);
          return;
        }
      }
      const shown = ensureWindow();
      shown.center();
      shown.show();
      shown.focus();
    },
  };
  return controller;
}
