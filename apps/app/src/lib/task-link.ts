import { resolveRouteHref } from "./route-paths";

export const TASKS_PLUGIN_ID = "tasks";
export const TASK_THREAD_PANEL_ACTION_ID = "task";

export interface MarkdownTaskLink {
  taskKey: string;
}

const TASK_LINK_PATH_PATTERN = /^\/plugins\/tasks\/tasks\/task\/([^/?#]+)\/?$/u;
const TASK_LINK_SCHEME_PATTERN = /^bbtask:\/\/([^/?#]+)$/iu;

export function isMarkdownTaskSchemeHref(href: string): boolean {
  return TASK_LINK_SCHEME_PATTERN.test(href);
}

function decodeTaskKeyComponent(rawTaskKey: string): string | null {
  try {
    return decodeURIComponent(rawTaskKey);
  } catch {
    return null;
  }
}

export function parseMarkdownTaskLinkHref(
  href: string | undefined,
): MarkdownTaskLink | null {
  if (!href) {
    return null;
  }

  const schemeMatch = TASK_LINK_SCHEME_PATTERN.exec(href);
  if (schemeMatch) {
    const taskKey = decodeTaskKeyComponent(schemeMatch[1] ?? "");
    return taskKey !== null && taskKey.length > 0 ? { taskKey } : null;
  }

  if (typeof window === "undefined") {
    return null;
  }
  const resolved = resolveRouteHref({
    currentOrigin: window.location.origin,
    href,
  });
  if (resolved === null) {
    return null;
  }
  const pathMatch = TASK_LINK_PATH_PATTERN.exec(resolved.path);
  if (pathMatch === null) {
    return null;
  }
  const taskKey = decodeTaskKeyComponent(pathMatch[1] ?? "");
  return taskKey !== null && taskKey.length > 0 ? { taskKey } : null;
}

export interface TaskLinkPluginPanelRequest {
  actionId: string;
  params: { taskKey: string };
  pluginId: string;
  title: string;
}

export function buildTaskLinkPluginPanelRequest(
  href: string | undefined,
): TaskLinkPluginPanelRequest | null {
  const taskLink = parseMarkdownTaskLinkHref(href);
  if (taskLink === null) {
    return null;
  }
  return {
    actionId: TASK_THREAD_PANEL_ACTION_ID,
    params: { taskKey: taskLink.taskKey },
    pluginId: TASKS_PLUGIN_ID,
    title: taskLink.taskKey,
  };
}
