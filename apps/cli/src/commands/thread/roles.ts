import { Command } from "commander";
import { threadRoleNameSchema } from "@bb/domain";
import {
  threadRoleConflictDetailsSchema,
  type ThreadRoleStateResponse,
} from "@bb/server-contract";
import { BbHttpError } from "@bb/sdk";
import {
  action,
  CliExitError,
  CliQuietExit,
  CliUsageError,
} from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveExplicitIdFlag } from "../../context-env.js";
import { outputJson } from "../helpers.js";

interface ThreadRoleJsonOptions {
  json?: boolean;
}

interface ThreadRoleTransferOptions extends ThreadRoleJsonOptions {
  expectGeneration: string;
  to: string;
}

interface ThreadRoleReleaseOptions extends ThreadRoleJsonOptions {
  expectGeneration: string;
}

export function parseThreadRoleName(value: string): string {
  const parsed = threadRoleNameSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CliUsageError({
    code: "invalid_role_name",
    hint: null,
    message: `Invalid role name "${value}". Role names match [a-z0-9-]+.`,
  });
}

function parseExpectedGeneration(value: string): number {
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(parsed)) return parsed;
  throw new CliUsageError({
    code: "invalid_generation",
    hint: null,
    message: `Invalid --expect-generation "${value}". Pass a non-negative integer.`,
  });
}

function formatHolder(state: ThreadRoleStateResponse): string {
  if (state.threadId === null) {
    return `${state.role} (no holder) generation ${state.generation}`;
  }
  const title =
    state.title === null ? "<untitled>" : JSON.stringify(state.title);
  const since =
    state.since === null ? "unknown" : new Date(state.since).toISOString();
  const archived = state.archived === true ? " (archived)" : "";
  return `${state.role} ${state.threadId} ${title} generation ${state.generation} since ${since}${archived}`;
}

function conflictHint(state: ThreadRoleStateResponse): string {
  if (state.threadId === null) {
    return `Current: ${state.role} has no holder at generation ${state.generation}.`;
  }
  return `Current: ${formatHolder(state)}`;
}

function bodyDetails(body: unknown): unknown {
  if (typeof body !== "object" || body === null || !("details" in body)) {
    return undefined;
  }
  return body.details;
}

async function withRoleErrorDetails<T>(
  opts: ThreadRoleJsonOptions,
  request: Promise<T>,
): Promise<T> {
  try {
    return await request;
  } catch (error: unknown) {
    if (!(error instanceof BbHttpError)) throw error;
    const parsed = threadRoleConflictDetailsSchema.safeParse(
      bodyDetails(error.body),
    );
    if (!parsed.success) throw error;
    throw new CliExitError(error.message, 1, {
      code: error.code ?? `http_${error.status}`,
      details: parsed.data,
      hint: opts.json === true ? null : conflictHint(parsed.data.current),
    });
  }
}

export async function claimThreadRoleForThread(args: {
  getUrl: () => string;
  opts: ThreadRoleJsonOptions;
  role: string;
  threadId: string;
}): Promise<void> {
  const role = parseThreadRoleName(args.role);
  const state = await withRoleErrorDetails(
    args.opts,
    createCliBbSdk(args.getUrl()).experimental_threadRoles.claim({
      role,
      threadId: args.threadId,
    }),
  );
  if (outputJson(args.opts, state)) return;
  console.log(formatHolder(state));
}

export function registerThreadRoleCommands(
  parent: Command,
  getUrl: () => string,
): void {
  const role = parent
    .command("role")
    .description("Inspect and move the threads that hold named roles");

  role
    .command("get <role>")
    .description(
      "Show which thread holds a role. Exits 3 when no thread holds it.",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (roleInput: string, opts: ThreadRoleJsonOptions) => {
        const name = parseThreadRoleName(roleInput);
        const state = await createCliBbSdk(
          getUrl(),
        ).experimental_threadRoles.get({ role: name });
        if (state.threadId === null) {
          outputJson(opts, state);
          console.error(`No thread holds role ${name}.`);
          throw new CliQuietExit(3, "role_unheld");
        }
        if (outputJson(opts, state)) return;
        console.log(formatHolder(state));
      }),
    );

  role
    .command("list")
    .description("List every role with its holder")
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (opts: ThreadRoleJsonOptions) => {
        const result = await createCliBbSdk(
          getUrl(),
        ).experimental_threadRoles.list();
        if (outputJson(opts, result)) return;
        if (result.roles.length === 0) {
          console.log("No roles.");
          return;
        }
        for (const state of result.roles) console.log(formatHolder(state));
      }),
    );

  role
    .command("transfer <role>")
    .description(
      "Move a held role to another thread in one atomic step. Fails if the generation moved.",
    )
    .requiredOption("--to <threadId>", "Thread that becomes the holder")
    .requiredOption(
      "--expect-generation <n>",
      "Generation read from `bb thread role get`",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (roleInput: string, opts: ThreadRoleTransferOptions) => {
        const name = parseThreadRoleName(roleInput);
        const expectGeneration = parseExpectedGeneration(
          opts.expectGeneration,
        );
        const toThreadId = resolveExplicitIdFlag({
          flagName: "--to",
          value: opts.to,
        });
        if (toThreadId === undefined) {
          throw new CliUsageError({
            code: "missing_required",
            hint: null,
            message: "Missing --to thread ID.",
          });
        }
        const state = await withRoleErrorDetails(
          opts,
          createCliBbSdk(getUrl()).experimental_threadRoles.transfer({
            expectGeneration,
            role: name,
            toThreadId,
          }),
        );
        if (outputJson(opts, state)) return;
        console.log(formatHolder(state));
      }),
    );

  role
    .command("release <role>")
    .description("Release a held role. Fails if the generation moved.")
    .requiredOption(
      "--expect-generation <n>",
      "Generation read from `bb thread role get`",
    )
    .option("--json", "Print machine-readable JSON output")
    .action(
      action(async (roleInput: string, opts: ThreadRoleReleaseOptions) => {
        const name = parseThreadRoleName(roleInput);
        const expectGeneration = parseExpectedGeneration(
          opts.expectGeneration,
        );
        const state = await withRoleErrorDetails(
          opts,
          createCliBbSdk(getUrl()).experimental_threadRoles.release({
            expectGeneration,
            role: name,
          }),
        );
        if (outputJson(opts, state)) return;
        console.log(formatHolder(state));
      }),
    );
}
