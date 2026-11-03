import {
  definePluginApp,
  experimental_useRpcQuery as useRpcQuery,
  useBbContext,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { designWikiRpcContract } from "./contract.js";
import { WikiListView } from "./ui/wiki-list-view.js";
import { WikiPageView } from "./ui/wiki-page-view.js";

const PANEL = "wiki";
const TASK_PANEL = "/plugins/tasks/tasks/task/";

export interface WikiLocation {
  projectId: string | null;
  pageId: string | null;
}

function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined || segment === "") return null;
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function parseWikiLocation(subPath: string): WikiLocation {
  const [project, page] = subPath.split("/").filter((part) => part !== "");
  return { projectId: decodeSegment(project), pageId: decodeSegment(page) };
}

function openCard(key: string) {
  window.location.assign(`${TASK_PANEL}${encodeURIComponent(key)}`);
}

function Message(props: { children: string; tone?: "error" }) {
  return (
    <p
      role={props.tone === "error" ? "alert" : "status"}
      className={
        props.tone === "error"
          ? "text-sm text-destructive-text"
          : "text-sm text-subtle-foreground"
      }
    >
      {props.children}
    </p>
  );
}

function PageDetail(props: { projectId: string; pageId: string }) {
  const query = useRpcQuery({
    contract: designWikiRpcContract,
    method: "page",
    input: { projectId: props.projectId, pageId: props.pageId },
  });
  if (query.error !== null && query.data === undefined) {
    return <Message tone="error">Could not load this page.</Message>;
  }
  if (query.data === undefined) return <Message>Loading page…</Message>;
  if (query.data.state === "missing") {
    return <Message>That page no longer exists.</Message>;
  }
  return <WikiPageView page={query.data.page} onOpenCard={openCard} />;
}

function WikiPanel(props: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const context = useBbContext();
  const location = parseWikiLocation(props.subPath);
  const projectId = location.projectId ?? context.projectId;

  const projects = useRpcQuery({
    contract: designWikiRpcContract,
    method: "projects",
    input: {},
  });
  const list = useRpcQuery({
    contract: designWikiRpcContract,
    method: "list",
    input: { projectId: projectId ?? "" },
    enabled: projectId !== null,
  });

  const go = (nextProject: string, pageId?: string) =>
    navigate.toPluginPanel(PANEL, {
      subPath:
        pageId === undefined ? nextProject : `${nextProject}/${pageId}`,
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Design Wiki</h1>
        <label className="flex items-center gap-2 text-xs text-subtle-foreground">
          Project
          <select
            aria-label="Project"
            value={projectId ?? ""}
            onChange={(event) => {
              if (event.target.value !== "") go(event.target.value);
            }}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
          >
            {projectId === null ? <option value="">Select a project</option> : null}
            {(projects.data ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {projectId === null ? (
        <Message>Select a project to read its design wiki.</Message>
      ) : list.error !== null && list.data === undefined ? (
        <Message tone="error">Could not load the design wiki.</Message>
      ) : list.data === undefined ? (
        <Message>Loading wiki…</Message>
      ) : (
        <div className="grid min-h-0 gap-6 lg:grid-cols-[minmax(18rem,26rem)_minmax(0,1fr)]">
          <WikiListView
            list={list.data}
            selectedId={location.pageId}
            onSelect={(page) => go(projectId, page.id)}
            onOpenCard={openCard}
          />
          {location.pageId === null ? null : (
            <PageDetail projectId={projectId} pageId={location.pageId} />
          )}
        </div>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: PANEL,
    title: "Design Wiki",
    icon: "BookOpen",
    path: PANEL,
    component: WikiPanel,
  });
});
