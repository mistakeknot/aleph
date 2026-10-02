import { describe, expect, it, vi } from "vitest";
import {
  BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL,
  DEFAULT_OVERLAY_ACCELERATOR,
  isValidOverlayAccelerator,
  overlaySettingsSchema,
} from "../src/overlay-contract.js";
import {
  isOverlayNavigationAllowed,
  type OverlayPluginRegistry,
} from "../src/overlay-panel.js";
import { createServerPluginRegistry } from "../src/overlay-registry.js";
import { createOverlaySettingsStore } from "../src/overlay-settings.js";
import {
  createOverlayController,
  type OverlayBrowserWindow,
  type OverlayIpcInvokeEvent,
  type OverlayWebContents,
} from "../src/overlay-window.js";
import type { BrowserWindowConstructorOptions } from "electron";

const APP_ORIGIN = "http://127.0.0.1:3000";

type Listener = (...args: never[]) => void;

function createFakeWebContents(): OverlayWebContents & {
  emit(eventName: string, ...args: unknown[]): void;
  loadURL: ReturnType<typeof vi.fn>;
  openHandler: (() => { action: "deny" }) | null;
} {
  const listeners = new Map<string, Listener[]>();
  const contents = {
    emit(eventName: string, ...args: unknown[]) {
      for (const listener of listeners.get(eventName) ?? []) {
        (listener as (...rest: unknown[]) => void)(...args);
      }
    },
    loadURL: vi.fn(() => Promise.resolve()),
    mainFrame: { url: `${APP_ORIGIN}/plugins/autarch/overlay` },
    on(eventName: string, listener: Listener) {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]);
    },
    openHandler: null as (() => { action: "deny" }) | null,
    setWindowOpenHandler(handler: () => { action: "deny" }) {
      contents.openHandler = handler;
    },
  };
  return contents as never;
}

function createFakeWindow() {
  const webContents = createFakeWebContents();
  const listeners = new Map<string, Listener[]>();
  let visible = false;
  let destroyed = false;
  const window = {
    center: vi.fn(),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
    focus: vi.fn(),
    hide: vi.fn(() => {
      visible = false;
    }),
    isDestroyed: () => destroyed,
    isVisible: () => visible,
    on(eventName: string, listener: Listener) {
      listeners.set(eventName, [...(listeners.get(eventName) ?? []), listener]);
    },
    setAlwaysOnTop: vi.fn(),
    show: vi.fn(() => {
      visible = true;
    }),
    webContents,
  };
  return {
    emit(eventName: string) {
      for (const listener of listeners.get(eventName) ?? []) {
        (listener as () => void)();
      }
    },
    window: window as unknown as OverlayBrowserWindow,
    ...window,
    webContents,
  };
}

interface HarnessOptions {
  appOrigin?: string | null;
  registerResult?: boolean | "throw";
  settings?: { accelerator?: string; target?: unknown };
  allowedRoutes?: string[];
}

