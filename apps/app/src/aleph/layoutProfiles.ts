import { useEffect } from "react";
import { atom, useSetAtom, type WritableAtom } from "jotai";
import { atomWithStorage, RESET } from "jotai/utils";
import type { SyncStorage } from "@/lib/browser-storage";

// Aleph: per-window-width layout profiles. Each width class remembers its own
// sidebar and right-panel layout so shrinking the window on a laptop never
// overwrites the layout used on a large monitor.
//
// The right-panel open state is intentionally not part of a profile: it is
// persisted per thread (fixed-panel-tabs-state), not in one global atom.

export type WidthClass = "narrow" | "medium" | "wide";

export const WIDTH_CLASSES: readonly WidthClass[] = [
  "narrow",
  "medium",
  "wide",
];

export const MEDIUM_MIN_WIDTH = 1280;
export const WIDE_MIN_WIDTH = 1800;
export const WIDTH_CLASS_HYSTERESIS = 24;
export const WIDTH_CLASS_DEBOUNCE_MS = 150;

export function classifyWidth(width: number): WidthClass {
  if (width >= WIDE_MIN_WIDTH) return "wide";
  if (width >= MEDIUM_MIN_WIDTH) return "medium";
  return "narrow";
}

// Leaving a class requires crossing its threshold by the hysteresis margin, so
// a window hovering at a boundary does not flap between classes.
export function nextWidthClass(
  previous: WidthClass,
  width: number,
): WidthClass {
  const h = WIDTH_CLASS_HYSTERESIS;
  let current = previous;
  for (let i = 0; i < WIDTH_CLASSES.length; i += 1) {
    let next = current;
    if (current === "narrow" && width >= MEDIUM_MIN_WIDTH + h) next = "medium";
    else if (current === "medium" && width >= WIDE_MIN_WIDTH + h) next = "wide";
    else if (current === "medium" && width < MEDIUM_MIN_WIDTH - h)
      next = "narrow";
    else if (current === "wide" && width < WIDE_MIN_WIDTH - h) next = "medium";
    if (next === current) break;
    current = next;
  }
  return current;
}

function currentWindowWidth(): number {
  return typeof window === "undefined" ? WIDE_MIN_WIDTH : window.innerWidth;
}

const widthClassOverrideAtom = atom<WidthClass | null>(null);

export const widthClassAtom = atom<WidthClass, [number], void>(
  (get) => get(widthClassOverrideAtom) ?? classifyWidth(currentWindowWidth()),
  (get, set, width: number) => {
    const previous =
      get(widthClassOverrideAtom) ?? classifyWidth(currentWindowWidth());
    const next = nextWidthClass(previous, width);
    if (next !== get(widthClassOverrideAtom)) {
      set(widthClassOverrideAtom, next);
    }
  },
);

// Test helper: forget tracked state so the next read classifies from scratch.
export const resetWidthClassAtom = atom(null, (_get, set) => {
  set(widthClassOverrideAtom, null);
});

export function useWidthClassTracker(): void {
  const reportWidth = useSetAtom(widthClassAtom);
  useEffect(() => {
    reportWidth(window.innerWidth);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reportWidth(window.innerWidth);
      }, WIDTH_CLASS_DEBOUNCE_MS);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (timer !== null) clearTimeout(timer);
    };
  }, [reportWidth]);
}

const LAYOUT_KEY_PREFIX = "aleph.layout";

export function layoutProfileKey(widthClass: WidthClass, field: string) {
  return `${LAYOUT_KEY_PREFIX}.${widthClass}.${field}`;
}

interface ClassScopedAtomOptions<T> {
  field: string;
  storage: SyncStorage<T>;
  defaults: Record<WidthClass, T>;
  // Existing global key whose value seeds the wide profile on first run.
  legacyWideKey: string;
}

function withLegacyFallback<T>(
  storage: SyncStorage<T>,
  legacyKey: string,
): SyncStorage<T> {
  return {
    ...storage,
    getItem: (key, initialValue) =>
      storage.getItem(key, storage.getItem(legacyKey, initialValue)),
  };
}

export type ClassScopedAtom<T> = WritableAtom<
  T,
  [ClassScopedUpdate<T>],
  void
>;

// Returns an atom that reads and writes the active width class's profile
// value. Changing class only changes which stored atom is read; nothing is
// written to the class being left.
export function createClassScopedAtom<T>({
  field,
  storage,
  defaults,
  legacyWideKey,
}: ClassScopedAtomOptions<T>): ClassScopedAtom<T> & {
  profileAtoms: Record<WidthClass, ClassScopedAtom<T>>;
} {
  const profileAtoms = {} as Record<WidthClass, ClassScopedAtom<T>>;
  for (const widthClass of WIDTH_CLASSES) {
    profileAtoms[widthClass] = atomWithStorage<T>(
      layoutProfileKey(widthClass, field),
      defaults[widthClass],
      widthClass === "wide"
        ? withLegacyFallback(storage, legacyWideKey)
        : storage,
      { getOnInit: true },
    ) as ClassScopedAtom<T>;
  }
  const scoped = atom(
    (get) => get(profileAtoms[get(widthClassAtom)]),
    (get, set, update: ClassScopedUpdate<T>) => {
      set(profileAtoms[get(widthClassAtom)], update);
    },
  );
  return Object.assign(scoped, { profileAtoms });
}
