// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BB_DESKTOP_BROWSER_EDITABLE_FOCUS_CHANNEL } from "../src/desktop-browser-ipc.js";

const electron = vi.hoisted(() => ({
  exposeInIsolatedWorld: vi.fn(),
  send: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: { exposeInIsolatedWorld: electron.exposeInIsolatedWorld },
  ipcRenderer: { send: electron.send },
}));

function editableReports(): boolean[] {
  return electron.send.mock.calls
    .filter(
      ([channel]) => channel === BB_DESKTOP_BROWSER_EDITABLE_FOCUS_CHANNEL,
    )
    .map(([, editable]) => editable as boolean);
}

beforeAll(async () => {
  await import("../src/browser-page-preload.js");
});

beforeEach(() => {
  electron.send.mockClear();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("browser page preload editable focus reporting", () => {
  it("reports focus entering and leaving a page text field", async () => {
    const input = document.createElement("input");
    document.body.appendChild(input);

    input.focus();
    input.blur();

    expect(editableReports()).toEqual([true, false]);
  });

  it("reports focus inside a same-origin iframe through the frame's own events", async () => {
    const frame = document.createElement("iframe");
    document.body.appendChild(frame);
    const inner = frame.contentDocument;
    if (inner === null) throw new Error("expected same-origin frame");
    const input = inner.createElement("input");
    inner.body.appendChild(input);

    frame.focus();
    expect(editableReports()).toEqual([]);

    input.focus();
    expect(editableReports()).toEqual([true]);

    input.blur();
    expect(editableReports()).toEqual([true, false]);
  });

  it("reports focus moving into a frame nested inside a same-origin frame", async () => {
    const outer = document.createElement("iframe");
    document.body.appendChild(outer);
    const outerDocument = outer.contentDocument;
    if (outerDocument === null) throw new Error("expected same-origin frame");
    const nested = outerDocument.createElement("iframe");
    outerDocument.body.appendChild(nested);
    const nestedDocument = nested.contentDocument;
    if (nestedDocument === null) throw new Error("expected same-origin frame");
    const input = nestedDocument.createElement("input");
    nestedDocument.body.appendChild(input);

    outer.focus();
    nested.focus();
    input.focus();
    expect(editableReports()).toEqual([true]);

    input.blur();
    expect(editableReports()).toEqual([true, false]);
  });
});
