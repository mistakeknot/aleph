const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

const TEXT_ENTRY_ROLES = new Set([
  "combobox",
  "searchbox",
  "spinbutton",
  "textbox",
]);

const FRAME_TAGS = new Set(["iframe", "frame"]);

function isFrameElement(element: Element): boolean {
  return FRAME_TAGS.has(element.localName);
}

function isContentEditable(element: Element): boolean {
  const root = element.closest("[contenteditable]");
  if (root === null) return false;
  const value = root.getAttribute("contenteditable")?.toLowerCase();
  return value !== "false";
}

function isEditableElement(element: Element): boolean {
  if (element.ownerDocument.designMode === "on") return true;
  if (isContentEditable(element)) return true;
  const role = element.getAttribute("role")?.toLowerCase();
  if (role !== undefined && TEXT_ENTRY_ROLES.has(role)) return true;
  switch (element.localName) {
    case "textarea":
    case "select":
      return true;
    case "input":
      return !NON_TEXT_INPUT_TYPES.has(
        (element.getAttribute("type") ?? "text").toLowerCase(),
      );
    default:
      return false;
  }
}

function isUninspectableCustomElement(element: Element): boolean {
  return element.localName.includes("-") && element.shadowRoot === null;
}

function frameDocument(frame: Element): Document | null {
  try {
    return (frame as HTMLIFrameElement).contentDocument;
  } catch {
    return null;
  }
}

export function hasEditableFocus(doc: Document): boolean {
  return elementHasEditableFocus(doc.activeElement);
}

export function elementHasEditableFocus(start: Element | null): boolean {
  let element: Element | null = start;
  while (element !== null) {
    const shadowActive: Element | null =
      element.shadowRoot?.activeElement ?? null;
    if (shadowActive !== null) {
      element = shadowActive;
      continue;
    }
    if (isFrameElement(element)) {
      const inner = frameDocument(element);
      if (inner === null) return true;
      element = inner.activeElement;
      continue;
    }
    if (isUninspectableCustomElement(element)) return true;
    return isEditableElement(element);
  }
  return false;
}

export function activeSameOriginFrameWindows(doc: Document): Window[] {
  const windows: Window[] = [];
  let element: Element | null = doc.activeElement;
  while (element !== null) {
    const shadowActive: Element | null =
      element.shadowRoot?.activeElement ?? null;
    if (shadowActive !== null) {
      element = shadowActive;
      continue;
    }
    if (!isFrameElement(element)) break;
    const inner = frameDocument(element);
    if (inner === null) break;
    if (inner.defaultView !== null) windows.push(inner.defaultView);
    element = inner.activeElement;
  }
  return windows;
}
