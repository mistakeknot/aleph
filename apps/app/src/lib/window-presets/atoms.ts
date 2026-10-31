import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";

export const windowPresetsAtom = createSyncedPreferenceAtom("windows.presets");
export const windowSuggestionsAtom = createSyncedPreferenceAtom(
  "windows.suggestions",
);
