import { atomWithStorage } from "jotai/utils";
import { createTabScopedStorage } from "@/lib/browser-storage";

export const SIDEBAR_OPEN_KEY = "bb.sidebar.open";

const sidebarOpenStorage = createTabScopedStorage<boolean>(
  {
    parse: (storedValue, initialValue) => {
      if (storedValue === "true") return true;
      if (storedValue === "false") return false;
      return initialValue;
    },
    serialize: (value) => String(value),
  },
  { persistInitialValue: true },
);

export const sidebarOpenAtom = atomWithStorage<boolean>(
  SIDEBAR_OPEN_KEY,
  true,
  sidebarOpenStorage,
  { getOnInit: true },
);
