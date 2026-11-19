export function readFixedPanelStorage(key: string): string | null {
  const content = window.localStorage.getItem(`${key}.content`);
  if (content === null) return null;
  const shared: unknown = JSON.parse(content);
  const visibility: unknown = JSON.parse(
    window.sessionStorage.getItem(key) ?? "null",
  );
  if (
    typeof shared !== "object" ||
    shared === null ||
    !("secondary" in shared)
  ) {
    return content;
  }
  if (
    typeof visibility !== "object" ||
    visibility === null ||
    !("secondary" in visibility)
  ) {
    return content;
  }
  const sharedPanel = shared.secondary;
  const windowPanel = visibility.secondary;
  if (
    typeof sharedPanel !== "object" ||
    sharedPanel === null ||
    typeof windowPanel !== "object" ||
    windowPanel === null ||
    !("isOpen" in windowPanel) ||
    typeof windowPanel.isOpen !== "boolean"
  ) {
    return content;
  }
  return JSON.stringify({
    ...shared,
    secondary: { ...sharedPanel, isOpen: windowPanel.isOpen },
  });
}
