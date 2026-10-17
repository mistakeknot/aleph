import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { useProjects } from "./data.js";
import {
  parseTasksRoute,
  useTasksNavigation,
  type ResolvedTasksRoute,
  type TasksNavigation,
  type TasksRoute,
} from "./routes.js";
import { loadViewMode, storeViewMode } from "./view-preference.js";
import { TasksTopbar } from "./topbar.js";
import { ListView } from "../views/list/index.js";
import { BoardView } from "../views/board/index.js";
import { DetailView } from "../views/detail/index.js";
import { NewTaskDialog } from "../views/manage/new-task-dialog.js";
import { NewProjectDialog } from "../views/manage/new-project-dialog.js";
import { ManagePanel } from "../views/manage/manage-panel.js";
import { EmptyState } from "../components/empty-state.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { TasksRefreshProvider } from "./refresh.js";

const BOARD_MIN_WIDTH = 448;
const DETAIL_SPLIT_MIN_WIDTH = 768;
const DETAIL_COLUMN_WIDTH = "26rem";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  );
}

function hasOpenOverlay(): boolean {
  return (
    document.querySelector(
      '[role="dialog"], [role="menu"], [role="listbox"]',
    ) !== null
  );
}

type BrowseRoute = Exclude<ResolvedTasksRoute, { kind: "task" }>;

function BrowseRouteOutlet({
  route,
  boardUsable,
}: {
  route: BrowseRoute;
  boardUsable: boolean;
}) {
  switch (route.kind) {
    case "all":
      return <ListView projectId={null} />;
    case "active":
      return <ListView projectId={null} activeOnly />;
    case "manage":
      return <ManagePanel />;
    case "project":
      return route.view === "board" && boardUsable ? (
        <BoardView projectId={route.projectId} />
      ) : (
        <ListView projectId={route.projectId} />
      );
  }
}

function TaskRouteView({
  taskKey,
  onClose,
}: {
  taskKey: string;
  onClose: () => void;
}) {
  const navigation = useTasksNavigation();
  const onCanonicalKey = useCallback(
    (canonicalKey: string) => {
      if (canonicalKey.toUpperCase() !== taskKey.toUpperCase()) {
        navigation.go(
          { kind: "task", taskKey: canonicalKey },
          { replace: true },
        );
      }
    },
    [navigation, taskKey],
  );
  return (
    <DetailView
      key={taskKey}
      taskKey={taskKey}
      onClose={onClose}
      onCanonicalKey={onCanonicalKey}
    />
  );
}

function resolveRoute(route: TasksRoute): ResolvedTasksRoute {
  if (route.kind !== "project") return route;
  return { ...route, view: route.view ?? loadViewMode(route.projectId) };
}

function TasksAppShellContent({ subPath }: PluginNavPanelProps) {
  const route = resolveRoute(parseTasksRoute(subPath));
  const tasksNavigation = useTasksNavigation();
  const navigation = useMemo<TasksNavigation>(
    () => ({
      go: (target, options) => {
        if (target.kind === "project" && target.view !== null) {
          storeViewMode(target.projectId, target.view);
        }
        tasksNavigation.go(target, options);
      },
    }),
    [tasksNavigation],
  );
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const [detailSplitFits, setDetailSplitFits] = useState(true);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const rootWidth = root.clientWidth;
      setDetailSplitFits(
        !(rootWidth > 0 && rootWidth < DETAIL_SPLIT_MIN_WIDTH),
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const [browsePaneEl, setBrowsePaneEl] = useState<HTMLDivElement | null>(null);
  const [boardUsable, setBoardUsable] = useState(true);
  useEffect(() => {
    if (!browsePaneEl || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const paneWidth = browsePaneEl.clientWidth;
      setBoardUsable(!(paneWidth > 0 && paneWidth < BOARD_MIN_WIDTH));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(browsePaneEl);
    return () => observer.disconnect();
  }, [browsePaneEl]);
  const projects = useProjects();

  const lastBrowseRouteRef = useRef<BrowseRoute | null>(null);
  useEffect(() => {
    if (route.kind !== "task") lastBrowseRouteRef.current = route;
    // oxlint-disable-next-line react/exhaustive-deps
  }, [subPath]);
  const backFromTask = () =>
    navigation.go(lastBrowseRouteRef.current ?? { kind: "all" });
  const onTaskRoute = route.kind === "task";
  const browseRoute: BrowseRoute =
    route.kind === "task"
      ? (lastBrowseRouteRef.current ?? { kind: "all" })
      : route;
  const showBrowsePane = !onTaskRoute || detailSplitFits;
  const backRef = useRef(backFromTask);
  backRef.current = backFromTask;
  useEffect(() => {
    if (!onTaskRoute) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isEditableTarget(event.target)) return;
      if (hasOpenOverlay()) return;
      backRef.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onTaskRoute]);

  const noProjects = projects.data !== undefined && projects.data.length === 0;
  const newTaskProjectId = route.kind === "project" ? route.projectId : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "c" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (event.defaultPrevented || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (hasOpenOverlay()) return;
      event.preventDefault();
      setNewTaskOpen(true);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div
      ref={rootRef}
      className="relative flex h-full min-h-0 bg-background text-foreground"
    >
      <main className="@container flex min-w-0 flex-1 flex-col">
        <TasksTopbar
          route={route}
          projects={projects.data}
          pagerScope={
            lastBrowseRouteRef.current === null
              ? null
              : {
                  projectId:
                    lastBrowseRouteRef.current.kind === "project"
                      ? lastBrowseRouteRef.current.projectId
                      : null,
                }
          }
          onNavigate={navigation.go}
          onNewTask={() => setNewTaskOpen(true)}
          onBack={backFromTask}
        />
        <div className="flex min-h-0 flex-1">
          {showBrowsePane && (
            <div ref={setBrowsePaneEl} className="min-h-0 flex-1 overflow-auto">
              {noProjects && browseRoute.kind !== "manage" ? (
                <EmptyState
                  icon="ListTodo"
                  title="No projects yet"
                  description="Create a project to start tracking tasks and dispatching work to agents."
                  action={
                    <Button size="sm" onClick={() => setNewProjectOpen(true)}>
                      <Icon name="Plus" className="size-3.5" />
                      New project
                    </Button>
                  }
                />
              ) : (
                <BrowseRouteOutlet
                  route={browseRoute}
                  boardUsable={boardUsable}
                />
              )}
            </div>
          )}
          {onTaskRoute && (
            <div
              className={
                detailSplitFits
                  ? "min-h-0 flex-none overflow-hidden border-l border-border"
                  : "min-h-0 flex-1 overflow-hidden"
              }
              style={
                detailSplitFits ? { width: DETAIL_COLUMN_WIDTH } : undefined
              }
            >
              <TaskRouteView taskKey={route.taskKey} onClose={backFromTask} />
            </div>
          )}
        </div>
      </main>
      <NewTaskDialog
        open={newTaskOpen}
        onOpenChange={setNewTaskOpen}
        projectId={newTaskProjectId}
      />
      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
      />
    </div>
  );
}

export function TasksAppShell(props: PluginNavPanelProps) {
  return (
    <TasksRefreshProvider>
      <TasksAppShellContent {...props} />
    </TasksRefreshProvider>
  );
}
