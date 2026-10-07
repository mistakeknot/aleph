import { useLocation, useNavigate } from "react-router-dom";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";

const FIRST_HISTORY_ENTRY_KEY = "default";

export function HistoryNavigationCommandHandler() {
  const navigate = useNavigate();
  const location = useLocation();
  const canGoBack = location.key !== FIRST_HISTORY_ENTRY_KEY;

  useAppCommandHandler("history.back", () => {
    if (!canGoBack) return false;
    void navigate(-1);
    return true;
  });

  useAppCommandHandler("history.forward", () => {
    void navigate(1);
    return true;
  });

  return null;
}
