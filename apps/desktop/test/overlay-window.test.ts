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

type BeforeRequestListener = NonNullable<
  Parameters<OverlayWebContents["session"]["webRequest"]["onBeforeRequest"]>[0]
>;

let nextContentsId = 1;

function createFakeWebContents(): OverlayWebContents & {
  beforeRequest(details: {
    resourceType: string;
    url: string;
    webContentsId?: number;
  }): { cancel?: boolean };
  emit(eventName: string, ...args: unknown[]): void;
  loadURL: ReturnType<typeof vi.fn>;
  openHandler: (() => { action: "deny" }) | null;
} {
  const listeners = new Map<string, Listener[]>();
  let requestListener: BeforeRequestListener | null = null;
  const contents = {
    beforeRequest(details: {
      resourceType: string;
      url: string;
      webContentsId?: number;
    }) {
      let response: { cancel?: boolean } | null = null;
      if (requestListener === null) {
        throw new Error("no webRequest listener installed");
      }
      requestListener(details, (value) => {
        response = value;
      });
      if (response === null) {
        throw new Error("webRequest callback was not called");
      }
      return response as { cancel?: boolean };
    },
    id: nextContentsId++,
    session: {
      webRequest: {
        onBeforeRequest(listener: BeforeRequestListener | null) {
          requestListener = listener;
        },
      },
    },
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
  registry?: OverlayPluginRegistry;
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
  // Production only checks the plugin (the server publishes no panel ids), so
  // this mock must too.
  const allowed = new Set(
    (options.allowedRoutes ?? ["autarch/overlay"]).map(
      (route) => route.split("/")[0],
    ),
  );
  const registry: OverlayPluginRegistry = options.registry ?? {
    isPanelRouteAvailable: (request) =>
      Promise.resolve(allowed.has(request.pluginId)),
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
  let appOrigin =
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
    setOrigin(next: string | null) {
      appOrigin = next;
    },
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

  it("loads an unknown panel id on an installed plugin: production cannot verify panel existence", async () => {
    // The server publishes no panel route ids, so only the plugin is checked;
    // an unknown panel falls through to the app's own not-found view.
    const h = await started();
    h.created[0]?.webContents.loadURL.mockClear();
    expect(await h.invoke({ panelId: "nope", pluginId: "autarch" })).toEqual({
      ok: true,
    });
    expect(h.created[0]?.webContents.loadURL).toHaveBeenCalledWith(
      `${APP_ORIGIN}/plugins/autarch/nope`,
    );
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
    // Same frame identity the controller trusts, now reporting another origin.
    const mainFrame = overlay?.webContents.mainFrame;
    if (mainFrame === undefined) {
      throw new Error("no overlay");
    }
    mainFrame.url = "https://evil.example/plugins/autarch/overlay";
    const result = await h.invoke(
      { panelId: "overlay", pluginId: "autarch" },
      { senderFrame: mainFrame },
    );
    expect(result).toEqual({ ok: false, reason: "Sender is not the overlay." });
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
      fetchImpl: vi.fn(() => {
        const res = new Response(JSON.stringify(body), {
          status: ok ? 200 : 500,
        });
        Object.defineProperty(res, "url", {
          value: `${APP_ORIGIN}/api/v1/plugins`,
        });
        return Promise.resolve(res);
      }) as never,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function gatedRegistry() {
  const gate = deferred<boolean>();
  const registry: OverlayPluginRegistry = {
    isPanelRouteAvailable: () => gate.promise,
  };
  return { gate, registry };
}

describe("overlay frame protection", () => {
  async function opened() {
    const h = createHarness();
    await h.controller.start();
    await h.controller.toggle();
    const contents = h.created[0]?.webContents;
    if (contents === undefined) {
      throw new Error("no overlay");
    }
    return { contents, h };
  }

  it("blocks subframe navigations off the app origin or outside /plugins/", async () => {
    const { contents } = await opened();
    for (const url of [
      "https://evil.example/",
      `${APP_ORIGIN}/api/v1/plugins`,
      "data:text/html,<p>x</p>",
    ]) {
      const preventDefault = vi.fn();
      contents.emit("will-frame-navigate", {
        isMainFrame: false,
        preventDefault,
        url,
      });
      expect(preventDefault, url).toHaveBeenCalledTimes(1);
    }
    const allowed = vi.fn();
    contents.emit("will-frame-navigate", {
      isMainFrame: false,
      preventDefault: allowed,
      url: `${APP_ORIGIN}/plugins/autarch/inner`,
    });
    expect(allowed).not.toHaveBeenCalled();
  });

  it("cancels direct subframe and main-frame document loads and redirect hops that leave the allowed paths", async () => {
    const { contents } = await opened();
    const id = contents.id;
    for (const resourceType of ["subFrame", "mainFrame"]) {
      expect(
        contents.beforeRequest({
          resourceType,
          url: "https://evil.example/",
          webContentsId: id,
        }),
      ).toEqual({ cancel: true });
      // A redirect hop is a fresh onBeforeRequest for the new URL.
      expect(
        contents.beforeRequest({
          resourceType,
          url: `${APP_ORIGIN}/login`,
          webContentsId: id,
        }),
      ).toEqual({ cancel: true });
      expect(
        contents.beforeRequest({
          resourceType,
          url: `${APP_ORIGIN}/plugins/autarch/overlay`,
          webContentsId: id,
        }),
      ).toEqual({ cancel: false });
    }
  });

  it("leaves subresources and other webContents on the shared session alone", async () => {
    const { contents } = await opened();
    expect(
      contents.beforeRequest({
        resourceType: "xhr",
        url: `${APP_ORIGIN}/api/v1/plugins`,
        webContentsId: contents.id,
      }),
    ).toEqual({});
    expect(
      contents.beforeRequest({
        resourceType: "mainFrame",
        url: "https://elsewhere.example/",
        webContentsId: contents.id + 100,
      }),
    ).toEqual({});
  });

  it("releases the session filter on dispose", async () => {
    const { contents, h } = await opened();
    h.controller.dispose();
    expect(() =>
      contents.beforeRequest({
        resourceType: "subFrame",
        url: "https://evil.example/",
        webContentsId: contents.id,
      }),
    ).toThrow("no webRequest listener");
  });
});

describe("overlay lifetime and cancellation", () => {
  it("creates and shows nothing when disposed during the registry lookup", async () => {
    const { gate, registry } = gatedRegistry();
    const h = createHarness({ registry });
    await h.controller.start();
    const toggled = h.controller.toggle();
    h.controller.dispose();
    gate.resolve(true);
    await toggled;
    expect(h.created).toHaveLength(0);
  });

  it("ends hidden after two rapid toggles and never starts a second load", async () => {
    const { gate, registry } = gatedRegistry();
    const h = createHarness({ registry });
    await h.controller.start();
    const first = h.controller.toggle();
    await h.controller.toggle();
    gate.resolve(true);
    await first;
    expect(h.created.flatMap((w) => w.show.mock.calls)).toHaveLength(0);
    expect(
      h.created.flatMap((w) => w.webContents.loadURL.mock.calls),
    ).toHaveLength(0);
  });

  it("does not show when Escape arrives during a pending navigation", async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.toggle();
    const overlay = h.created[0];
    await h.controller.toggle(); // hide
    const load = deferred<void>();
    overlay?.webContents.loadURL.mockImplementationOnce(() => load.promise);
    h.setOrigin("http://127.0.0.1:4000");
    const reopened = h.controller.toggle();
    await vi.waitFor(() =>
      expect(overlay?.webContents.loadURL).toHaveBeenCalledTimes(2),
    );
    overlay?.webContents.emit(
      "before-input-event",
      { preventDefault: vi.fn() },
      { key: "Escape", type: "keyDown" },
    );
    load.resolve();
    await reopened;
    expect(overlay?.show).toHaveBeenCalledTimes(1);
  });

  it("does not show when blur arrives during a pending navigation", async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.toggle();
    const overlay = h.created[0];
    await h.controller.toggle();
    const load = deferred<void>();
    overlay?.webContents.loadURL.mockImplementationOnce(() => load.promise);
    h.setOrigin("http://127.0.0.1:4000");
    const reopened = h.controller.toggle();
    await vi.waitFor(() =>
      expect(overlay?.webContents.loadURL).toHaveBeenCalledTimes(2),
    );
    overlay?.emit("blur");
    load.resolve();
    await reopened;
    expect(overlay?.show).toHaveBeenCalledTimes(1);
  });

  it("aborts without loading when the app origin changes during the lookup", async () => {
    const { gate, registry } = gatedRegistry();
    const h = createHarness({ registry });
    await h.controller.start();
    const toggled = h.controller.toggle();
    h.setOrigin("https://other.example");
    gate.resolve(true);
    await toggled;
    expect(h.created).toHaveLength(0);
  });

  it("aborts the show when the app origin changes during loadURL", async () => {
    const h = createHarness();
    await h.controller.start();
    const load = deferred<void>();
    const originalCreate = h.created.length;
    expect(originalCreate).toBe(0);
    const toggled = h.controller.toggle();
    await vi.waitFor(() => expect(h.created).toHaveLength(1));
    h.created[0]?.webContents.loadURL.mockImplementationOnce(
      () => load.promise,
    );
    // The first load already resolved synchronously; drive a second cycle.
    await toggled;
    await h.controller.toggle(); // hide
    h.setOrigin("https://other.example");
    h.created[0]?.webContents.loadURL.mockImplementationOnce(
      () => load.promise,
    );
    const reopened = h.controller.toggle();
    h.setOrigin(APP_ORIGIN);
    load.resolve();
    await reopened;
    expect(h.created[0]?.show).toHaveBeenCalledTimes(1);
  });

  it("aborts when the configured target changes during the lookup", async () => {
    const { gate, registry } = gatedRegistry();
    const h = createHarness({ registry });
    await h.controller.start();
    const toggled = h.controller.toggle();
    await h.settingsStore.save({
      accelerator: DEFAULT_OVERLAY_ACCELERATOR,
      target: { panelId: "other", pluginId: "autarch" },
    });
    gate.resolve(true);
    await toggled;
    expect(h.created).toHaveLength(0);
  });

  it("reports a loadURL rejection without showing or throwing", async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.toggle();
    const overlay = h.created[0];
    await h.controller.toggle();
    overlay?.webContents.loadURL.mockImplementationOnce(() =>
      Promise.reject(new Error("ERR_FAILED")),
    );
    h.setOrigin("http://127.0.0.1:4000");
    await h.controller.toggle();
    expect(overlay?.show).toHaveBeenCalledTimes(1);
    expect(h.reports.at(-1)).toContain("ERR_FAILED");
  });

  it("survives the window being destroyed mid-flight", async () => {
    const h = createHarness();
    await h.controller.start();
    await h.controller.toggle();
    const overlay = h.created[0];
    await h.controller.toggle();
    const load = deferred<void>();
    overlay?.webContents.loadURL.mockImplementationOnce(() => load.promise);
    h.setOrigin("http://127.0.0.1:4000");
    const reopened = h.controller.toggle();
    await vi.waitFor(() =>
      expect(overlay?.webContents.loadURL).toHaveBeenCalledTimes(2),
    );
    overlay?.destroy();
    overlay?.emit("closed");
    load.reject(new Error("destroyed"));
    await expect(reopened).resolves.toBeUndefined();
    expect(overlay?.show).toHaveBeenCalledTimes(1);
  });

  it("ignores an open-panel call that is superseded by dispose during the lookup", async () => {
    const h = await (async () => {
      const harness = createHarness();
      await harness.controller.start();
      await harness.controller.toggle();
      return harness;
    })();
    h.created[0]?.webContents.loadURL.mockClear();
    const pending = h.invoke({ panelId: "overlay", pluginId: "autarch" });
    h.controller.dispose();
    await pending;
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.webContents.loadURL).not.toHaveBeenCalled();
  });
});

describe("overlay rebind rollback", () => {
  it("reports and stays consistent when the previous shortcut cannot be restored", async () => {
    const h = createHarness();
    await h.controller.start();
    h.globalShortcut.register.mockImplementation(() => false);
    const result = await h.controller.rebind("Alt+Space");
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain(
      "could not be restored",
    );
    expect(h.reports.at(-1)).toContain("could not be restored");
    expect(h.controller.getRegisteredAccelerator()).toBeNull();
    expect(h.settingsStore.save).not.toHaveBeenCalled();
  });
});

describe("server plugin registry hardening", () => {
  const body = JSON.stringify({
    plugins: [
      {
        app: { bundle: { compatible: true }, hasApp: true },
        enabled: true,
        id: "autarch",
      },
    ],
  });
  const request = { panelId: "overlay", pluginId: "autarch" };

  function response(
    text: BodyInit | null,
    over: { redirected?: boolean; url?: string; status?: number } = {},
  ): Response {
    const res = new Response(text, { status: over.status ?? 200 });
    Object.defineProperty(res, "url", {
      value: over.url ?? `${APP_ORIGIN}/api/v1/plugins`,
    });
    Object.defineProperty(res, "redirected", {
      value: over.redirected ?? false,
    });
    return res;
  }
  const registryWith = (
    fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
    extra: { maxBytes?: number; timeoutMs?: number } = {},
  ) =>
    createServerPluginRegistry({
      fetchImpl: fetchImpl as never,
      getAppOrigin: () => APP_ORIGIN,
      ...extra,
    });

  it("requests with redirect: error and an abort signal", async () => {
    const fetchImpl = vi.fn((_input: string, _init?: RequestInit) =>
      Promise.resolve(response(body)),
    );
    expect(await registryWith(fetchImpl).isPanelRouteAvailable(request)).toBe(
      true,
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses a redirected response and a response from another origin", async () => {
    expect(
      await registryWith(() =>
        Promise.resolve(response(body, { redirected: true })),
      ).isPanelRouteAvailable(request),
    ).toBe(false);
    expect(
      await registryWith(() =>
        Promise.resolve(
          response(body, { url: "https://evil.example/api/v1/plugins" }),
        ),
      ).isPanelRouteAvailable(request),
    ).toBe(false);
    expect(
      await registryWith(() =>
        Promise.resolve(response(body, { url: "" })),
      ).isPanelRouteAvailable(request),
    ).toBe(false);
  });

  it("fails closed when the request exceeds the deadline", async () => {
    const hang = (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    expect(
      await registryWith(hang, { timeoutMs: 20 }).isPanelRouteAvailable(
        request,
      ),
    ).toBe(false);
  });

  it("fails closed when the body stalls past the deadline", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"plugins":['));
      },
    });
    expect(
      await registryWith(() => Promise.resolve(response(stalled)), {
        timeoutMs: 20,
      }).isPanelRouteAvailable(request),
    ).toBe(false);
  });

  it("fails closed on an oversized body, declared or streamed", async () => {
    const padded = JSON.stringify({
      pad: "x".repeat(2000),
      plugins: JSON.parse(body).plugins,
    });
    expect(
      await registryWith(() => Promise.resolve(response(padded)), {
        maxBytes: 1000,
      }).isPanelRouteAvailable(request),
    ).toBe(false);
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(padded.slice(0, 1500)));
        controller.enqueue(new TextEncoder().encode(padded.slice(1500)));
        controller.close();
      },
    });
    expect(
      await registryWith(() => Promise.resolve(response(streamed)), {
        maxBytes: 1000,
      }).isPanelRouteAvailable(request),
    ).toBe(false);
    expect(
      await registryWith(() =>
        Promise.resolve(response(padded)),
      ).isPanelRouteAvailable(request),
    ).toBe(true);
  });
});
