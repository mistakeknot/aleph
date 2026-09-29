// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { hasEditableFocus } from "../src/editable-focus.js";

afterEach(() => {
  document.body.replaceChildren();
  document.designMode = "off";
});

function append<K extends keyof HTMLElementTagNameMap>(
  parent: Node,
  tag: K,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const element =
    parent.ownerDocument?.createElement(tag) ?? document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  parent.appendChild(element);
  return element;
}

function appendCustom(
  parent: Node,
  tag: string,
  attributes: Record<string, string> = {},
): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  parent.appendChild(element);
  return element;
}

describe("hasEditableFocus", () => {
  it("is false when nothing is focused", () => {
    expect(hasEditableFocus(document)).toBe(false);
  });

  it("treats text inputs, textareas and selects as editable", () => {
    for (const element of [
      append(document.body, "input"),
      append(document.body, "input", { type: "search" }),
      append(document.body, "textarea"),
      append(document.body, "select"),
    ]) {
      element.focus();
      expect(hasEditableFocus(document)).toBe(true);
      element.blur();
    }
  });

  it("treats non-text inputs and buttons as not editable", () => {
    for (const element of [
      append(document.body, "button"),
      append(document.body, "input", { type: "checkbox" }),
      append(document.body, "input", { type: "button" }),
      append(document.body, "input", { type: "radio" }),
      append(document.body, "input", { type: "submit" }),
    ]) {
      element.focus();
      expect(document.activeElement).toBe(element);
      expect(hasEditableFocus(document)).toBe(false);
      element.blur();
    }
  });

  it("treats contenteditable roots and their descendants as editable", () => {
    const root = append(document.body, "div", {
      contenteditable: "true",
      tabindex: "0",
    });
    root.focus();
    expect(hasEditableFocus(document)).toBe(true);
    const child = append(root, "span", { tabindex: "0" });
    child.focus();
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("does not treat contenteditable=false as editable", () => {
    const element = append(document.body, "div", {
      contenteditable: "false",
      tabindex: "0",
    });
    element.focus();
    expect(hasEditableFocus(document)).toBe(false);
  });

  it("treats ARIA text-entry roles as editable", () => {
    const element = append(document.body, "div", {
      role: "textbox",
      tabindex: "0",
    });
    element.focus();
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("treats designMode documents as editable", () => {
    const element = append(document.body, "button");
    element.focus();
    document.designMode = "on";
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("descends into shadow roots", () => {
    const host = append(document.body, "div");
    const shadow = host.attachShadow({ mode: "open" });
    const input = append(shadow, "input");
    input.focus();
    expect(document.activeElement).toBe(host);
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("descends through nested shadow roots and allows navigation on a shadow button", () => {
    const outer = append(document.body, "div");
    const outerShadow = outer.attachShadow({ mode: "open" });
    const inner = append(outerShadow, "div");
    const innerShadow = inner.attachShadow({ mode: "open" });
    const button = append(innerShadow, "button");
    button.focus();
    expect(hasEditableFocus(document)).toBe(false);
    const input = append(innerShadow, "input");
    input.focus();
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("fails safe for a host whose closed shadow root cannot be inspected", () => {
    const host = appendCustom(document.body, "x-editor", { tabindex: "0" });
    const shadow = host.attachShadow({ mode: "closed" });
    const input = append(shadow, "input");
    input.focus();
    expect(document.activeElement).toBe(host);
    expect(host.shadowRoot).toBeNull();
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("fails safe for a focused custom element without a shadow root", () => {
    const element = appendCustom(document.body, "my-widget", { tabindex: "0" });
    element.focus();
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("allows navigation for a focused custom element with an inspectable shadow root", () => {
    const host = appendCustom(document.body, "x-menu", { tabindex: "0" });
    append(host.attachShadow({ mode: "open" }), "button");
    host.focus();
    expect(hasEditableFocus(document)).toBe(false);
  });

  it("allows navigation for a plain focused div", () => {
    const element = append(document.body, "div", { tabindex: "0" });
    element.focus();
    expect(document.activeElement).toBe(element);
    expect(hasEditableFocus(document)).toBe(false);
  });

  it("descends into same-origin iframes", () => {
    const frame = append(document.body, "iframe");
    const inner = frame.contentDocument;
    expect(inner).not.toBeNull();
    if (inner === null) return;
    const input = append(inner.body, "input");
    const button = append(inner.body, "button");
    frame.focus();
    button.focus();
    expect(document.activeElement).toBe(frame);
    expect(hasEditableFocus(document)).toBe(false);
    input.focus();
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("descends from an iframe into a shadow root inside it", () => {
    const frame = append(document.body, "iframe");
    const inner = frame.contentDocument;
    if (inner === null) throw new Error("expected same-origin frame");
    const host = append(inner.body, "div");
    const input = append(host.attachShadow({ mode: "open" }), "input");
    frame.focus();
    input.focus();
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("fails safe for a focused iframe whose document cannot be inspected", () => {
    const frame = append(document.body, "iframe");
    Object.defineProperty(frame, "contentDocument", { get: () => null });
    frame.focus();
    expect(document.activeElement).toBe(frame);
    expect(hasEditableFocus(document)).toBe(true);
  });

  it("fails safe when reading the frame document throws", () => {
    const frame = append(document.body, "iframe");
    Object.defineProperty(frame, "contentDocument", {
      get: () => {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    frame.focus();
    expect(hasEditableFocus(document)).toBe(true);
  });
});