function createHarness(options: HarnessOptions = {}) {
  const created: ReturnType<typeof createFakeWindow>[] = [];
  const createdOptions: BrowserWindowConstructorOptions[] = [];
  const handlers = new Map<
    string,
    (e: OverlayIpcInvokeEvent, p: unknown) => Promise<unknown>
  >();
  const shortcuts = new Map<string, () => void>();
  const reports: string[] = [];
  const allowed = new Set(options.allowedRoutes ?? ["autarch/overlay"]);
  const registry: OverlayPluginRegistry = {
    isPanelRouteAvailable: (request) =>
      Promise.resolve(allowed.has(`${request.pluginId}/${request.panelId}`)),
  };
  const globalShortcut = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (options.registerResult === "throw") {
        throw new Error("boom");
      }
      if (options.registerResult === false) {
        return false;
      }
      shortcuts.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      shortcuts.delete(accelerator);
    }),
  };
  const ipcMain = {
    handle: vi.fn(
      (
        channel: string,
        listener: (e: OverlayIpcInvokeEvent, p: unknown) => Promise<unknown>,
      ) => {
        handlers.set(channel, listener);
      },
    ),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  };
  const stored = overlaySettingsSchema.parse(
    options.settings ?? {
      target: { panelId: "overlay", pluginId: "autarch" },
    },
  );
  const settingsStore = {
    get: () => ({ ...stored }),
    load: vi.fn(() => Promise.resolve()),
    save: vi.fn((next: typeof stored) => {
      Object.assign(stored, next);
      return Promise.resolve();
    }),
  };
  const appOrigin =
    options.appOrigin === undefined ? APP_ORIGIN : options.appOrigin;
  const controller = createOverlayController({
    createWindow(windowOptions) {
      createdOptions.push(windowOptions);
      const fake = createFakeWindow();
      created.push(fake);
      return fake.window;
    },
    getAppOrigin: () => appOrigin,
    globalShortcut,
    ipcMain,
    preloadPath: "/dist/overlay-preload.cjs",
    registry,
    report: (message) => reports.push(message),
    settingsStore,
  });
  async function invoke(
    payload: unknown,
    sender?: Partial<OverlayIpcInvokeEvent>,
  ): Promise<unknown> {
    const handler = handlers.get(BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL);
    if (handler === undefined) {
      throw new Error("no handler");
    }
    const overlay = created[0];
    return handler(
      {
        sender: overlay?.webContents ?? createFakeWebContents(),
        senderFrame: overlay?.webContents.mainFrame ?? { url: "" },
        ...sender,
      },
      payload,
    );
  }
  return {
    controller,
    created,
    createdOptions,
    globalShortcut,
    handlers,
    invoke,
    ipcMain,
    reports,
    settingsStore,
    shortcuts,
  };
}

