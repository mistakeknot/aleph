import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useRouteStateHistoryNavigation } from "@/lib/app-route-history";

export function HistoryNavigationCommandHandler() {
  const { canGoBack, canGoForward, goBack, goForward } =
    useRouteStateHistoryNavigation();

  useAppCommandHandler("history.back", () => {
    if (!canGoBack) return false;
    goBack();
    return true;
  });

  useAppCommandHandler("history.forward", () => {
    if (!canGoForward) return false;
    goForward();
    return true;
  });

  return null;
}
