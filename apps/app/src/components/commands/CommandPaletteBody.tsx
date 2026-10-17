import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import { cn } from "@bb/shared-ui/lib/utils";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  PALETTE_ACTION_BUCKETS,
  type PaletteAction,
} from "@/lib/command-palette/palette-action";
import { paletteActionIdForCommand } from "@/lib/command-palette/palette-app-commands";
import {
  rankPaletteActions,
  type RankedPaletteAction,
} from "@/lib/command-palette/palette-ranking";
import { usePluginSlots } from "@/lib/plugin-slots";
import { buildSettingsPaletteActions } from "@/lib/command-palette/palette-settings-actions";
import { buildPluginPagePaletteActions } from "@/lib/command-palette/palette-plugin-page-actions";
import {
  isPluginSearchQuery,
  PLUGIN_SEARCH_ACTION_PREFIX,
  usePluginPaletteSearch,
} from "@/lib/command-palette/palette-plugin-search";
import {
  buildPluginSettingsEntries,
  type PluginSettingsCandidate,
} from "@/components/settings/plugin-settings-entries";
import { useSettingsNavSections } from "@/components/settings/settings-nav";
import {
  PALETTE_SECTION_LABEL_CLASS,
  PaletteShell,
  PaletteShortcut,
} from "./PaletteShell";
import { COMMAND_PALETTE_INPUT } from "./PaletteInputBand";

const THREAD_SEARCH_ACTION_ID = paletteActionIdForCommand("thread.search");

export interface CommandPaletteBodyProps {
  actions: readonly PaletteAction[];
  installedPlugins: readonly PluginSettingsCandidate[];
  recents: readonly string[];
  query: string;
  projectId: string | null;
  onQueryChange: (value: string) => void;
  onChoose: (action: PaletteAction) => void;
}

