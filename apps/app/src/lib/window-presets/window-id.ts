const WINDOW_ID_KEY = "bb.window.id";
const APPLIED_PRESET_KEY = "bb.window.appliedPreset";

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    return;
  }
}

export function getWindowId(): string {
  const existing = readSession(WINDOW_ID_KEY);
  if (existing !== null && existing.length > 0) {
    return existing;
  }
  const created = `win-${crypto.randomUUID()}`;
  writeSession(WINDOW_ID_KEY, created);
  return created;
}

export function getAppliedPresetId(): string | null {
  const value = readSession(APPLIED_PRESET_KEY);
  return value !== null && value.length > 0 ? value : null;
}

export function setAppliedPresetId(presetId: string): void {
  writeSession(APPLIED_PRESET_KEY, presetId);
}
