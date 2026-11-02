import { createClassScopedAtom } from "@/aleph/layoutProfiles";
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

// Aleph: each width class remembers its own sidebar open state. The wide
// profile is seeded from the old global key.
export const sidebarOpenAtom = createClassScopedAtom<boolean>({
  field: "sidebarOpen",
  storage: sidebarOpenStorage,
  defaults: { narrow: false, medium: true, wide: true },
  legacyWideKey: SIDEBAR_OPEN_KEY,
});
