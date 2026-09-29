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

function press(target: Element | Window, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    key,
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
});