export function CommandPaletteBody({
  actions,
  installedPlugins,
  recents,
  query,
  projectId,
  onQueryChange,
  onChoose,
}: CommandPaletteBodyProps) {
  const navigate = useNavigate();
  const isCompactViewport = useIsCompactViewport();
  const listId = useId();
  const optionIdPrefix = useId();
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const resetHighlight = useCallback(() => {
    setHighlightedIndex(0);
    setHighlightedId(null);
  }, []);
  const pluginSlots = usePluginSlots();
  const settingsSections = useSettingsNavSections(pluginSlots.fileOpeners);
  const pluginSettingsEntries = useMemo(
    () =>
      buildPluginSettingsEntries({
        installedPlugins,
        settingsSections: pluginSlots.settingsSections,
      }),
    [installedPlugins, pluginSlots.settingsSections],
  );
  const settingsActions = useMemo(
    () =>
      buildSettingsPaletteActions({
        navigate: (path) => void navigate(path),
        pluginEntries: pluginSettingsEntries,
        sections: settingsSections,
      }),
    [navigate, pluginSettingsEntries, settingsSections],
  );
  const pluginPageActions = useMemo(
    () =>
      buildPluginPagePaletteActions({
        navigate: (path) => void navigate(path),
        panels: pluginSlots.navPanels,
      }),
    [navigate, pluginSlots.navPanels],
  );
  const navigateToPath = useCallback(
    (path: string) => void navigate(path),
    [navigate],
  );

  const availableActions = useMemo<readonly PaletteAction[]>(
    () => [...actions, ...settingsActions, ...pluginPageActions],
    [actions, pluginPageActions, settingsActions],
  );
  const commandQuery = query.startsWith(">") ? query.slice(1) : query;
  const ranked = useMemo(
    () =>
      rankPaletteActions({
        actions: availableActions,
        query: commandQuery,
        recentIds: recents,
      }),
    [availableActions, commandQuery, recents],
  );
  const isGroupedRoot = commandQuery.trim() === "";
  const pluginSearch = usePluginPaletteSearch({
    enabled: true,
    query,
    slots: pluginSlots.commandPaletteSearches,
    panels: pluginSlots.navPanels,
    projectId,
    navigate: navigateToPath,
  });
  const rootGroups = useMemo(() => {
    const groups = PALETTE_ACTION_BUCKETS.map((bucket) => ({
      bucket,
      entries: ranked.filter((entry) => entry.action.bucket === bucket),
    })).filter((group) => group.entries.length > 0);
    return groups.map((group, index) => ({
      ...group,
      startIndex: groups
        .slice(0, index)
        .reduce((total, prior) => total + prior.entries.length, 0),
    }));
  }, [ranked]);
  const visibleEntries = useMemo(
    () =>
      isGroupedRoot
        ? rootGroups.flatMap((group) => group.entries)
        : [
            ...ranked,
            ...pluginSearch.actions.map((action) => ({
              action,
              positions: [],
            })),
          ],
    [isGroupedRoot, pluginSearch.actions, ranked, rootGroups],
  );
  const retainedIndex =
    highlightedId === null
      ? -1
      : visibleEntries.findIndex((entry) => entry.action.id === highlightedId);
  const holdHighlightedSearchResult =
    retainedIndex < 0 &&
    pluginSearch.pending &&
    highlightedId?.startsWith(PLUGIN_SEARCH_ACTION_PREFIX) === true;
  const activeIndex =
    visibleEntries.length === 0 || holdHighlightedSearchResult
      ? -1
      : retainedIndex >= 0
        ? retainedIndex
        : Math.min(highlightedIndex, visibleEntries.length - 1);
  const activeId =
    activeIndex < 0 ? null : (visibleEntries[activeIndex]?.action.id ?? null);
  const syncedIndex = Math.max(activeIndex, 0);
  if (
    !holdHighlightedSearchResult &&
    (highlightedIndex !== syncedIndex || highlightedId !== activeId)
  ) {
    setHighlightedIndex(syncedIndex);
    setHighlightedId(activeId);
  }
  const highlight = useCallback(
    (index: number) => {
      setHighlightedIndex(index);
      setHighlightedId(visibleEntries[index]?.action.id ?? null);
    },
    [visibleEntries],
  );
  const pluginSearchStatus = pluginSearch.pending
    ? "Searching…"
    : !isGroupedRoot &&
        pluginSlots.commandPaletteSearches.length > 0 &&
        isPluginSearchQuery(query)
      ? `${pluginSearch.actions.length} ${pluginSearch.actions.length === 1 ? "search result" : "search results"}`
      : "";

  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollOnNextHighlightRef = useRef(false);
  useEffect(() => {
    if (!scrollOnNextHighlightRef.current) return;
    scrollOnNextHighlightRef.current = false;
    listRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (visibleEntries.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        scrollOnNextHighlightRef.current = true;
        highlight(
          activeIndex + 1 >= visibleEntries.length ? 0 : activeIndex + 1,
        );
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        scrollOnNextHighlightRef.current = true;
        highlight(
          activeIndex <= 0 ? visibleEntries.length - 1 : activeIndex - 1,
        );
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        scrollOnNextHighlightRef.current = true;
        highlight(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        scrollOnNextHighlightRef.current = true;
        highlight(visibleEntries.length - 1);
        return;
      }
      if (event.key === "Enter") {
        const choice = visibleEntries[activeIndex];
        if (choice === undefined) return;
        event.preventDefault();
        onChoose(choice.action);
      }
    },
    [activeIndex, highlight, onChoose, visibleEntries],
  );

  return (
    <>
      <PaletteShell
        activeDescendantId={
          activeIndex === -1 ? undefined : `${optionIdPrefix}-${activeIndex}`
        }
        inputDescription={COMMAND_PALETTE_INPUT.description}
        inputLabel={COMMAND_PALETTE_INPUT.label}
        listId={listId}
        listLabel="Commands"
        listRef={listRef}
        onInputChange={(value) => {
          onQueryChange(value);
          resetHighlight();
          if (listRef.current !== null) listRef.current.scrollTop = 0;
        }}
        onInputKeyDown={handleKeyDown}
        placeholder={COMMAND_PALETTE_INPUT.placeholder}
        value={query}
      >
        {!isGroupedRoot && visibleEntries.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            {pluginSearch.pending ? "Searching…" : "No matching commands"}
          </p>
        ) : isGroupedRoot ? (
          rootGroups.map((group) => {
            const labelId = `${optionIdPrefix}-${group.bucket.toLowerCase()}-label`;
            return (
              <div
                key={group.bucket}
                role="group"
                aria-labelledby={labelId}
                data-palette-bucket={group.bucket}
              >
                <div id={labelId} className={PALETTE_SECTION_LABEL_CLASS}>
                  {group.bucket}
                </div>
                {group.entries.map((entry, index) => {
                  const visibleIndex = group.startIndex + index;
                  return (
                    <PaletteRow
                      key={entry.action.id}
                      entry={entry}
                      id={`${optionIdPrefix}-${visibleIndex}`}
                      isActive={visibleIndex === activeIndex}
                      isDrillIn={entry.action.id === THREAD_SEARCH_ACTION_ID}
                      showShortcut={!isCompactViewport}
                      onActivate={() => {
                        highlight(visibleIndex);
                      }}
                      onSelect={() => onChoose(entry.action)}
                    />
                  );
                })}
              </div>
            );
          })
        ) : (
          visibleEntries.map((entry, index) => (
            <PaletteRow
              key={entry.action.id}
              entry={entry}
              id={`${optionIdPrefix}-${index}`}
              isActive={index === activeIndex}
              isDrillIn={entry.action.id === THREAD_SEARCH_ACTION_ID}
              showShortcut={!isCompactViewport}
              onActivate={() => {
                highlight(index);
              }}
              onSelect={() => onChoose(entry.action)}
            />
          ))
        )}
      </PaletteShell>
      <div role="status" aria-live="polite" className="sr-only">
        {pluginSearchStatus}
      </div>
    </>
  );
}

