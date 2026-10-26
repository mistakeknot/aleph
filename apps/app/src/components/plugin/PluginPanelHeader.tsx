import { usePageTitleValue } from "@/components/layout/page-title";
import { PageTitleHeader } from "@/components/layout/PageTitleHeader";
import { Component, type ReactNode } from "react";
import type { PluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import type { PluginNavPanelSlot } from "@/lib/plugin-slots";
import { usePluginCss } from "@/lib/plugin-css";
import { PluginItemIcon } from "./PluginIcon";
import { PluginContext } from "./plugin-context";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { getPluginPagePanelStateId } from "./plugin-page-panel-state";

export class NavPanelSlotBoundary extends Component<
  { pluginId: string; slot: string; children: ReactNode },
  { crashed: boolean }
> {
  override state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  override componentDidCatch(error: unknown): void {
    const reason = String(
      (error as Error | null | undefined)?.message ?? error,
    );
    console.warn(
      `[plugin:${this.props.pluginId}] navPanel ${this.props.slot} crashed and is hidden: ${reason}`,
    );
  }

  override render(): ReactNode {
    return this.state.crashed ? null : this.props.children;
  }
}

export function PluginPanelHeaderCenter({
  chrome,
}: {
  chrome: Pick<PluginNavPanelChrome, "pluginId" | "icon" | "title">;
}) {
  const pageTitle = usePageTitleValue();
  return (
    <PageTitleHeader
      icon={
        <PluginItemIcon
          pluginId={chrome.pluginId}
          icon={chrome.icon}
          className="text-muted-foreground"
        />
      }
      title={chrome.title}
      value={pageTitle}
    />
  );
}

export function PluginPanelHeaderActions({
  panel,
  paneId,
  subPath,
  paneActions,
}: {
  panel: PluginNavPanelSlot;
  paneId?: string;
  subPath: string;
  paneActions?: ReactNode;
}) {
  const paneContext = useOptionalPaneContext();
  const HeaderContent = panel.headerContent;
  usePluginCss(HeaderContent === undefined ? null : panel.pluginId);
  const panelStateId = getPluginPagePanelStateId({
    panelPath: panel.path,
    paneId: paneId ?? paneContext?.paneId,
    pluginId: panel.pluginId,
  });
  return (
    <div className="flex shrink-0 items-center gap-2">
      {HeaderContent === undefined ? null : (
        <NavPanelSlotBoundary
          key={`${panel.pluginId}/${panel.id}/${panel.generation}`}
          pluginId={panel.pluginId}
          slot="headerContent"
        >
          <PluginContext.Provider value={panel.pluginId}>
            <div
              data-bb-plugin-root=""
              data-bb-plugin={panel.pluginId}
              className="flex shrink-0 items-center gap-2"
            >
              <HeaderContent subPath={subPath} />
            </div>
          </PluginContext.Provider>
        </NavPanelSlotBoundary>
      )}
      {paneActions}
      <div data-plugin-right-panel-toggle-portal={panelStateId} />
    </div>
  );
}
