// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAppSettings, type AppCommandId } from "@bb/domain";
import {
  AppCommandProvider,
  useAppCommandRunner,
  type AppCommandRunner,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { SidebarHistoryNavigationControls } from "@/components/sidebar/SidebarHistoryNavigationControls";
import { resetAppRouteHistoryForTest } from "@/lib/app-route-history";
import { HistoryNavigationCommandHandler } from "./HistoryNavigationCommandHandler";

function historyBinding(
  command: AppCommandId,
  key: string,
  none: readonly string[],
  all: readonly string[] = ["mainSurface"],
) {
  return {
    command,
    desktopOnly: false,
    shortcut: {
      key,
      mod: false,
      meta: false,
      control: true,
      alt: false,
      shift: false,
    },
    when: { all, none },
  };
}

const HISTORY_NONE = ["modalOpen", "editableFocus", "terminalFocus"];

const testState = vi.hoisted(() => ({
  keybindings: [] as unknown[],
  onAppCommand: null as null | ((command: string) => void),
  desktop: false,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: defaultAppSettings,
      keybindings: testState.keybindings,
    },
  }),
}));

vi.mock("@/lib/bb-desktop", () => ({
  getBbDesktopInfo: () =>
    testState.desktop
      ? {
          onAppCommand: (listener: (command: string) => void) => {
            testState.onAppCommand = listener;
            return () => {
              testState.onAppCommand = null;
            };
          },
        }
      : null,
}));

function Location() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function Nav({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(to)}>
      {to}
    </button>
  );
}

function BrowserHandler({
  command,
  calls,
  canHandle = true,
}: {
  command: AppCommandId;
  calls: string[];
  canHandle?: boolean;
}) {
  useAppCommandHandler(command, () => {
    if (!canHandle) return false;
    calls.push(command);
    return true;
  });
  return null;
}

function renderHarness(extra?: React.ReactNode) {
  return render(
    <MemoryRouter initialEntries={["/a"]}>
      <AppCommandProvider>
        <HistoryNavigationCommandHandler />
        <Location />
        <Nav to="/a" />
        <Nav to="/b" />
        <Nav to="/c" />
        <input aria-label="composer" />
        <div contentEditable suppressContentEditableWarning data-testid="ce" />
        <div data-app-browser>
          <input aria-label="address" />
          <button type="button">page</button>
        </div>
        {extra}
      </AppCommandProvider>
    </MemoryRouter>,
  );
}

function press(
  target: Element | Window,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: true,
    key,
    ...init,
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

function location(): string {
  return screen.getByTestId("location").textContent ?? "";
}

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  resetAppRouteHistoryForTest();
  vi.restoreAllMocks();
  testState.keybindings = [];
  testState.desktop = false;
  testState.onAppCommand = null;
});

function useHistoryBindings() {
  testState.keybindings = [
    historyBinding("history.back", "[", HISTORY_NONE),
    historyBinding("history.forward", "]", HISTORY_NONE),
    historyBinding(
      "browser.back",
      "[",
      ["modalOpen", "editableFocus"],
      ["mainSurface", "browserFocus"],
    ),
    historyBinding(
      "browser.forward",
      "]",
      ["modalOpen", "editableFocus"],
      ["mainSurface", "browserFocus"],
    ),
  ];
}