describe("overlay bridge", () => {
  async function started(options: HarnessOptions = {}) {
    const harness = createHarness(options);
    await harness.controller.start();
    await harness.controller.toggle();
    return harness;
  }

  it("accepts a valid installed plugin and panel route and loads its URL on the app origin", async () => {
    const h = await started();
    h.created[0]?.webContents.loadURL.mockClear();
    expect(await h.invoke({ panelId: "overlay", pluginId: "autarch" })).toEqual(
      { ok: true },
    );
    expect(h.created[0]?.webContents.loadURL).toHaveBeenCalledWith(
      `${APP_ORIGIN}/plugins/autarch/overlay`,
    );
  });

  it.each([
    ["unknown plugin", { panelId: "overlay", pluginId: "ghost" }],
    ["unknown route", { panelId: "nope", pluginId: "autarch" }],
    ["a URL string", "http://127.0.0.1:3000/plugins/autarch/overlay"],
    ["javascript:", { panelId: "overlay", pluginId: "javascript:alert(1)" }],
    ["file:", { panelId: "overlay", pluginId: "file:///etc/passwd" }],
    [
      "a full URL as plugin id",
      { panelId: "x", pluginId: "https://evil.example" },
    ],
    ["path traversal in route", { panelId: "../../api", pluginId: "autarch" }],
    ["encoded traversal", { panelId: "%2e%2e", pluginId: "autarch" }],
    ["slash in plugin", { panelId: "overlay", pluginId: "autarch/../x" }],
    ["extra fields", { extra: 1, panelId: "overlay", pluginId: "autarch" }],
    ["null payload", null],
  ])("refuses %s without loading anything", async (_label, payload) => {
    const h = await started();
    h.created[0]?.webContents.loadURL.mockClear();
    const result = await h.invoke(payload);
    expect(result).toMatchObject({ ok: false });
    expect(h.created[0]?.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("refuses a call from a different sender", async () => {
    const h = await started();
    h.created[0]?.webContents.loadURL.mockClear();
    const result = await h.invoke(
      { panelId: "overlay", pluginId: "autarch" },
      { sender: createFakeWebContents() },
    );
    expect(result).toEqual({ ok: false, reason: "Sender is not the overlay." });
    expect(h.created[0]?.webContents.loadURL).not.toHaveBeenCalled();
  });

  it("refuses a call from a subframe of the overlay", async () => {
    const h = await started();
    const result = await h.invoke(
      { panelId: "overlay", pluginId: "autarch" },
      { senderFrame: { url: `${APP_ORIGIN}/plugins/autarch/overlay` } },
    );
    expect(result).toMatchObject({ ok: false });
  });

  it("refuses a call from an overlay frame that left the app origin", async () => {
    const h = await started();
    const overlay = h.created[0];
    const result = await h.invoke(
      { panelId: "overlay", pluginId: "autarch" },
      { senderFrame: { url: "https://evil.example/plugins/a/b" } },
    );
    expect(result).toMatchObject({ ok: false });
    expect(overlay?.webContents.loadURL).toHaveBeenCalledTimes(1);
  });

  it("refuses when no overlay window exists", async () => {
    const h = createHarness();
    await h.controller.start();
    expect(await h.invoke({ panelId: "overlay", pluginId: "autarch" })).toEqual(
      { ok: false, reason: "Sender is not the overlay." },
    );
  });

  it("refuses when the app origin is unknown", async () => {
    const h = createHarness({ appOrigin: null });
    await h.controller.start();
    await h.controller.toggle();
    expect(h.created).toHaveLength(0);
  });
});

describe("overlay window", () => {
  it("creates a frameless always-on-top window with locked-down webPreferences", async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.toggle();
    const options = h.createdOptions[0];
    expect(options).toMatchObject({
      alwaysOnTop: true,
      frame: false,
      skipTaskbar: true,
    });
    expect(options?.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      preload: "/dist/overlay-preload.cjs",
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    });
  });

  it("denies window.open and webviews, and blocks off-origin navigation", async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.toggle();
    const contents = h.created[0]?.webContents;
    expect(contents?.openHandler?.()).toEqual({ action: "deny" });

    const blocked = [
      "https://evil.example/plugins/a/b",
      "javascript:alert(1)",
      "file:///etc/passwd",
      `${APP_ORIGIN}/api/v1/plugins`,
      `${APP_ORIGIN}/plugins/a/b%2f..%2fapi`,
      "http://user:pw@127.0.0.1:3000/plugins/a/b",
      "not a url",
    ];
    for (const url of blocked) {
      const preventDefault = vi.fn();
      contents?.emit("will-navigate", { preventDefault }, url);
      contents?.emit("will-redirect", { preventDefault }, url);
      expect(preventDefault, url).toHaveBeenCalledTimes(2);
    }
    const allowed = vi.fn();
    contents?.emit(
      "will-navigate",
      { preventDefault: allowed },
      `${APP_ORIGIN}/plugins/autarch/overlay/sub?x=1`,
    );
    expect(allowed).not.toHaveBeenCalled();
    const webview = vi.fn();
    contents?.emit("will-attach-webview", { preventDefault: webview });
    expect(webview).toHaveBeenCalled();
  });

  it("toggles visibility, hides on Escape and on blur", async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.toggle();
    const overlay = h.created[0];
    expect(overlay?.show).toHaveBeenCalledTimes(1);
    await h.controller.toggle();
    expect(overlay?.hide).toHaveBeenCalledTimes(1);
    await h.controller.toggle();
    expect(overlay?.show).toHaveBeenCalledTimes(2);
    const escape = vi.fn();
    overlay?.webContents.emit(
      "before-input-event",
      { preventDefault: escape },
      { key: "Escape", type: "keyDown" },
    );
    expect(overlay?.hide).toHaveBeenCalledTimes(2);
    await h.controller.toggle();
    overlay?.emit("blur");
    expect(overlay?.hide).toHaveBeenCalledTimes(3);
    expect(h.created).toHaveLength(1);
  });

  it("reports instead of showing a blank overlay when no panel is configured", async () => {
    const h = createHarness({ settings: {} });
    await h.controller.start();
    await h.controller.toggle();
    expect(h.created).toHaveLength(0);
    expect(h.reports).toContain("No overlay panel is configured.");
  });

  it("does not show a window for a configured panel that is not installed", async () => {
    const h = createHarness({ allowedRoutes: [] });
    await h.controller.start();
    await h.controller.toggle();
    expect(h.created).toHaveLength(0);
    expect(h.reports.at(-1)).toBe("Unknown plugin or panel route.");
  });
});

