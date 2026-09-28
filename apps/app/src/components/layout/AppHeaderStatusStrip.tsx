import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@bb/shared-ui/lib/utils";
import { usePluginSlots } from "@/lib/plugin-slots";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";

const STRIP_GAP_PX = 8;

export function AppHeaderStatusStrip({
  threadId,
  projectId,
  isCompactViewport,
}: {
  threadId: string | null;
  projectId: string | null;
  isCompactViewport: boolean;
}) {
  const { appHeaderStatuses } = usePluginSlots();
  const hasStatuses = appHeaderStatuses.length > 0;
  const containerRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  const navigate = useNavigate();
  const openSettingsFor = useCallback(
    (pluginId: string) => () => {
      void navigate(getPluginConfigurationRoutePath({ pluginId }));
    },
    [navigate],
  );

  useLayoutEffect(() => {
    if (!hasStatuses) return;
    const element = containerRef.current;
    if (element === null) return;
    const measure = (width: number) => {
      setAvailableWidth((current) => (current === width ? current : width));
    };
    measure(Math.floor(element.clientWidth));
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) measure(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasStatuses]);

  if (!hasStatuses) return null;

  const totalGapWidth =
    STRIP_GAP_PX * Math.max(appHeaderStatuses.length - 1, 0);
  const perContributionWidth = Math.floor(
    Math.max(availableWidth - totalGapWidth, 0) / appHeaderStatuses.length,
  );

  return (
    <div
      ref={containerRef}
      data-testid="app-header-status-strip"
      className={cn(
        "flex min-w-0 flex-1 shrink items-center justify-end gap-2 overflow-hidden",
        isCompactViewport ? "max-w-[40%]" : "max-w-[60%]",
      )}
    >
      {appHeaderStatuses.map((status) => (
        <PluginSlotMount
          key={`${status.pluginId}/${status.id}/${status.generation}`}
          pluginId={status.pluginId}
          slotKind="appHeaderStatus"
          slotId={status.id}
        >
          <div
            role="group"
            aria-label={status.title}
            className="flex min-w-0 items-center"
          >
            <status.component
              threadId={threadId}
              projectId={projectId}
              isCompactViewport={isCompactViewport}
              availableWidth={perContributionWidth}
              openSettings={openSettingsFor(status.pluginId)}
            />
          </div>
        </PluginSlotMount>
      ))}
    </div>
  );
}
