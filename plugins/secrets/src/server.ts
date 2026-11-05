import { randomUUID } from "node:crypto";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  cliError,
  foldDescribePairs,
  parseRequest,
  resolveDestinationPath,
  type ParsedRequest,
} from "./request-args.js";
import {
  SECRET_REQUEST_RENDERER_ID,
  secretRequestResponseSchema,
} from "./secret-request.js";

const SECRET_REQUEST_MAX_TTL_MS = 3_600_000;
const ROW_LABEL_MAX_LENGTH = 80;
const ROW_TITLE_MAX_LENGTH = 160;

const threadHostSchema = z.object({
  host: z.object({ id: z.string() }).nullable().optional(),
});
const identitySchema = z.object({ dev: z.string(), ino: z.string() });
const refusedSchema = z.object({
  outcome: z.literal("refused"),
  reason: z.string(),
  message: z.string(),
});
const probeResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("ready"),
    destRealpath: z.string(),
    parent: identitySchema,
    file: identitySchema.nullable(),
    allowlistEntrySha256: z.string(),
    consumer: z.string(),
    existingNames: z.array(z.string()),
    requestDigest: z.string(),
  }),
  refusedSchema,
]);
const countsShape = {
  added: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
};
const commitResultSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("written"), ...countsShape }),
  z.object({ outcome: z.literal("committed-elsewhere"), ...countsShape }),
  z.object({ outcome: z.literal("replaced-after-commit"), ...countsShape }),
  refusedSchema,
]);

function clampToLength(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function httpStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error))
    return null;
  const status = error.status;
  return typeof status === "number" ? status : null;
}

function sanitizeError(error: unknown, stage: string): PluginCliError {
  if (error instanceof PluginCliError) return error;
  const status = httpStatus(error);
  return new PluginCliError(
    `Secret request failed while ${stage}${status === null ? "" : ` (HTTP ${status})`}.`,
    { code: "secret_request_failed" },
  );
}

function refusal(
  result: z.infer<typeof refusedSchema>,
  stage: string,
): PluginCliError {
  return new PluginCliError(`Secret ${stage} refused: ${result.message}`, {
    code: `secret_refused_${result.reason.replaceAll("-", "_")}`,
  });
}

function requestFields(parsed: ParsedRequest) {
  return parsed.names.map((name) => ({
    name,
    description: parsed.descriptions.get(name) ?? null,
  }));
}

