import {
  ThreadRoleError,
  claimThreadRole,
  getThreadRole,
  isSqliteBusyError,
  listThreadRoles,
  releaseThreadRole,
  transferThreadRole,
  type ThreadRoleActor,
  type ThreadRoleState,
} from "@bb/db";
import { threadRoleNameSchema } from "@bb/domain";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import {
  resolveRequestSource,
  type RequestHeaderReader,
  type RequestSource,
} from "../request-context.js";
import type { PluginService } from "../services/plugins/plugin-service.js";

function requireRoleName(role: string): string {
  if (!threadRoleNameSchema.safeParse(role).success) {
    throw new ApiError(400, "invalid_role_name", "Role names match [a-z0-9-]+");
  }
  return role;
}

function toApiError(error: unknown): unknown {
  if (error instanceof ThreadRoleError) {
    const details =
      error.details.current === undefined
        ? undefined
        : { current: error.details.current };
    return new ApiError(statusForRoleError(error), error.code, error.message, {
      details,
    });
  }
  if (error instanceof Error && isSqliteBusyError(error)) {
    return new ApiError(
      503,
      "database_busy",
      "The database is busy. Retry the request.",
      { retryable: true },
    );
  }
  return error;
}

function statusForRoleError(error: ThreadRoleError): 400 | 404 | 409 {
  switch (error.code) {
    case "invalid_role_name":
      return 400;
    case "thread_not_found":
    case "role_not_found":
      return 404;
    default:
      return 409;
  }
}

function runRoleOperation<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    throw toApiError(error);
  }
}

function actorFor(source: RequestSource): ThreadRoleActor {
  switch (source.kind) {
    case "cli":
      return {
        updatedByKind: "cli",
        updatedByThreadId: source.callerThreadId,
      };
    case "app":
      return { updatedByKind: "app" };
    case "api":
      return { updatedByKind: "api" };
    case "plugin":
      throw new ApiError(
        403,
        "forbidden",
        "Plugins cannot change thread roles",
      );
  }
}

export function registerThreadRoleRoutes(
  app: Hono,
  deps: AppDeps,
  plugins: PluginService,
): void {
  const { get, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });
  const routes = publicApiRoutes.threadRoles;

  function mutationActor(context: RequestHeaderReader): {
    actor: ThreadRoleActor;
    source: RequestSource;
  } {
    const source = resolveRequestSource(context, plugins.resolveRpcCaller);
    return { actor: actorFor(source), source };
  }

  function logMutation(args: {
    action: "claim" | "transfer" | "release";
    before: ThreadRoleState;
    after: ThreadRoleState;
    source: RequestSource;
  }): void {
    deps.logger.info(
      {
        action: args.action,
        role: args.after.role,
        previousHolderObserved: args.before.threadId,
        previousGenerationObserved: args.before.generation,
        holder: args.after.threadId,
        generation: args.after.generation,
        sourceKind: args.source.kind,
        callerThreadId:
          args.source.kind === "cli" ? args.source.callerThreadId : null,
      },
      "Thread role changed",
    );
  }

  get(routes.get, (context) => {
    const role = requireRoleName(context.req.param("role"));
    return context.json(runRoleOperation(() => getThreadRole(deps.db, role)));
  });

  get(routes.list, (context) =>
    context.json({ roles: runRoleOperation(() => listThreadRoles(deps.db)) }),
  );

  post(routes.claim, (context, payload) => {
    const role = requireRoleName(context.req.param("role"));
    const { actor, source } = mutationActor(context);
    const before = runRoleOperation(() => getThreadRole(deps.db, role));
    const after = runRoleOperation(() =>
      claimThreadRole(deps.db, { ...actor, role, threadId: payload.threadId }),
    );
    logMutation({ action: "claim", before, after, source });
    return context.json(after);
  });

  post(routes.transfer, (context, payload) => {
    const role = requireRoleName(context.req.param("role"));
    const { actor, source } = mutationActor(context);
    const before = runRoleOperation(() => getThreadRole(deps.db, role));
    const after = runRoleOperation(() =>
      transferThreadRole(deps.db, {
        ...actor,
        role,
        toThreadId: payload.toThreadId,
        expectedGeneration: payload.expectGeneration,
      }),
    );
    logMutation({ action: "transfer", before, after, source });
    return context.json(after);
  });

  post(routes.release, (context, payload) => {
    const role = requireRoleName(context.req.param("role"));
    const { actor, source } = mutationActor(context);
    const before = runRoleOperation(() => getThreadRole(deps.db, role));
    const after = runRoleOperation(() =>
      releaseThreadRole(deps.db, {
        ...actor,
        role,
        expectedGeneration: payload.expectGeneration,
      }),
    );
    logMutation({ action: "release", before, after, source });
    return context.json(after);
  });
}
