import { useState } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery as useRpcQuery,
  useBbContext,
  useBbNavigate,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { designWikiRpcContract } from "./contract.js";
import { Message, WikiBrowser } from "./ui/wiki-browser.js";

const PANEL = "wiki";

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
      ) : (
        <WikiBrowser
          projectId={projectId}
          pageId={location.pageId}
          layout="split"
          onSelectPage={(pageId) => go(projectId, pageId ?? undefined)}
        />
      )}
    </div>
  );
}

function WikiThreadPanel() {
  const { projectId } = useBbContext();
  const [pageId, setPageId] = useState<string | null>(null);
  const [forProject, setForProject] = useState(projectId);
  if (forProject !== projectId) {
    setForProject(projectId);
    setPageId(null);
  }
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      {projectId === null ? (
        <Message>This thread has no project, so it has no design wiki.</Message>
      ) : (
        <WikiBrowser
          projectId={projectId}
          pageId={pageId}
          layout="stacked"
          onSelectPage={setPageId}
        />
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
  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "fixed",
    id: PANEL,
    title: "Design Wiki",
    icon: "BookOpen",
    component: WikiThreadPanel,
  });
});