function PaletteRow({
  entry,
  id,
  isActive,
  isDrillIn,
  showShortcut,
  onActivate,
  onSelect,
}: {
  entry: RankedPaletteAction;
  id: string;
  isActive: boolean;
  isDrillIn: boolean;
  showShortcut: boolean;
  onActivate: () => void;
  onSelect: () => void;
}) {
  const metadataGroup =
    entry.action.group === "Browser" ||
    entry.action.id.startsWith("plugin:") ||
    entry.action.id.startsWith(PLUGIN_SEARCH_ACTION_PREFIX)
      ? entry.action.group
      : null;
  const title = isDrillIn ? `${entry.action.title}…` : entry.action.title;
  const shortcut = showShortcut ? entry.action.shortcut : null;
  const hasTrailing = metadataGroup !== null || shortcut !== null || isDrillIn;
  return (
    <div
      id={id}
      role="option"
      aria-selected={isActive}
      data-palette-action-kind={isDrillIn ? "drill-in" : "terminal"}
      className={cn(
        "flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-3 rounded-md px-2 py-1.5 text-left text-sm outline-none",
        isActive && "bg-state-hover text-foreground",
      )}
      onPointerMove={onActivate}
      onClick={onSelect}
    >
      <span className="min-w-0 truncate">
        <HighlightedTitle title={title} positions={entry.positions} />
      </span>
      {hasTrailing ? (
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {metadataGroup === null ? null : (
            <span className="text-xs text-muted-foreground">
              {metadataGroup}
            </span>
          )}
          {shortcut === null ? null : (
            <PaletteShortcut>{shortcut.label}</PaletteShortcut>
          )}
          {isDrillIn ? (
            <span className="sr-only">Opens a search view</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function HighlightedTitle({
  title,
  positions,
}: {
  title: string;
  positions: readonly number[];
}) {
  if (positions.length === 0) return <>{title}</>;
  const emphasized = new Set(positions);
  return (
    <>
      {[...title].map((character, index) =>
        emphasized.has(index) ? (
          <span key={index} className="font-semibold text-foreground">
            {character}
          </span>
        ) : (
          <span key={index}>{character}</span>
        ),
      )}
    </>
  );
}
