import { createContext } from "react";
import { atom, type WritableAtom } from "jotai";
import { atomWithStorage, RESET } from "jotai/utils";
import { atomFamily } from "jotai-family";
import {
  booleanLocalStorage,
  createLocalStorageSyncStorage,
} from "@/lib/browser-storage";
import {
  createClassScopedAtom,
  type ClassScopedWrite,
  type ExplicitClassWritable,
} from "@/aleph/layoutProfiles";
import { hasThreadId } from "@/lib/thread-id";

export const threadSecondaryPanelResizingAtom = atom(false);

type ResolvedThreadSecondaryPanelThreadId = string;
type ThreadSecondaryPanelThreadId =
  | ResolvedThreadSecondaryPanelThreadId
  | null
  | undefined;

const DEFAULT_SECONDARY_PANEL_WIDTH_PERCENT = 50;

function parseSecondaryPanelWidthPercent(storedValue: string | null) {
  if (storedValue === null) return null;
  const parsed = Number.parseFloat(storedValue);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100 ? parsed : null;
}

const secondaryPanelWidthStorage = createLocalStorageSyncStorage<number>({
  parse: (storedValue, initialValue) =>
    parseSecondaryPanelWidthPercent(storedValue) ?? initialValue,
  serialize: (value) => String(value),
});
const threadSecondaryPanelWidthOverrideStorage = createLocalStorageSyncStorage<
  number | null
>({
  parse: (storedValue, initialValue) =>
    parseSecondaryPanelWidthPercent(storedValue) ?? initialValue,
  serialize: (value) => String(value),
});

export type SecondaryPanelWidthPercentAtom = WritableAtom<
  number,
  [number | typeof RESET],
  void
> &
  ExplicitClassWritable<number | typeof RESET>;

const widthDefaults = {
  narrow: DEFAULT_SECONDARY_PANEL_WIDTH_PERCENT,
  medium: DEFAULT_SECONDARY_PANEL_WIDTH_PERCENT,
  wide: DEFAULT_SECONDARY_PANEL_WIDTH_PERCENT,
};

// Aleph: every width atom below is stored per width class (see
// aleph/layoutProfiles), so resizing the panel on a laptop never overwrites
// the width remembered for a large monitor.
export const secondaryPanelWidthPercentAtom: SecondaryPanelWidthPercentAtom =
  createClassScopedAtom<number>({
    field: "secondaryPanelWidthPercent",
    storage: secondaryPanelWidthStorage,
    defaults: widthDefaults,
    legacyWideKey: "bb.thread.secondaryPanel.widthPercent",
  });

const threadSecondaryPanelWidthOverrideAtomFamily = atomFamily(
  (threadId: ResolvedThreadSecondaryPanelThreadId) =>
    createClassScopedAtom<number | null>({
      field: `secondaryPanelWidthOverride.${encodeURIComponent(threadId)}`,
      storage: threadSecondaryPanelWidthOverrideStorage,
      defaults: { narrow: null, medium: null, wide: null },
      legacyWideKey: `bb.thread.secondaryPanel.widthPercent-${encodeURIComponent(threadId)}`,
    }),
);

const threadSecondaryPanelWidthPercentAtomFamily = atomFamily(
  (threadId: ResolvedThreadSecondaryPanelThreadId) => {
    const overrideAtom = threadSecondaryPanelWidthOverrideAtomFamily(threadId);
    const widthPercentAtom = atom(
      (get) => get(overrideAtom) ?? get(secondaryPanelWidthPercentAtom),
      (_get, set, widthPercent: number | typeof RESET) => {
        set(overrideAtom, widthPercent);
        if (widthPercent !== RESET) {
          set(secondaryPanelWidthPercentAtom, widthPercent);
        }
      },
    );
    const writeToClassAtom = atom(
      null,
      (
        _get,
        set,
        { widthClass, update }: ClassScopedWrite<number | typeof RESET>,
      ) => {
        const widthPercent = update as number | typeof RESET;
        set(overrideAtom.writeToClassAtom, {
          widthClass,
          update: widthPercent,
        });
        if (widthPercent !== RESET) {
          set(secondaryPanelWidthPercentAtom.writeToClassAtom, {
            widthClass,
            update: widthPercent,
          });
        }
      },
    );
    return Object.assign(widthPercentAtom, {
      writeToClassAtom,
    }) as SecondaryPanelWidthPercentAtom;
  },
);

export function getThreadSecondaryPanelWidthPercentAtom(
  threadId: ResolvedThreadSecondaryPanelThreadId,
): SecondaryPanelWidthPercentAtom {
  return threadSecondaryPanelWidthPercentAtomFamily(threadId);
}

const PLUGIN_PAGE_SECONDARY_PANEL_WIDTH_STORAGE_PREFIX =
  "bb.pluginPage.secondaryPanel.widthPercent";

const pluginPageSecondaryPanelWidthPercentAtomFamily = atomFamily(
  (pageKey: string): SecondaryPanelWidthPercentAtom =>
    createClassScopedAtom<number>({
      field: `pluginPageSecondaryPanelWidthPercent.${pageKey}`,
      storage: secondaryPanelWidthStorage,
      defaults: widthDefaults,
      legacyWideKey: `${PLUGIN_PAGE_SECONDARY_PANEL_WIDTH_STORAGE_PREFIX}-${pageKey}`,
    }),
);

export function getPluginPageSecondaryPanelWidthPercentAtom({
  panelPath,
  pluginId,
}: {
  panelPath: string;
  pluginId: string;
}): SecondaryPanelWidthPercentAtom {
  return pluginPageSecondaryPanelWidthPercentAtomFamily(
    `${encodeURIComponent(pluginId)}:${encodeURIComponent(panelPath)}`,
  );
}

export const SecondaryPanelWidthPercentAtomContext =
  createContext<SecondaryPanelWidthPercentAtom>(secondaryPanelWidthPercentAtom);

const THREAD_CONVERSATION_COLLAPSED_STORAGE_PREFIX =
  "bb.thread.conversation.collapsed";

const threadConversationCollapsedAtomFamily = atomFamily(
  (threadId: ResolvedThreadSecondaryPanelThreadId) =>
    atomWithStorage<boolean>(
      `${THREAD_CONVERSATION_COLLAPSED_STORAGE_PREFIX}-${encodeURIComponent(threadId)}`,
      false,
      booleanLocalStorage,
      { getOnInit: true },
    ),
);

const disabledThreadConversationCollapsedAtom = atom(false);

export function getThreadConversationCollapsedAtom(
  threadId: ThreadSecondaryPanelThreadId,
) {
  return hasThreadId(threadId)
    ? threadConversationCollapsedAtomFamily(threadId)
    : disabledThreadConversationCollapsedAtom;
}