describe("overlay shortcut", () => {
  it("registers the persisted accelerator and toggles through it", async () => {
    const h = createHarness({
      settings: {
        accelerator: "Alt+Space",
        target: { panelId: "overlay", pluginId: "autarch" },
      },
    });
    expect(await h.controller.start()).toEqual({
      accelerator: "Alt+Space",
      ok: true,
    });
    h.shortcuts.get("Alt+Space")?.();
    await vi.waitFor(() => expect(h.created).toHaveLength(1));
  });

  it("defaults to the documented accelerator", async () => {
    const h = createHarness();
    await h.controller.start();
    expect(h.globalShortcut.register).toHaveBeenCalledWith(
      DEFAULT_OVERLAY_ACCELERATOR,
      expect.any(Function),
    );
  });

  it("reports a conflict without throwing when register returns false", async () => {
    const h = createHarness({ registerResult: false });
    const result = await h.controller.start();
    expect(result.ok).toBe(false);
    expect(h.reports[0]).toContain("unavailable");
    expect(h.controller.getRegisteredAccelerator()).toBeNull();
    expect(h.handlers.has(BB_DESKTOP_OVERLAY_OPEN_PANEL_CHANNEL)).toBe(true);
  });

  it("reports a conflict without throwing when register throws", async () => {
    const h = createHarness({ registerResult: "throw" });
    const result = await h.controller.start();
    expect(result).toMatchObject({ ok: false });
    expect(h.reports[0]).toContain("boom");
  });

  it("rebinds: unregisters the old accelerator, registers the new one, persists", async () => {
    const h = createHarness();
    await h.controller.start();
    const result = await h.controller.rebind("CommandOrControl+Alt+O");
    expect(result).toEqual({ accelerator: "CommandOrControl+Alt+O", ok: true });
    expect(h.globalShortcut.unregister).toHaveBeenCalledWith(
      DEFAULT_OVERLAY_ACCELERATOR,
    );
    expect([...h.shortcuts.keys()]).toEqual(["CommandOrControl+Alt+O"]);
    expect(h.settingsStore.save).toHaveBeenCalledWith(
      expect.objectContaining({ accelerator: "CommandOrControl+Alt+O" }),
    );
  });

  it("keeps the old binding and does not persist when the new one conflicts", async () => {
    const h = createHarness();
    await h.controller.start();
    h.globalShortcut.register.mockImplementationOnce(() => false);
    const result = await h.controller.rebind("Alt+Space");
    expect(result.ok).toBe(false);
    expect(h.controller.getRegisteredAccelerator()).toBe(
      DEFAULT_OVERLAY_ACCELERATOR,
    );
    expect(h.settingsStore.save).not.toHaveBeenCalled();
  });

  it.each(["", "Space", "Ctrl+Shift", "Bogus+A", "Ctrl+Ctrl+A", "Ctrl+A+B"])(
    "refuses to rebind to invalid accelerator %j",
    async (accelerator) => {
      const h = createHarness();
      await h.controller.start();
      h.globalShortcut.register.mockClear();
      expect((await h.controller.rebind(accelerator)).ok).toBe(false);
      expect(h.globalShortcut.register).not.toHaveBeenCalled();
      expect(h.controller.getRegisteredAccelerator()).toBe(
        DEFAULT_OVERLAY_ACCELERATOR,
      );
    },
  );

  it("unregisters the shortcut, the ipc handler and the window on dispose (will-quit)", async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.toggle();
    h.controller.dispose();
    expect(h.shortcuts.size).toBe(0);
    expect(h.handlers.size).toBe(0);
    expect(h.created[0]?.destroy).toHaveBeenCalled();
    expect(h.controller.getRegisteredAccelerator()).toBeNull();
  });
});

