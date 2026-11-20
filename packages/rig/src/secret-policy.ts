import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

type ConfigValue =
  | null
  | boolean
  | number
  | string
  | ConfigValue[]
  | { [key: string]: ConfigValue };
const secretNames = /^(?:env:[A-Z_][A-Z0-9_]*|store:[A-Za-z0-9._/-]+)$/u;
const sensitiveKey =
  /(?:secret|password|passwd|credential|authorization|cookie|(?:^|[_-])auth(?:$|[_-])|token$|key$|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret)/iu;
const credentialShape =
  /(?:\bBearer\s+\S+|\b(?:sk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+|-----BEGIN.*PRIVATE KEY|(?:password|token|secret|api[_-]?key)\s*[=:]\s*\S+|--?(?:password|passwd|token|api[-_]key|client[-_]secret|access[-_]token|refresh[-_]token)(?:[= \t])\S+)/iu;
const opaqueValue = /[A-Za-z0-9+_=-]{48,}/u;
const publicKeys = new Set([
  "permissions",
  "defaultMode",
  "approval_policy",
  "sandbox_mode",
  "mode",
  "model",
  "endpoint",
  "enabled",
  "priority",
  "createdAt",
  "lastUsedAt",
  "lastUsedHostId",
  "label",
  "email",
  "accountUuid",
  "codexAccountId",
  "subscriptionType",
  "rateLimitTier",
  "kind",
  "provider",
  "switchThreshold",
  "parentMode",
  "nestedLaunchThreadIds",
  "anthropicUpstreamBaseUrl",
  "codexUpstreamBaseUrl",
  "hooks",
  "matcher",
  "type",
  "timeout",
  "timeoutSeconds",
  "async",
  "asyncTimeout",
  "command",
  "argv",
  "args",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "DirectoryAdded",
  "MessageDisplay",
  "preToolUse",
  "permissionRequest",
  "postToolUse",
  "preCompact",
  "postCompact",
  "sessionStart",
  "sessionEnd",
  "userPromptSubmit",
  "subagentStart",
  "subagentStop",
  "stop",
]);
const secretKeys = new Set([
  "apiKey",
  "api_key",
  "password",
  "passwd",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
  "clientSecret",
  "client_secret",
  "privateKey",
  "private_key",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "credential",
]);
const publicBooleans = new Set([
  "--help",
  "--version",
  "--check",
  "--dry-run",
  "--json",
  "--verbose",
  "--quiet",
  "--no-color",
]);
const publicExecutables = new Set([
  "node",
  "python",
  "python3",
  "bash",
  "sh",
  "rig",
  "git",
  "true",
  "false",
]);
const commandKeys = new Set(["command", "argv", "args"]);

export function credentialLike(value: string): boolean {
  return credentialShape.test(value);
}
export function safeReferenceName(name: string): boolean {
  return secretNames.test(name) && !credentialShape.test(name);
}
function isReference(v: ConfigValue): v is { secretRef: string } {
  return Boolean(
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.keys(v).length === 1 &&
    typeof v.secretRef === "string" &&
    safeReferenceName(v.secretRef),
  );
}
function referenceName(path: string): string {
  return `store:rig/${createHash("sha256").update(path).digest("hex").slice(0, 24)}`;
}
function safePath(v: string): boolean {
  return (
    /^(?:\.?\.?\/|[A-Za-z]:[\\/])/u.test(v) &&
    /^[A-Za-z0-9._/\\:@+-]+$/u.test(v) &&
    !credentialShape.test(v)
  );
}
export function publicCommand(v: ConfigValue, key: string): boolean {
  const tokens = typeof v === "string" ? v.split(/[ \t]+/u) : v;
  if (
    !Array.isArray(tokens) ||
    tokens.some((t) => typeof t !== "string") ||
    (typeof v === "string" && /[\r\n]/u.test(v))
  )
    return false;
  const strings = tokens.filter((t): t is string => typeof t === "string");
  if (key === "args") return strings.every((t) => publicBooleans.has(t));
  const [executable, ...args] = strings;
  return Boolean(
    executable &&
    (publicExecutables.has(executable) || safePath(executable)) &&
    args.every((t) => publicBooleans.has(t)),
  );
}
function secretLike(v: string, key: string): boolean {
  if (credentialShape.test(v)) return true;
  if (opaqueValue.test(v) && !(key === "command" && publicCommand(v, key)))
    return true;
  try {
    const url = new URL(v);
    return Boolean(url.username || url.password || url.search || url.hash);
  } catch {
    return false;
  }
}
function safeKey(key: string): boolean {
  return (
    /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(key) &&
    !credentialShape.test(key) &&
    !opaqueValue.test(key) &&
    !["__proto__", "constructor", "prototype"].includes(key)
  );
}
type ConfigScope = "agent" | "hooks" | "pool" | "account" | "plugin";
const accountText = new Set(
  "label email accountUuid codexAccountId subscriptionType rateLimitTier lastUsedHostId".split(
    " ",
  ),
);
const enums: Record<string, Set<string>> = {
  defaultMode: new Set([
    "default",
    "acceptEdits",
    "bypassPermissions",
    "plan",
    "dontAsk",
    "auto",
  ]),
  approval_policy: new Set([
    "untrusted",
    "on-failure",
    "on-request",
    "never",
    "granular",
  ]),
  sandbox_mode: new Set(["read-only", "workspace-write", "danger-full-access"]),
  mode: new Set(["local", "default", "auto", "proxy", "isolate"]),
  parentMode: new Set(["proxy", "isolate"]),
  type: new Set(["command", "prompt", "agent", "http"]),
  kind: new Set(["oauth", "api-key"]),
  provider: new Set(["claude", "codex"]),
};
function inferScope(path: string): ConfigScope {
  if (path.includes("/accountPool/accounts/")) return "account";
  if (path.includes("/accountPool/settings")) return "pool";
  if (path.includes("/plugins/")) return "plugin";
  return path.endsWith("/hooks") ? "hooks" : "agent";
}
function knownKey(key: string, scope: ConfigScope): boolean {
  if (accountText.has(key)) return scope === "account";
  if (key === "model") return scope === "agent" || scope === "hooks";
  return publicKeys.has(key) || secretKeys.has(key);
}
const textKeys = new Set(
  "defaultMode approval_policy sandbox_mode mode model endpoint label email accountUuid codexAccountId subscriptionType rateLimitTier kind provider lastUsedHostId parentMode anthropicUpstreamBaseUrl codexUpstreamBaseUrl matcher type".split(
    " ",
  ),
);
const numberKeys = new Set(
  "priority createdAt lastUsedAt switchThreshold timeout timeoutSeconds asyncTimeout".split(
    " ",
  ),
);
const booleanKeys = new Set(["enabled", "async"]);
const hookEvents = new Set(
  [...publicKeys]
    .filter((k) => /^[A-Z]/u.test(k))
    .concat(
      "preToolUse permissionRequest postToolUse preCompact postCompact sessionStart sessionEnd userPromptSubmit subagentStart subagentStop stop".split(
        " ",
      ),
    ),
);
function configObject(v: ConfigValue): boolean {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}
function publicShape(v: ConfigValue, key: string): boolean {
  if (Object.hasOwn(enums, key) && v !== null)
    return typeof v === "string" && enums[key].has(v);
  if (
    ["endpoint", "anthropicUpstreamBaseUrl", "codexUpstreamBaseUrl"].includes(
      key,
    ) &&
    v !== null
  ) {
    if (typeof v !== "string") return false;
    try {
      const url = new URL(v);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        ["/", "/v1", "/backend-api/codex"].includes(url.pathname)
      );
    } catch {
      return false;
    }
  }
  if (textKeys.has(key)) return v === null || typeof v === "string";
  if (numberKeys.has(key)) return v === null || typeof v === "number";
  if (booleanKeys.has(key)) return v === null || typeof v === "boolean";
  if (key === "permissions") return configObject(v);
  if (key === "hooks")
    return configObject(v) || (Array.isArray(v) && v.every(configObject));
  if (hookEvents.has(key)) return Array.isArray(v) && v.every(configObject);
  if (key === "nestedLaunchThreadIds")
    return (
      Array.isArray(v) &&
      v.every((id) => typeof id === "string" && /^thr_[A-Za-z0-9_]+$/u.test(id))
    );
  return true;
}
export function sanitizeConfig(
  v: ConfigValue,
  path: string,
  notices: string[],
  key = "",
  scope: ConfigScope = inferScope(path),
  retainUnknownReferences = false,
): ConfigValue {
  if (isReference(v)) return v;
  if (
    (sensitiveKey.test(key) && v !== null) ||
    !publicShape(v, key) ||
    (commandKeys.has(key) && !publicCommand(v, key)) ||
    (typeof v === "string" && secretLike(v, key))
  ) {
    const ref = referenceName(path);
    notices.push(`${path} -> ${ref}`);
    return { secretRef: ref };
  }
  if (Array.isArray(v))
    return v.map((child, i) =>
      sanitizeConfig(
        child,
        `${path}/${i}`,
        notices,
        "",
        scope,
        retainUnknownReferences,
      ),
    );
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.entries(v).flatMap(([childKey, child]) => {
        const childPath = `${path}/${childKey}`;
        if (!safeKey(childKey) || !knownKey(childKey, scope)) {
          if (
            retainUnknownReferences &&
            safeKey(childKey) &&
            isReference(child)
          ) {
            notices.push(
              `warning: retained an explicitly named reference for an unknown key at ${referenceName(childPath)}`,
            );
            return [[childKey, child]];
          }
          notices.push(
            `warning: skipped an unknown or unsafe key in ${path} at ${referenceName(childPath)} (name and value suppressed)`,
          );
          return [];
        }
        return [
          [
            childKey,
            sanitizeConfig(
              child,
              childPath,
              notices,
              childKey,
              scope,
              retainUnknownReferences,
            ),
          ],
        ];
      }),
    );
  return v;
}
export function assertSafeConfig(
  v: ConfigValue,
  scope: ConfigScope = "agent",
): void {
  if (
    !isDeepStrictEqual(
      v,
      sanitizeConfig(v, "configuration", [], "", scope, true),
    )
  )
    throw new Error(
      "Unknown or sensitive configuration requires a named reference",
    );
}