describe("HistoryNavigationCommandHandler", () => {
  it("goes back and forward through visited views", () => {
    useHistoryBindings();
    renderHarness();
    fireEvent.click(screen.getByText("/b"));
    fireEvent.click(screen.getByText("/c"));
    expect(location()).toBe("/c");

    expect(press(window, "[").defaultPrevented).toBe(true);
    expect(location()).toBe("/b");
    press(window, "[");
    expect(location()).toBe("/a");
    press(window, "]");
    expect(location()).toBe("/b");
    press(window, "]");
    expect(location()).toBe("/c");
  });

  it("does nothing at the start of history instead of leaving the app", () => {
    useHistoryBindings();
    renderHarness();
    const event = press(window, "[");
    expect(location()).toBe("/a");
    expect(event.defaultPrevented).toBe(false);
  });

  it("is ignored while focus is in an input or contenteditable", () => {
    useHistoryBindings();
    renderHarness();
    fireEvent.click(screen.getByText("/b"));

    const input = screen.getByLabelText("composer");
    expect(press(input, "[").defaultPrevented).toBe(false);
    expect(location()).toBe("/b");
    expect(press(screen.getByTestId("ce"), "[").defaultPrevented).toBe(false);
    expect(location()).toBe("/b");
  });

  it("targets the in-panel browser page when the browser panel is focused", () => {
    useHistoryBindings();
    const calls: string[] = [];
    renderHarness(
      <>
        <BrowserHandler command="browser.back" calls={calls} />
        <BrowserHandler command="browser.forward" calls={calls} />
      </>,
    );
    fireEvent.click(screen.getByText("/b"));
    const page = screen.getByText("page");

    press(page, "[");
    press(page, "]");
    expect(calls).toEqual(["browser.back", "browser.forward"]);
    expect(location()).toBe("/b");
  });

  it("runs from a menu command dispatched without a keyboard target", () => {
    useHistoryBindings();
    const captured: { runner: AppCommandRunner | null } = { runner: null };
    function Capture() {
      const runner = useAppCommandRunner();
      useEffect(() => {
        captured.runner = runner;
      }, [runner]);
      return null;
    }
    renderHarness(<Capture />);
    fireEvent.click(screen.getByText("/b"));

    act(() => {
      captured.runner?.dispatch("history.back", null);
    });
    expect(location()).toBe("/a");
    act(() => {
      captured.runner?.dispatch("history.forward", null);
    });
    expect(location()).toBe("/b");
  });

  it("falls through to app history when the focused browser tab cannot navigate", () => {
    useHistoryBindings();
    const calls: string[] = [];
    renderHarness(
      <>
        <BrowserHandler
          command="browser.back"
          calls={calls}
          canHandle={false}
        />
        <BrowserHandler
          command="browser.forward"
          calls={calls}
          canHandle={false}
        />
      </>,
    );
    fireEvent.click(screen.getByText("/b"));
    fireEvent.click(screen.getByText("/c"));
    const page = screen.getByText("page");

    expect(press(page, "[").defaultPrevented).toBe(true);
    expect(location()).toBe("/b");
    press(page, "]");
    expect(location()).toBe("/c");
    expect(calls).toEqual([]);
  });

  it("ignores the chord while the browser address input is focused", () => {
    useHistoryBindings();
    const calls: string[] = [];
    renderHarness(
      <>
        <BrowserHandler command="browser.back" calls={calls} />
        <BrowserHandler command="browser.forward" calls={calls} />
      </>,
    );
    fireEvent.click(screen.getByText("/b"));
    const address = screen.getByLabelText("address");

    expect(press(address, "[").defaultPrevented).toBe(false);
    expect(press(address, "]").defaultPrevented).toBe(false);
    expect(calls).toEqual([]);
    expect(location()).toBe("/b");
  });

  it("navigates exactly one entry per chord", () => {
    useHistoryBindings();
    renderHarness();
    fireEvent.click(screen.getByText("/b"));
    fireEvent.click(screen.getByText("/c"));
    press(window, "[");
    expect(location()).toBe("/b");
  });

  it("falls through from a native browser view chord to app history when the tab cannot navigate", () => {
    useHistoryBindings();
    testState.desktop = true;
    const calls: string[] = [];
    const { rerender } = renderHarness(
      <BrowserHandler command="browser.back" calls={calls} canHandle={false} />,
    );
    fireEvent.click(screen.getByText("/b"));
    expect(location()).toBe("/b");

    act(() => testState.onAppCommand?.("browser.back"));
    expect(location()).toBe("/a");
    expect(calls).toEqual([]);

    fireEvent.click(screen.getByText("/c"));
    rerender(
      <MemoryRouter initialEntries={["/a"]}>
        <AppCommandProvider>
          <HistoryNavigationCommandHandler />
          <Location />
          <Nav to="/c" />
          <BrowserHandler command="browser.back" calls={calls} />
        </AppCommandProvider>
      </MemoryRouter>,
    );
    act(() => testState.onAppCommand?.("browser.back"));
    expect(calls).toEqual(["browser.back"]);
  });

  it("skips adjacent duplicate entries exactly like the sidebar buttons", () => {
    useHistoryBindings();
    renderHarness(<SidebarHistoryNavigationControls />);
    fireEvent.click(screen.getByRole("button", { name: "/b" }));
    fireEvent.click(screen.getByRole("button", { name: "/b" }));
    fireEvent.click(screen.getByRole("button", { name: "/c" }));
    expect(location()).toBe("/c");

    press(window, "[");
    expect(location()).toBe("/b");
    press(window, "[");
    expect(location()).toBe("/a");
    press(window, "]");
    expect(location()).toBe("/b");
    press(window, "]");
    expect(location()).toBe("/c");

    fireEvent.click(screen.getByLabelText("Go back"));
    fireEvent.click(screen.getByLabelText("Go back"));
    expect(location()).toBe("/a");
  });

  it("skips adjacent duplicate entries for menu-dispatched commands", () => {
    useHistoryBindings();
    const captured: { runner: AppCommandRunner | null } = { runner: null };
    function Capture() {
      const runner = useAppCommandRunner();
      useEffect(() => {
        captured.runner = runner;
      }, [runner]);
      return null;
    }
    renderHarness(<Capture />);
    fireEvent.click(screen.getByRole("button", { name: "/b" }));
    fireEvent.click(screen.getByRole("button", { name: "/b" }));
    fireEvent.click(screen.getByRole("button", { name: "/c" }));

    act(() => {
      captured.runner?.dispatch("history.back", null);
    });
    act(() => {
      captured.runner?.dispatch("history.back", null);
    });
    expect(location()).toBe("/a");
    act(() => {
      captured.runner?.dispatch("history.forward", null);
    });
    act(() => {
      captured.runner?.dispatch("history.forward", null);
    });
    expect(location()).toBe("/c");
  });

  it("does not consume the chord at the last entry", () => {
    useHistoryBindings();
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "/b" }));
    const event = press(window, "]");
    expect(event.defaultPrevented).toBe(false);
    expect(location()).toBe("/b");
  });

  it("does not consume the chord when every earlier entry is the current route", () => {
    useHistoryBindings();
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "/a" }));
    expect(location()).toBe("/a");
    expect(press(window, "[").defaultPrevented).toBe(false);
  });

  it("mirrors the buttons' disabled state at a restored history entry", () => {
    useHistoryBindings();
    render(
      <MemoryRouter initialEntries={["/a", "/b", "/c"]} initialIndex={2}>
        <AppCommandProvider>
          <HistoryNavigationCommandHandler />
          <SidebarHistoryNavigationControls />
          <Location />
        </AppCommandProvider>
      </MemoryRouter>,
    );
    expect(screen.getByLabelText<HTMLButtonElement>("Go back").disabled).toBe(
      true,
    );
    expect(press(window, "[").defaultPrevented).toBe(false);
    expect(location()).toBe("/c");
  });

  it("ignores composing and repeated chords", () => {
    useHistoryBindings();
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "/b" }));

    expect(press(window, "[", { isComposing: true }).defaultPrevented).toBe(
      false,
    );
    expect(location()).toBe("/b");
    expect(press(window, "[", { repeat: true }).defaultPrevented).toBe(false);
    expect(location()).toBe("/b");
  });

  it("does not resolve shortcut lookups for composing or repeated chords", () => {
    useHistoryBindings();
    const captured: { runner: AppCommandRunner | null } = { runner: null };
    function Capture() {
      const runner = useAppCommandRunner();
      useEffect(() => {
        captured.runner = runner;
      }, [runner]);
      return null;
    }
    renderHarness(<Capture />);
    const chord = (init: KeyboardEventInit) =>
      new KeyboardEvent("keydown", { ctrlKey: true, key: "[", ...init });

    expect(
      captured.runner?.getShortcutCommand(chord({}), ["history.back"]),
    ).toBe("history.back");
    expect(
      captured.runner?.getShortcutCommand(chord({ isComposing: true }), [
        "history.back",
      ]),
    ).toBeNull();
    expect(
      captured.runner?.getShortcutCommand(chord({ repeat: true }), [
        "history.back",
      ]),
    ).toBeNull();
  });

  describe("shadow-root editors", () => {
    function attachShadowContent(hostTag: string, innerTag: string) {
      const host = document.createElement(hostTag);
      document.body.appendChild(host);
      const inner = document.createElement(innerTag);
      host.attachShadow({ mode: "open" }).appendChild(inner);
      return { host, inner };
    }

    it.each(["div", "x-editor"])(
      "leaves the chord alone for an input inside an open shadow root on <%s>",
      (hostTag) => {
        useHistoryBindings();
        renderHarness();
        fireEvent.click(screen.getByRole("button", { name: "/b" }));
        const { inner } = attachShadowContent(hostTag, "input");
        inner.focus();

        const event = press(inner, "[");
        expect(event.defaultPrevented).toBe(false);
        expect(location()).toBe("/b");
      },
    );

    it("reads the editor from the event path when document focus is elsewhere", () => {
      useHistoryBindings();
      renderHarness();
      fireEvent.click(screen.getByRole("button", { name: "/b" }));
      const { inner } = attachShadowContent("div", "input");

      expect(press(inner, "[").defaultPrevented).toBe(false);
      expect(location()).toBe("/b");
    });

    it("still navigates from a non-editable control inside a shadow root", () => {
      useHistoryBindings();
      renderHarness();
      fireEvent.click(screen.getByRole("button", { name: "/b" }));
      const { inner } = attachShadowContent("div", "button");
      inner.focus();

      expect(press(inner, "[").defaultPrevented).toBe(true);
      expect(location()).toBe("/a");
    });

    it("leaves the chord alone for a focused custom element it cannot inspect", () => {
      useHistoryBindings();
      renderHarness();
      fireEvent.click(screen.getByRole("button", { name: "/b" }));
      const host = document.createElement("x-opaque");
      host.tabIndex = 0;
      document.body.appendChild(host);
      host.focus();

      expect(press(host, "[").defaultPrevented).toBe(false);
      expect(location()).toBe("/b");
    });
  });

  describe("default desktop-only bindings", () => {
    function useDefaultHistoryBindings() {
      const when = {
        all: ["mainSurface"],
        none: ["modalOpen", "editableFocus", "terminalFocus"],
      };
      const shortcut = (key: string) => ({
        key,
        mod: true,
        meta: false,
        control: false,
        alt: false,
        shift: false,
      });
      testState.keybindings = [
        {
          command: "history.back",
          desktopOnly: true,
          shortcut: shortcut("["),
          when,
        },
        {
          command: "history.forward",
          desktopOnly: true,
          shortcut: shortcut("]"),
          when,
        },
      ];
    }

    it("navigates with the platform modifier on desktop", () => {
      useDefaultHistoryBindings();
      testState.desktop = true;
      vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
      renderHarness();
      fireEvent.click(screen.getByRole("button", { name: "/b" }));

      expect(press(window, "[").defaultPrevented).toBe(true);
      expect(location()).toBe("/a");
      expect(
        press(window, "[", { ctrlKey: false, metaKey: true }).defaultPrevented,
      ).toBe(false);
    });

    it("uses Cmd on macOS", () => {
      useDefaultHistoryBindings();
      testState.desktop = true;
      vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      renderHarness();
      fireEvent.click(screen.getByRole("button", { name: "/b" }));

      expect(press(window, "[").defaultPrevented).toBe(false);
      expect(
        press(window, "[", { ctrlKey: false, metaKey: true }).defaultPrevented,
      ).toBe(true);
      expect(location()).toBe("/a");
    });

    it("is inert in the web app", () => {
      useDefaultHistoryBindings();
      testState.desktop = false;
      vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
      renderHarness();
      fireEvent.click(screen.getByRole("button", { name: "/b" }));

      expect(press(window, "[").defaultPrevented).toBe(false);
      expect(location()).toBe("/b");
    });
  });
});
