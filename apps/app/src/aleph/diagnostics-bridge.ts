import { useEffect } from "react";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import { emitDiagnostic, onDiagnostic } from "@/lib/diagnostics";
import { wsManager } from "@/lib/ws";
import { ThreadSequenceTracker } from "./thread-sequence-tracker";

export function useAlephDiagnostics(): void {
  useEffect(() => {
    const logDiagnostic = getBbDesktopInfo()?.logDiagnostic;
    if (logDiagnostic === undefined) {
      return;
    }
    const tracker = new ThreadSequenceTracker();
    const unsubscribeEvents = onDiagnostic((event) => {
      logDiagnostic(event);
    });
    const unsubscribeChanged = wsManager.onChanged((message) => {
      emitDiagnostic(() => tracker.observe(message));
    });
    return () => {
      unsubscribeChanged();
      unsubscribeEvents();
    };
  }, []);
}
