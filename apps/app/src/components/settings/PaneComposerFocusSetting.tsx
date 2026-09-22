import { Switch } from "@bb/shared-ui/switch";
import { useAtom } from "jotai";
import { SettingsWithControl } from "@/components/ui/settings-section";
import { focusComposerOnPaneSwitchAtom } from "@/lib/split-layout/atoms";

export function PaneComposerFocusSetting() {
  const [enabled, setEnabled] = useAtom(focusComposerOnPaneSwitchAtom);
  return (
    <SettingsWithControl
      label="Focus composer when switching panes with keyboard"
      description="Start typing in the selected pane automatically. Applies to this browser or app."
    >
      <Switch
        checked={enabled}
        onCheckedChange={setEnabled}
        aria-label="Focus composer when switching panes with keyboard"
      />
    </SettingsWithControl>
  );
}
