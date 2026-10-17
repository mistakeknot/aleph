import { useEffect } from "react";
import { getBbDesktopInfo } from "@/lib/bb-desktop";
import { emitDiagnostic, onDiagnostic } from "@/lib/diagnostics";
import { wsManager } from "@/lib/ws";
import { ThreadSequenceTracker } from "./thread-sequence-tracker";

export function useAlephDiagnostics(): void {
  useEffect(() => {
    const desktop = getBbDesktopInfo();
    const logDiagnostic = desktop?.logDiagnostic;
    if (desktop?.diagnosticsEnabled !== true || logDiagnostic === undefined) {
      return;
    }
    const tracker = new ThreadSequenceTracker();
    const unsubscribeEvents = onDiagnostic((event) => {
      logDiagnostic.call(desktop, event);
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
