export const JSON_SHAPE_BY_COMMAND_PATH: Readonly<Record<string, string>> = {
  status:
    "{project: {id, name} | null, thread: {id, status, title, parentThreadId, environment: {hostId, display} | null} | null, childThreads: [{id, status, title}] | null, pendingTodos, pluginsNeedingAttention: [{id, status}], dataDir}",
  "thread list":
    "[{id, projectId, environmentId, providerId, title, status, parentThreadId, sectionId, visibility, archivedAt, pinnedAt, createdAt, updatedAt, activity}]    (bare array; title can be null)",
  "thread show":
    "{thread: {id, status, archivedAt, title, projectId, environmentId, parentThreadId, ...}, environment: {id, hostId, path, branchName, ...} | null, pendingTodos}    (thread fields are under .thread; status is the run state, archivedAt is null unless the thread is archived)",
  "thread log":
    "[{id, seq, type, createdAt, threadId, scope, data}]    (bare array of raw events, oldest first; page with --after-seq <seq>); with --message: {message, before, after} of conversation rows",
  "thread output": "{output}",
  "thread archive":
    "{ok, threadId, alreadyArchived, archivedAt, archivedThreadIds}    (archivedThreadIds lists only threads this call archived)",
  "thread spawn":
    "the created thread: {id, status, title, projectId, environmentId, ...}",
  "thread wait": "{threadId, matched: true, target}",
  "thread search": "{active: {total, results}, archived: {total, results}}",
  "thread role get":
    "{role, threadId, title, archived, generation, since}    (exit 3 with the same body when threadId is null: nobody holds the role; archived holders are still returned)",
  "thread role list":
    "{roles: [{role, threadId, title, archived, generation, since}]}    (wrapped in .roles; threadId, title, archived are null for a role nobody holds)",
  "thread role transfer":
    "{role, threadId, title, archived, generation, since}    (the role after the change; fails with a 409 error carrying error.details.current when the generation moved)",
  "thread role release":
    "{role, threadId: null, title: null, archived: null, generation, since}    (the role after the release; fails with a 409 error carrying error.details.current when the generation moved)",
  "prompt-history list":
    "{entries: [{id, createdAt, input, projectId, threadId, scope}], nextCursor: string | null}",
  "window list":
    "{windows: [{windowId, presetId, route, sidebarOpen, rightPanelOpen, rightPanelTab, maximizedPaneId, panes: [{paneId, kind, projectId, threadId, threadTitle, pluginId, panelPath, focused}], viewport, reportedAt}]}",
  "window show":
    "one window: {windowId, presetId, route, sidebarOpen, rightPanelOpen, rightPanelTab, maximizedPaneId, panes, viewport, reportedAt}",
  "window preset list":
    "[{id, name, panes, direction, hideSidebar, rightPanelTab, userEditable, suggestion: {panes, reason, proposedBy, proposedAt, suggestionId} | null}]    (bare array)",
  "window propose":
    "{presetId, suggestion: {panes, reason, proposedBy, proposedAt, suggestionId}}",
  "project list":
    "[{id, kind, name, gitRemoteUrl, sources: [{id, hostId, path, isDefault}]}]    (bare array)",
  "machine list":
    "[{id, name, type, status, lifecycle, maxPermissionMode, lastSeenAt}]    (bare array)",
  "provider list":
    "[{id, displayName, available, capabilities, reasoningLevels, serviceTiers}]    (bare array)",
  "provider models":
    "[{id, model, displayName, supportedReasoningEfforts, defaultReasoningEffort, supportedServiceTiers?, isDefault}]    (bare array)",
  "environment list":
    "[{id, name, projectId, hostId, path, branchName, status, lifecycle}]    (bare array)",
  "environment show":
    "{id, name, projectId, hostId, path, branchName, baseBranch, status, lifecycle}",
  "terminal list":
    "{sessions: [{id, title, status, exitCode, closeReason, cols, rows}]}    (wrapped in .sessions)",
  "terminal output":
    '{chunks: [{seq, dataBase64}], nextSeq, truncated, status, exitCode, closeReason}    (chunk data is base64; status is "exited" once the command has finished)',
  "terminal run":
    '{terminalId, hostId, environmentId, cwd, status, observation, exitCode, closeReason, output, truncated, nextSeq}    (observation is "exited", "matched", or "timed-out"; output is plain text with terminal escapes removed, or null once the machine no longer keeps it)',
  "terminal wait":
    "{terminalId, hostId, environmentId, cwd, status, observation, exitCode, closeReason, output, truncated, nextSeq}    (same shape as terminal run)",
  "plugin list":
    "{plugins: [{id, version, enabled, status, source, rootDir}]}    (wrapped in .plugins)",
  "skill list":
    "{skills: [{id, name, description, scope, provider, filePath}]}    (wrapped in .skills)",
};

export function jsonShapeHelp(commandPath: string): string | null {
  const shape = JSON_SHAPE_BY_COMMAND_PATH[commandPath];
  return shape === undefined
    ? null
    : `\nJSON (--json): ${shape}\nErrors with --json: {"ok": false, "error": {code, message, hint?}} on stdout. Run \`bb guide json\` for every shape.`;
}
