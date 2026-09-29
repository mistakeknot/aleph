import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  atom,
  useAtomValue,
  useSetAtom,
  useStore,
  type WritableAtom,
} from "jotai";
import { atomWithStorage, RESET } from "jotai/utils";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { booleanLocalStorage, type SyncStorage } from "@/lib/browser-storage";

// Aleph: per-window-width layout profiles. Each width class remembers its own
// sidebar and right-panel layout so shrinking the window on a laptop never
// overwrites the layout used on a large monitor.
//
// The right panel's open state is persisted per thread (fixed-panel-tabs-state)
// and is never written by a class change. Each class instead stores a
// "secondaryPanelSuppressed" flag: the panel renders only when the per-thread
// state is open AND the active class is not suppressed.

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
  legacyWideKey?: string;
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

export type ClassScopedAtomWithProfiles<T> = ClassScopedAtom<T> & {
  profileAtoms: Record<WidthClass, ClassScopedAtom<T>>;
} & ExplicitClassWritable<T>;

// Returns an atom that reads and writes the active width class's profile
// value. Changing class only changes which stored atom is read; nothing is
// written to the class being left.
export function createClassScopedAtom<T>({
  field,
  storage,
  defaults,
  legacyWideKey,
}: ClassScopedAtomOptions<T>): ClassScopedAtomWithProfiles<T> {
  const profileAtoms = {} as Record<WidthClass, ClassScopedAtom<T>>;
  for (const widthClass of WIDTH_CLASSES) {
    profileAtoms[widthClass] = atomWithStorage<T>(
      layoutProfileKey(widthClass, field),
      defaults[widthClass],
      widthClass === "wide" && legacyWideKey !== undefined
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
  const writeToClassAtom = atom(
    null,
    (_get, set, { widthClass, update }: ClassScopedWrite<T>) => {
      set(profileAtoms[widthClass], update);
    },
  );
  return Object.assign(scoped, { profileAtoms, writeToClassAtom });
}

export const SECONDARY_PANEL_SUPPRESSED_DEFAULTS: Record<WidthClass, boolean> =
  {
    narrow: true,
    medium: true,
    wide: false,
  };

export const secondaryPanelSuppressedAtom = createClassScopedAtom<boolean>({
  field: "secondaryPanelSuppressed",
  storage: booleanLocalStorage,
  defaults: SECONDARY_PANEL_SUPPRESSED_DEFAULTS,
});

// True when the active width class hides the right panel. Never applies to
// the compact (drawer) viewport.
export function useIsSecondaryPanelSuppressed(): boolean {
  const suppressed = useAtomValue(secondaryPanelSuppressedAtom);
  const isCompactViewport = useIsCompactViewport();
  return suppressed && !isCompactViewport;
}

export interface SecondaryPanelSuppressionActions {
  // Whether the active class currently hides the panel (never in compact).
  isSuppressed: () => boolean;
  // Show the panel again in the active class.
  clear: () => void;
  // Close request: in a suppressed-by-default class, hide the panel by
  // suppressing it (leaving per-thread state alone) and return true.
  // Returns false when the caller should close the per-thread state.
  suppressInsteadOfClose: () => boolean;
}

export function useSecondaryPanelSuppressionActions(): SecondaryPanelSuppressionActions {
  const store = useStore();
  const isCompactViewport = useIsCompactViewport();
  return useMemo(
    () => ({
      isSuppressed: () =>
        !isCompactViewport && store.get(secondaryPanelSuppressedAtom),
      clear: () => {
        if (store.get(secondaryPanelSuppressedAtom)) {
          store.set(secondaryPanelSuppressedAtom, false);
        }
      },
      suppressInsteadOfClose: () => {
        if (isCompactViewport) return false;
        if (!SECONDARY_PANEL_SUPPRESSED_DEFAULTS[store.get(widthClassAtom)]) {
          return false;
        }
        store.set(secondaryPanelSuppressedAtom, true);
        return true;
      },
    }),
    [isCompactViewport, store],
  );
}

// Resize drags read a width in one class and persist at mouseup. Pin the class
// when the drag starts so a class flip mid-drag cannot write to another
// class's profile.
export function usePinnedClassWriter<T>(
  scopedAtom: ClassScopedAtomWithProfiles<T>,
): { pin: () => void; commit: (value: T) => void } {
  const store = useStore();
  const pinnedRef = useRef<WidthClass | null>(null);
  const pin = useCallback(() => {
    pinnedRef.current = store.get(widthClassAtom);
  }, [store]);
  const commit = useCallback(
    (value: T) => {
      const widthClass = pinnedRef.current ?? store.get(widthClassAtom);
      pinnedRef.current = null;
      store.set(scopedAtom.writeToClassAtom, { widthClass, update: value });
    },
    [scopedAtom, store],
  );
  return { pin, commit };
}