export async function runRequest(
  bb: BbPluginApi,
  parsed: ParsedRequest,
  ctx: PluginCliContext,
  now: () => number = Date.now,
): Promise<PluginCliResult> {
  if (!ctx.threadId)
    cliError("bb secret request must run from a bb thread.", "missing_thread");
  if (!ctx.cwd) {
    cliError(
      "bb secret request requires the invoking working directory.",
      "missing_cwd",
    );
  }
  const threadId = ctx.threadId;
  const destinationPath = resolveDestinationPath(ctx.cwd, parsed.writeEnv);

  let hostId: string;
  try {
    const thread = threadHostSchema.parse(
      await bb.sdk.threads.get({ threadId, include: "host" }),
    );
    if (!thread.host?.id) {
      cliError("The thread needs a live host.", "missing_host");
    }
    hostId = thread.host.id;
  } catch (error) {
    throw sanitizeError(error, "resolving the thread host");
  }

  const requestId = randomUUID();
  const expiresAtMs = now() + SECRET_REQUEST_MAX_TTL_MS;
  const binding = {
    hostId,
    requestId,
    threadId,
    project: parsed.project,
    path: destinationPath,
    fields: requestFields(parsed),
    purpose: parsed.purpose,
    expiresAtMs,
  };

  let probe: z.infer<typeof probeResultSchema>;
  try {
    probe = probeResultSchema.parse(await bb.sdk.files.secretProbe(binding));
  } catch (error) {
    throw sanitizeError(error, "checking the destination");
  }
  if (probe.outcome === "refused") throw refusal(probe, "request");

  const existing = new Set(probe.existingNames);
  const payload = {
    requestId,
    threadId,
    project: parsed.project,
    purpose: parsed.purpose,
    destination: {
      kind: "dotenv" as const,
      path: probe.destRealpath,
      consumer: probe.consumer,
    },
    digestPrefix: probe.requestDigest.slice(0, 12),
    allowlistEntryPrefix: probe.allowlistEntrySha256.slice(0, 12),
    expiresAtMs,
    fields: binding.fields.map((field) => ({
      ...field,
      existing: existing.has(field.name),
    })),
  };

  let result: Awaited<ReturnType<typeof bb.ui.requestInput>>;
  try {
    result = await bb.ui.requestInput(
      {
        threadId,
        rendererId: SECRET_REQUEST_RENDERER_ID,
        title: "Add secrets",
        payload,
        timeoutMs: Math.max(
          1,
          Math.min(expiresAtMs - now(), SECRET_REQUEST_MAX_TTL_MS),
        ),
        presentation: {
          label: {
            pending: clampToLength(
              `Requesting ${parsed.names.join(", ")}`,
              ROW_LABEL_MAX_LENGTH,
            ),
            completed: clampToLength(
              `Requested ${parsed.names.join(", ")}`,
              ROW_LABEL_MAX_LENGTH,
            ),
          },
        },
        describeSubmission: (value) => {
          const response = secretRequestResponseSchema.safeParse(value);
          const names = response.success
            ? Object.keys(response.data.values).sort()
            : [];
          return {
            title: clampToLength(
              `Provided ${names.join(", ")}`,
              ROW_TITLE_MAX_LENGTH,
            ),
            detail: [
              probe.destRealpath,
              ...names.map((name) => `- ${name}`),
            ].join("\n"),
          };
        },
      },
      { signal: ctx.signal },
    );
  } catch (error) {
    throw sanitizeError(error, "waiting for the secure form");
  }
  if (result.outcome === "cancelled") {
    cliError(
      `Secret request cancelled (${result.reason}).`,
      "secret_request_cancelled",
    );
  }

  if (now() >= expiresAtMs) {
    cliError("The secret request expired before it was submitted.", "expired");
  }
  const response = secretRequestResponseSchema.safeParse(result.value);
  if (!response.success) {
    cliError("The secret response was malformed.", "malformed_secret_response");
  }
  const responseNames = Object.keys(response.data.values).sort();
  if (responseNames.join("\0") !== [...parsed.names].sort().join("\0")) {
    cliError(
      "Secret response did not contain exactly the requested variables.",
      "unexpected_secret_response",
    );
  }

  let committed: z.infer<typeof commitResultSchema>;
  try {
    committed = commitResultSchema.parse(
      await bb.sdk.files.secretCommit({
        ...binding,
        requestDigest: probe.requestDigest,
        parent: probe.parent,
        file: probe.file,
        allowlistEntrySha256: probe.allowlistEntrySha256,
        values: response.data.values,
      }),
    );
  } catch (error) {
    throw sanitizeError(error, "writing the secrets");
  }
  if (committed.outcome === "refused") throw refusal(committed, "write");

  const summary = {
    outcome: committed.outcome,
    path: probe.destRealpath,
    names: parsed.names,
    added: committed.added,
    updated: committed.updated,
    unchanged: committed.unchanged,
  };
  if (committed.outcome !== "written") {
    return {
      exitCode: 1,
      stdout: `${JSON.stringify(summary)}\n`,
      stderr:
        committed.outcome === "committed-elsewhere"
          ? "The destination directory was moved while the secrets were written; they are not at the requested path. Nothing was rolled back.\n"
          : "The destination file was replaced right after the secrets were written; verify it. Nothing was rolled back.\n",
    };
  }
  return { exitCode: 0, stdout: `${JSON.stringify(summary)}\n` };
}

export default function plugin(bb: BbPluginApi) {
  const cli = defineCli({
    name: "secret",
    summary: "Securely request credentials and write them to a dotenv file.",
    description:
      "Values are typed by the user into a secure form; they never reach the agent, argv, or logs. The destination must be on the host's root-owned secrets allowlist.",
    commands: {
      request: cliCommand({
        summary: "Request one or more secrets in a secure user form.",
        description:
          "Batch every currently known variable into one request. Relative --write-env paths resolve from the CLI working directory and must be normalized. The project, path and names must match one entry of the host allowlist.",
        positionals: [
          {
            name: "name",
            description:
              "Environment variable to request (letters, digits, underscores; must not start with a digit); repeat for each variable",
            required: true,
            variadic: true,
          },
        ],
        options: {
          project: {
            type: "string",
            required: true,
            placeholder: "NAME",
            description: "Allowlisted project the credentials belong to",
          },
          "write-env": {
            type: "string",
            required: true,
            placeholder: "PATH",
            aliases: ["env-file", "dotenv", "write-env-file"],
            description:
              "Dotenv file the values are written to, with mode 0600 and existing assignments preserved",
          },
          purpose: {
            type: "string",
            placeholder: "TEXT",
            aliases: ["reason", "why"],
            description:
              "One line telling the user why these credentials are needed",
          },
          describe: {
            type: "string",
            repeatable: true,
            placeholder: "NAME=TEXT",
            aliases: ["description", "describe-variable"],
            description:
              "Short description of one requested variable, written as NAME=TEXT or as the two-token form NAME TEXT; repeat per variable",
          },
          json: {
            type: "boolean",
            description:
              "Report failures as a JSON envelope on stdout; the success line is always JSON",
          },
        },
        async run(input, ctx) {
          const parsed = parseRequest({
            names: input.positionals.name,
            project: input.options.project,
            purpose: input.options.purpose,
            describe: input.options.describe,
            writeEnv: input.options["write-env"],
          });
          try {
            return await runRequest(bb, parsed, ctx);
          } catch (error) {
            throw sanitizeError(error, "running the request");
          }
        },
      }),
    },
  });
  bb.cli.register({
    ...cli,
    run: (argv, ctx) => cli.run(foldDescribePairs(argv), ctx),
  });
}
