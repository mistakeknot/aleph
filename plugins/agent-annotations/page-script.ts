import type { PageAnnotation } from "./annotations.js";

interface PageBridge {
  postMessage(data: unknown): void;
}

interface AnnotationPageState {
  active: boolean;
  count: number;
}

interface AnnotationController {
  activate(): AnnotationPageState;
  deactivate(): AnnotationPageState;
  state(): AnnotationPageState;
  setTheme(theme: Record<string, string>): void;
  clear(): AnnotationPageState;
  restore(records: Array<PageAnnotation & { author: string }>): void;
}

interface PinnedAnnotation {
  id: string;
  number: number;
  comment: string;
  element: Element;
  pin: HTMLElement;
  outline: HTMLElement;
}

export const ANNOTATION_CONTROLLER_KEY = "__bbAgentAnnotations";

export const THEME_TOKENS = [
  "canvas",
  "ink",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "muted-foreground",
  "border",
  "ring",
  "destructive",
  "state-hover",
  "font-sans",
  "font-mono",
  "radius",
] as const;

function installAgentAnnotations(
  bb: PageBridge | null,
  theme: Record<string, string>,
  connect = false,
): AnnotationPageState {
  const existing: AnnotationController | undefined = Reflect.get(
    globalThis,
    "__bbAgentAnnotations",
  );
  if (existing !== undefined) {
    existing.setTheme(theme);
    return existing.state();
  }

  const attributePrefix = "data-bb-annotation-";
  const attributeKeys = [
    "id",
    "class",
    "role",
    "aria-label",
    "name",
    "type",
    "href",
    "src",
    "alt",
    "placeholder",
    "title",
    "data-testid",
  ];
  const styleKeys = [
    "display",
    "position",
    "width",
    "height",
    "margin",
    "padding",
    "gap",
    "color",
    "background-color",
    "font-family",
    "font-size",
    "font-weight",
    "line-height",
    "border",
    "border-radius",
  ];
  const css = `
    .connect-bar { position: fixed; right: 12px; top: 12px; pointer-events: auto; background: var(--bb-canvas); color: var(--bb-ink); border: 1px solid var(--bb-border); border-radius: 8px; padding: 8px; font: 14px system-ui; max-width: min(360px, 90vw); }
    .connect-list { max-height: 50vh; overflow: auto; }
    .connect-list button { display: block; white-space: normal; height: auto; text-align: left; padding: 8px; }
    .connect-send { display: block; padding: 8px 10px; }
    .hover, .outline, .label, .pin, .editor { position: fixed; box-sizing: border-box; }
    .hover { display: none; pointer-events: none; border: 1.5px solid var(--bb-primary); border-radius: 4px; background: color-mix(in oklab, var(--bb-primary) 10%, transparent); }
    .outline { pointer-events: none; border: 1.5px dashed color-mix(in oklab, var(--bb-primary) 70%, transparent); border-radius: 4px; }
    .label { display: none; pointer-events: none; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 2px 6px; border-radius: 6px; background: var(--bb-primary); color: var(--bb-primary-foreground); font: 500 11px/16px var(--bb-font-mono, ui-monospace, monospace); }
    .pin { pointer-events: auto; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 999px; background: var(--bb-primary); color: var(--bb-primary-foreground); font: 600 11px/20px var(--bb-font-sans, system-ui, sans-serif); text-align: center; box-shadow: 0 0 0 2px var(--bb-canvas), 0 1px 4px rgb(0 0 0 / 0.3); cursor: pointer; padding: 0; border: 0; }
    .pin:focus-visible { outline: 2px solid var(--bb-ring); outline-offset: 2px; }
    .editor { pointer-events: auto; width: 320px; max-width: calc(100vw - 16px); max-height: calc(100vh - 16px); overflow-y: auto; border: 1px solid var(--bb-border); border-radius: calc(var(--bb-radius, 0.5rem) + 4px); background: var(--bb-popover); color: var(--bb-popover-foreground); box-shadow: 0 12px 32px color-mix(in oklab, var(--bb-ink) 22%, transparent); font: 400 13px/1.4 var(--bb-font-sans, system-ui, sans-serif); }
    .editor-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px 0; min-width: 0; }
    .editor-title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; color: var(--bb-muted-foreground); font: 500 11px/18px var(--bb-font-mono, ui-monospace, monospace); }
    .target-tag { flex-shrink: 0; color: var(--bb-popover-foreground); background: var(--bb-state-hover); padding: 0 6px; border-radius: 5px; white-space: nowrap; }
    .target-text { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
    .editor-number { flex-shrink: 0; width: 18px; height: 18px; border-radius: 999px; background: var(--bb-primary); color: var(--bb-primary-foreground); font: 600 10px/18px var(--bb-font-sans, system-ui, sans-serif); text-align: center; }
    textarea { box-sizing: border-box; display: block; width: calc(100% - 20px); min-height: 68px; max-height: 240px; resize: vertical; margin: 8px 10px 0; padding: 7px 9px; border: 1px solid var(--bb-border); border-radius: 7px; background: var(--bb-canvas); color: inherit; font: inherit; outline: none; }
    textarea::placeholder { color: var(--bb-muted-foreground); }
    textarea:focus { border-color: var(--bb-ring); box-shadow: 0 0 0 3px color-mix(in oklab, var(--bb-ring) 12%, transparent); }
    .actions { display: flex; align-items: center; gap: 6px; padding: 8px 10px 10px; min-width: 0; }
    button { flex-shrink: 0; white-space: nowrap; height: 28px; padding: 0 11px; border: 1px solid transparent; border-radius: 7px; font: 500 12px/16px var(--bb-font-sans, system-ui, sans-serif); cursor: pointer; }
    button:focus-visible { outline: 2px solid var(--bb-ring); outline-offset: 1px; }
    .cancel { margin-left: auto; border-color: var(--bb-border); background: transparent; color: inherit; }
    .delete { padding: 0 6px; margin-left: -6px; background: transparent; color: var(--bb-muted-foreground); }
    .delete:hover { color: var(--bb-destructive, var(--bb-ink)); background: color-mix(in oklab, var(--bb-destructive, var(--bb-ink)) 8%, transparent); }
    .cancel:hover { background: var(--bb-state-hover); }
    .save { background: var(--bb-primary); color: var(--bb-primary-foreground); }
    .save:hover { filter: brightness(1.08); }
    .save:disabled { opacity: 0.45; cursor: default; filter: none; }

  `;

  const host = document.createElement("bb-agent-annotations");
  host.style.cssText =
    "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
  const root = host.attachShadow({ mode: "open" });
  if (typeof CSSStyleSheet === "function" && "adoptedStyleSheets" in root) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } else {
    const style = document.createElement("style");
    style.textContent = css;
    root.append(style);
  }
  const hoverBox = part("div", "hover");
  const hoverLabel = part("div", "label");
  root.append(hoverBox, hoverLabel);

  let active = false;
  let hovered: Element | null = null;
  let editor: HTMLElement | null = null;
  let nextNumber = 1;
  let frame = 0;
  const annotations: PinnedAnnotation[] = [];
  const bar = part("div", "connect-bar");
  const toggle = part("button", "connect-toggle");
  const showAll = part("button", "connect-all");
  const list = part("div", "connect-list");
  const status = part("div", "connect-status");
  let records: Array<PageAnnotation & { author: string }> = [];
  if (connect) {
    document.documentElement.append(host);
    showAll.textContent = "Show all comments";
    list.hidden = true;
    showAll.addEventListener("click", () => {
      list.hidden = !list.hidden;
      renderList();
    });
    toggle.addEventListener("click", () => {
      active ? deactivate() : activate();
      renderList();
    });
    bar.append(toggle, showAll, list, status);
    root.append(bar);
    renderList();
  }

  function anchored(record: PageAnnotation): Element | null {
    try {
      const found = document.querySelectorAll(record.element.selector);
      const element = found.length === 1 ? found[0] : null;
      const text =
        element instanceof HTMLElement && typeof element.innerText === "string"
          ? element.innerText
          : (element?.textContent ?? "");
      return element && collapse(text).slice(0, 160) === record.element.text
        ? element
        : null;
    } catch {
      return null;
    }
  }

  function renderList(): void {
    toggle.textContent = `${active ? "Exit comments" : "Comment"} · ${records.length} open comments`;
    toggle.setAttribute("aria-pressed", String(active));
    list.replaceChildren();
    for (const record of records) {
      const row = part("button", "connect-row");
      const element = anchored(record);
      row.textContent = `${record.number}. ${record.author}: ${record.comment}${element ? "" : " (outdated)"}`;
      row.addEventListener("click", () => {
        const current = anchored(record);
        if (!current) {
          row.textContent = `${record.number}. ${record.author}: ${record.comment} (outdated)`;
          return;
        }
        activate();
        current.scrollIntoView({ block: "center" });
        const annotation = annotations.find((item) => item.id === record.id);
        if (annotation) openEditor(current, annotation);
      });
      list.append(row);
    }
  }

  function restore(next: Array<PageAnnotation & { author: string }>): void {
    clear();
    records = next;
    for (const record of records) {
      nextNumber = Math.max(nextNumber, record.number + 1);
      const element = anchored(record);
      if (!element) continue;
      const pin = part("button", "pin");
      pin.textContent = String(record.number);
      pin.title = `${record.author}: ${record.comment}`;
      pin.setAttribute(
        "aria-label",
        `${record.number}. ${record.author}: ${record.comment}`,
      );
      const outline = part("div", "outline");
      const annotation = { ...record, element, pin, outline };
      annotations.push(annotation);
      pin.addEventListener("click", () => openEditor(element, annotation));
      root.append(outline, pin);
    }
    reposition();
    syncLoop();
    renderList();
  }

  function part(tagName: string, className: string): HTMLElement {
    const node = document.createElement(tagName);
    node.className = className;
    return node;
  }

  function setTheme(next: Record<string, string>): void {
    for (const [name, value] of Object.entries(next)) {
      host.style.setProperty(name, value);
    }
  }

  function state(): AnnotationPageState {
    return { active, count: annotations.length };
  }

  function post(message: unknown): void {
    bb?.postMessage(message);
  }

  function escapeIdentifier(value: string): string {
    return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  }

  function collapse(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function elementName(element: Element): string {
    const id = element.id.length > 0 ? `#${element.id}` : "";
    const classes = Array.from(element.classList)
      .slice(0, 2)
      .map((name) => `.${name}`)
      .join("");
    const text = collapse(element.textContent ?? "");
    const label =
      element.getAttribute("aria-label") ??
      (text.length > 0 && text.length <= 40 ? text : "");
    const suffix = label.length > 0 ? ` "${label.slice(0, 40)}"` : "";
    return `${element.tagName.toLowerCase()}${id}${classes}${suffix}`.slice(
      0,
      200,
    );
  }

  function selectorFor(element: Element): string {
    const segments: string[] = [];
    let current: Element | null = element;
    while (
      current !== null &&
      current !== document.documentElement &&
      segments.length < 8
    ) {
      if (
        current.id.length > 0 &&
        document.querySelectorAll(`#${escapeIdentifier(current.id)}`).length ===
          1
      ) {
        segments.unshift(`#${escapeIdentifier(current.id)}`);
        break;
      }
      const tagName = current.tagName;
      const parent: Element | null = current.parentElement;
      const siblings =
        parent === null
          ? []
          : Array.from(parent.children).filter(
              (child) => child.tagName === tagName,
            );
      const position = siblings.indexOf(current) + 1;
      segments.unshift(
        siblings.length > 1
          ? `${tagName.toLowerCase()}:nth-of-type(${position})`
          : tagName.toLowerCase(),
      );
      current = parent;
    }
    return segments.join(" > ").slice(0, 2000);
  }

  function describe(element: Element) {
    const rect = element.getBoundingClientRect();
    const computed = getComputedStyle(element);
    const attributes: Record<string, string> = {};
    for (const key of attributeKeys) {
      const value = element.getAttribute(key);
      if (value !== null && value.length > 0) {
        attributes[key] = value.slice(0, 400);
      }
    }
    const styles: Record<string, string> = {};
    for (const key of styleKeys) {
      const value = computed.getPropertyValue(key);
      if (value.length > 0) {
        styles[key] = value.slice(0, 400);
      }
    }
    const visibleText =
      element instanceof HTMLElement && typeof element.innerText === "string"
        ? element.innerText
        : (element.textContent ?? "");
    return {
      tagName: element.tagName.toLowerCase().slice(0, 64),
      name: elementName(element),
      selector: selectorFor(element),
      text: collapse(visibleText).slice(0, 160),
      attributes,
      rect: {
        x: Math.round(rect.left + scrollX),
        y: Math.round(rect.top + scrollY),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      styles,
    };
  }

  function place(node: HTMLElement, rect: DOMRect): void {
    node.style.left = `${rect.left}px`;
    node.style.top = `${rect.top}px`;
    node.style.width = `${rect.width}px`;
    node.style.height = `${rect.height}px`;
  }

  function showHover(element: Element | null): void {
    hovered = element;
    if (element === null) {
      hoverBox.style.display = "none";
      hoverLabel.style.display = "none";
      return;
    }
    const rect = element.getBoundingClientRect();
    place(hoverBox, rect);
    hoverBox.style.display = "block";
    hoverLabel.textContent = `${elementName(element)}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
    hoverLabel.style.display = "block";
    hoverLabel.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - 324))}px`;
    hoverLabel.style.top = `${rect.top > 26 ? rect.top - 24 : rect.bottom + 4}px`;
  }

  function targetAt(x: number, y: number): Element | null {
    for (const element of document.elementsFromPoint(x, y)) {
      if (
        element === host ||
        element === document.documentElement ||
        element === document.body
      ) {
        continue;
      }
      return element;
    }
    return null;
  }

  function reposition(): void {
    for (const annotation of annotations) {
      const rect = annotation.element.getBoundingClientRect();
      const visible =
        annotation.element.isConnected && rect.width + rect.height > 0;
      annotation.pin.style.display =
        visible && (!connect || active) ? "block" : "none";
      annotation.pin.style.left = `${rect.left}px`;
      annotation.pin.style.top = `${rect.top}px`;
      annotation.outline.style.display = visible && active ? "block" : "none";
      place(annotation.outline, rect);
    }
    if (hovered !== null && editor === null) {
      showHover(hovered);
    }
  }

  function tick(): void {
    frame = 0;
    reposition();
    syncLoop();
  }

  function syncLoop(): void {
    const needed = active || annotations.length > 0;
    if (needed && frame === 0) {
      frame = requestAnimationFrame(tick);
    } else if (!needed && frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  }

  function closeEditor(): void {
    editor?.remove();
    editor = null;
  }

  function commit(element: Element, comment: string): void {
    const trimmed = comment.trim();
    if (trimmed.length === 0) {
      return;
    }
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    element.setAttribute(`${attributePrefix}${id}`, "");
    const number = nextNumber;
    nextNumber += 1;
    const pin = part("button", "pin");
    pin.setAttribute("type", "button");
    pin.setAttribute("aria-label", `Edit annotation ${number}`);
    pin.textContent = String(number);
    pin.title = trimmed;
    const outline = part("div", "outline");
    root.append(outline, pin);
    const annotation = {
      id,
      number,
      comment: trimmed.slice(0, 4000),
      element,
      pin,
      outline,
    };
    annotations.push(annotation);
    pin.addEventListener("click", () => openEditor(element, annotation));
    closeEditor();
    showHover(null);
    reposition();
    syncLoop();
    post({
      type: "annotation",
      annotation: {
        id,
        number,
        comment: trimmed.slice(0, 4000),
        url: location.href.slice(0, 4096),
        title: document.title.slice(0, 1024),
        viewport: { width: innerWidth, height: innerHeight },
        element: describe(element),
      },
    });
    post({ type: "state", ...state() });
  }

  function remove(annotation: PinnedAnnotation): void {
    const index = annotations.indexOf(annotation);
    if (index < 0) return;
    annotation.element.removeAttribute(`${attributePrefix}${annotation.id}`);
    annotation.pin.remove();
    annotation.outline.remove();
    annotations.splice(index, 1);
    closeEditor();
    showHover(null);
    syncLoop();
    post({ type: "annotation-delete", id: annotation.id });
    post({ type: "state", ...state() });
  }

  function update(annotation: PinnedAnnotation, comment: string): void {
    const trimmed = comment.trim().slice(0, 4000);
    if (trimmed.length === 0) {
      return;
    }
    annotation.comment = trimmed;
    annotation.pin.title = trimmed;
    closeEditor();
    showHover(null);
    post({ type: "annotation-update", id: annotation.id, comment: trimmed });
  }

  function openEditor(
    element: Element,
    annotation: PinnedAnnotation | null = null,
  ): void {
    closeEditor();
    showHover(element);
    const rect = element.getBoundingClientRect();
    const panel = part("div", "editor");
    panel.setAttribute("role", "dialog");
    panel.setAttribute(
      "aria-label",
      annotation === null
        ? "New annotation"
        : `Edit annotation ${annotation.number}`,
    );
    const header = part("div", "editor-head");
    if (annotation !== null) {
      const number = part("span", "editor-number");
      number.textContent = String(annotation.number);
      header.append(number);
    }
    const title = part("div", "editor-title");
    title.title = elementName(element);
    const tag = part("span", "target-tag");
    tag.textContent = element.tagName.toLowerCase();
    const targetText = part("span", "target-text");
    targetText.textContent =
      element.getAttribute("aria-label") ??
      collapse(element.textContent ?? "").slice(0, 160);
    title.append(tag, targetText);
    header.append(title);
    const textarea = document.createElement("textarea");
    textarea.placeholder = "What should change?";
    textarea.rows = 3;
    textarea.maxLength = 4000;
    textarea.value = annotation?.comment ?? "";
    textarea.setAttribute("aria-label", "Annotation comment");
    const submit = () =>
      annotation === null
        ? commit(element, textarea.value)
        : update(annotation, textarea.value);
    const actions = part("div", "actions");
    const cancel = part("button", "cancel");
    cancel.textContent = "Cancel";
    cancel.title = "Escape";
    const save = part("button", "save");
    save.textContent =
      annotation === null ? (connect ? "Save note" : "Add to prompt") : "Save";
    save.title = /Mac/.test(navigator.platform) ? "⌘+Enter" : "Ctrl+Enter";
    save.toggleAttribute("disabled", textarea.value.trim().length === 0);
    if (annotation !== null) {
      const deleteButton = part("button", "delete");
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => remove(annotation));
      actions.append(deleteButton);
    }
    actions.append(cancel, save);
    panel.append(header, textarea, actions);
    if (connect) {
      const label = part("label", "connect-send");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.disabled = true;
      label.append(checkbox, "Send to thread — sending arrives in next update");
      panel.append(label);
    }
    root.append(panel);
    editor = panel;
    const panelRect = panel.getBoundingClientRect();
    const below = rect.bottom + 8;
    const preferredTop =
      below + panelRect.height <= innerHeight - 8
        ? below
        : rect.top - panelRect.height - 8;
    panel.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - panelRect.width - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(preferredTop, innerHeight - panelRect.height - 8))}px`;
    textarea.addEventListener("input", () => {
      save.toggleAttribute("disabled", textarea.value.trim().length === 0);
    });
    textarea.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
      } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });
    cancel.addEventListener("click", () => closeEditor());
    save.addEventListener("click", submit);
    panel.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        closeEditor();
      }
    });
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!active || editor !== null || event.target === host) {
      return;
    }
    showHover(targetAt(event.clientX, event.clientY));
  }

  function swallow(event: Event): void {
    if (!active || event.target === host) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onClick(event: MouseEvent): void {
    if (!active || event.target === host) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (editor !== null) {
      closeEditor();
      return;
    }
    const target = targetAt(event.clientX, event.clientY);
    if (target !== null) {
      openEditor(target);
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (!active || event.key !== "Escape" || event.target === host) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (editor !== null) {
      closeEditor();
      return;
    }
    deactivate();
    post({ type: "state", ...state() });
  }

  function activate(): AnnotationPageState {
    if (!host.isConnected) {
      document.documentElement.append(host);
    }
    if (!active) {
      active = true;
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("pointerdown", swallow, true);
      window.addEventListener("mousedown", swallow, true);
      window.addEventListener("mouseup", swallow, true);
      window.addEventListener("click", onClick, true);
      window.addEventListener("keydown", onKeyDown, true);
      reposition();
      syncLoop();
    }
    return state();
  }

  function deactivate(): AnnotationPageState {
    if (active) {
      active = false;
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerdown", swallow, true);
      window.removeEventListener("mousedown", swallow, true);
      window.removeEventListener("mouseup", swallow, true);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("keydown", onKeyDown, true);
      closeEditor();
      showHover(null);
      reposition();
      syncLoop();
    }
    return state();
  }

  function clear(): AnnotationPageState {
    closeEditor();
    showHover(null);
    for (const annotation of annotations) {
      annotation.element.removeAttribute(`${attributePrefix}${annotation.id}`);
      annotation.pin.remove();
      annotation.outline.remove();
    }
    annotations.length = 0;
    nextNumber = 1;
    syncLoop();
    return state();
  }

  const controller: AnnotationController = {
    activate,
    deactivate,
    state,
    setTheme,
    clear,
    restore,
  };
  Reflect.set(globalThis, "__bbAgentAnnotations", controller);
  setTheme(theme);
  return state();
}

function probeReactComponents(annotationId: string) {
  const element = document.querySelector(
    `[data-bb-annotation-${annotationId}]`,
  );
  if (element === null) {
    return null;
  }
  const fiberKey = Object.keys(element).find(
    (key) =>
      key.startsWith("__reactFiber$") ||
      key.startsWith("__reactInternalInstance$"),
  );
  if (fiberKey === undefined) {
    return { components: [] };
  }
  const components: Array<{ name: string; source: string | null }> = [];
  let fiber = Reflect.get(element, fiberKey);
  let visited = 0;
  while (fiber && components.length < 12 && visited < 500) {
    visited += 1;
    const type = fiber.type;
    const candidate =
      typeof type === "function"
        ? type
        : type !== null && typeof type === "object"
          ? (type.render ?? type.type ?? type)
          : null;
    const name =
      candidate === null
        ? null
        : (type.displayName ?? candidate.displayName ?? candidate.name);
    if (typeof name === "string" && name.length > 0) {
      components.push({ name: name.slice(0, 200), source: sourceOf(fiber) });
    }
    fiber = fiber.return;
  }
  return { components };

  function sourceOf(node: {
    _debugSource?: { fileName?: unknown; lineNumber?: unknown };
    _debugStack?: { stack?: unknown };
  }): string | null {
    const debugSource = node._debugSource;
    if (debugSource !== undefined && typeof debugSource.fileName === "string") {
      return `${debugSource.fileName}:${String(debugSource.lineNumber)}`.slice(
        0,
        1000,
      );
    }
    const stack = node._debugStack?.stack;
    if (typeof stack !== "string") {
      return null;
    }
    const frameLine = stack
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("at "))
      .find(
        (line) =>
          !/react-stack-top-frame|jsx-dev-runtime|jsx-runtime|react-dom|node_modules/.test(
            line,
          ),
      );
    const match = frameLine?.match(/\(?((?:https?|file):\/\/[^\s)]+)\)?$/);
    return (
      match?.[1]?.replace(/\?[^:]*(?=:\d+:\d+$)/, "").slice(0, 1000) ?? null
    );
  }
}

export function buildActivateExpression(theme: Record<string, string>): string {
  return `((install) => { install(bb, ${JSON.stringify(theme)}); return globalThis.${ANNOTATION_CONTROLLER_KEY}.activate(); })(${installAgentAnnotations.toString()})`;
}

function connectBridge(
  install: typeof installAgentAnnotations,
  endpoint: string,
): void {
  if (!("adoptedStyleSheets" in ShadowRoot.prototype)) return;
  let queue = Promise.resolve();
  const page = location.href;
  const url = `${endpoint}?url=${encodeURIComponent(page)}`;
  const status = (message: string) => {
    const node = document
      .querySelector("bb-agent-annotations")
      ?.shadowRoot?.querySelector(".connect-status");
    if (node) node.textContent = message;
  };
  const reload = async (init?: RequestInit) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
    });
    if (!response.ok) throw new Error("Notes could not be saved or loaded");
    const records = await response.json();
    const controller: AnnotationController = Reflect.get(
      globalThis,
      "__bbAgentAnnotations",
    );
    controller.restore(records);
    status("");
  };
  install(
    {
      postMessage(data) {
        if (
          typeof data !== "object" ||
          data === null ||
          Reflect.get(data, "type") === "state"
        )
          return;
        queue = queue
          .then(() =>
            reload({
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(data),
            }),
          )
          .catch(() => status("Notes could not be saved. Reload to retry."));
      },
    },
    {
      "--bb-canvas": "Canvas",
      "--bb-ink": "CanvasText",
      "--bb-popover": "Canvas",
      "--bb-popover-foreground": "CanvasText",
      "--bb-primary": "Highlight",
      "--bb-primary-foreground": "HighlightText",
      "--bb-border": "GrayText",
      "--bb-ring": "Highlight",
      "--bb-muted-foreground": "GrayText",
      "--bb-state-hover": "ButtonFace",
    },
    true,
  );
  queue = reload().catch(() =>
    status("Notes could not be loaded. Reload to retry."),
  );
}

export function buildConnectAnnotationsScript(endpoint: string): string {
  return `(${connectBridge.toString()})(${installAgentAnnotations.toString()}, ${JSON.stringify(endpoint)})`;
}

export function buildControllerExpression(
  method: "deactivate" | "state" | "clear",
): string {
  return `globalThis.${ANNOTATION_CONTROLLER_KEY} ? globalThis.${ANNOTATION_CONTROLLER_KEY}.${method}() : { active: false, count: 0 }`;
}

export function buildReactProbeExpression(annotationId: string): string {
  if (!/^[a-z0-9]+$/.test(annotationId)) {
    throw new Error(`Invalid annotation id: ${annotationId}`);
  }
  return `(${probeReactComponents.toString()})(${JSON.stringify(annotationId)})`;
}
