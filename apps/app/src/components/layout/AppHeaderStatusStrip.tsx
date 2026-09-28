import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@bb/shared-ui/lib/utils";
import { usePluginSlots } from "@/lib/plugin-slots";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { getPluginConfigurationRoutePath } from "@/lib/route-paths";

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
  }, []);

  if (appHeaderStatuses.length === 0) return null;

  return (
    <div
      ref={containerRef}
      data-testid="app-header-status-strip"
      className={cn(
        "flex min-w-0 shrink items-center justify-end gap-2 overflow-hidden",
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
          <status.component
            threadId={threadId}
            projectId={projectId}
            isCompactViewport={isCompactViewport}
            availableWidth={availableWidth}
            openSettings={openSettingsFor(status.pluginId)}
          />
        </PluginSlotMount>
      ))}
    </div>
  );
}