describe("accelerator and settings validation", () => {
  it.each([
    "CommandOrControl+Shift+Space",
    "Alt+F12",
    "Ctrl+Alt+`",
    "Super+Plus",
  ])("accepts %s", (accelerator) => {
    expect(isValidOverlayAccelerator(accelerator)).toBe(true);
  });

  it.each(["A", "Shift", "Ctrl+", "+A", "Ctrl+F25", `Ctrl+${"A".repeat(80)}`])(
    "rejects %j",
    (accelerator) => {
      expect(isValidOverlayAccelerator(accelerator)).toBe(false);
    },
  );

  it("falls back to defaults for a corrupt settings file", async () => {
    const store = createOverlaySettingsStore({
      fs: {
        mkdir: () => Promise.resolve(undefined),
        readFile: () => Promise.resolve('{"accelerator":"nope"}'),
        writeFile: () => Promise.resolve(),
      },
      storagePath: "/tmp/x/overlay-settings.json",
    });
    await store.load();
    expect(store.get()).toEqual({
      accelerator: DEFAULT_OVERLAY_ACCELERATOR,
      target: null,
    });
  });

  it("round-trips valid settings and refuses to save invalid ones", async () => {
    let written = "";
    const store = createOverlaySettingsStore({
      fs: {
        mkdir: () => Promise.resolve(undefined),
        readFile: () => Promise.resolve(written),
        writeFile: (_path, data) => {
          written = data;
          return Promise.resolve();
        },
      },
      storagePath: "/tmp/x/overlay-settings.json",
    });
    await store.save({
      accelerator: "Alt+Space",
      target: { panelId: "overlay", pluginId: "autarch" },
    });
    await store.load();
    expect(store.get().accelerator).toBe("Alt+Space");
    await expect(
      store.save({ accelerator: "bad", target: null }),
    ).rejects.toThrow();
  });
});

describe("navigation allow-list", () => {
  it("requires the app origin and the plugins path", () => {
    expect(
      isOverlayNavigationAllowed({
        appOrigin: APP_ORIGIN,
        url: `${APP_ORIGIN}/plugins/autarch/overlay`,
      }),
    ).toBe(true);
    expect(
      isOverlayNavigationAllowed({
        appOrigin: null,
        url: `${APP_ORIGIN}/plugins/autarch/overlay`,
      }),
    ).toBe(false);
    expect(
      isOverlayNavigationAllowed({
        appOrigin: APP_ORIGIN,
        url: "http://127.0.0.1:3001/plugins/autarch/overlay",
      }),
    ).toBe(false);
  });
});

describe("server plugin registry", () => {
  function registryFor(body: unknown, ok = true) {
    return createServerPluginRegistry({
      fetchImpl: vi.fn(() =>
        Promise.resolve({ json: () => Promise.resolve(body), ok }),
      ) as never,
      getAppOrigin: () => APP_ORIGIN,
    });
  }
  const plugin = (over: Record<string, unknown> = {}) => ({
    app: { bundle: { compatible: true }, hasApp: true },
    enabled: true,
    id: "autarch",
    ...over,
  });
  const request = { panelId: "overlay", pluginId: "autarch" };

  it("accepts an enabled installed plugin with a compatible app bundle", async () => {
    expect(
      await registryFor({ plugins: [plugin()] }).isPanelRouteAvailable(request),
    ).toBe(true);
  });

  it.each([
    ["disabled", { plugins: [plugin({ enabled: false })] }],
    ["no app", { plugins: [plugin({ app: { bundle: null, hasApp: false } })] }],
    [
      "incompatible bundle",
      {
        plugins: [
          plugin({ app: { bundle: { compatible: false }, hasApp: true } }),
        ],
      },
    ],
    ["absent", { plugins: [plugin({ id: "other" })] }],
    ["malformed", { plugins: "x" }],
  ])("refuses a plugin that is %s", async (_label, body) => {
    expect(await registryFor(body).isPanelRouteAvailable(request)).toBe(false);
  });

  it("refuses on a failed response, a thrown fetch, or an unknown origin", async () => {
    expect(
      await registryFor({ plugins: [plugin()] }, false).isPanelRouteAvailable(
        request,
      ),
    ).toBe(false);
    expect(
      await createServerPluginRegistry({
        fetchImpl: vi.fn(() => Promise.reject(new Error("down"))) as never,
        getAppOrigin: () => APP_ORIGIN,
      }).isPanelRouteAvailable(request),
    ).toBe(false);
    expect(
      await createServerPluginRegistry({
        fetchImpl: vi.fn() as never,
        getAppOrigin: () => null,
      }).isPanelRouteAvailable(request),
    ).toBe(false);
  });
});
