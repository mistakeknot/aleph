import type {
  InstalledPlugin,
  PluginInstallJob,
  PluginInstallJobTarget,
  PluginInstallServerIdentity,
  pluginInstallContainmentInspectionSchema,
} from "@bb/server-contract";
import type { z } from "zod";
import { createJobRegistry } from "../lib/job-registry.js";
import { runCancellableInstall } from "./install-cancellation.js";
import {
  containmentIdFor,
  inspectInstallContainment,
  installServerIdentity,
  originalInstallServerExited,
  runContainedInstall,
} from "./install-containment.js";

export interface PluginInstallJobs {
  start(args: {
    requestKey?: string;
    target: PluginInstallJobTarget;
    displayName: string;
    run: () => Promise<InstalledPlugin>;
  }): PluginInstallJob;
  settled(id: string): Promise<PluginInstallJob> | undefined;
  get(id: string): PluginInstallJob | undefined;
  list(): PluginInstallJob[];
  cancel(id: string): PluginInstallJob | undefined;
  inspectContainment(
    requestKey: string,
    server?: PluginInstallServerIdentity,
  ): Promise<z.infer<typeof pluginInstallContainmentInspectionSchema>>;
}

function targetKey(target: PluginInstallJobTarget): string {
  return target.kind === "catalog"
    ? `catalog:${target.marketplace}/${target.entryId}`
    : `source:${target.source}:${JSON.stringify(target.selection)}`;
}

function jobBase({ id, target, displayName, containment }: PluginInstallJob) {
  return {
    id,
    target,
    displayName,
    ...(containment === undefined ? {} : { containment }),
  };
}

export function createPluginInstallJobs(deps: {
  notifyChanged: () => void;
  now?: () => number;
}): PluginInstallJobs {
  const jobs = createJobRegistry<PluginInstallJob>({
    isActive: (job) =>
      job.state === "queued" ||
      job.state === "running" ||
      job.state === "cancelling",
    fail: (job, error, signal) =>
      signal.aborted
        ? { ...jobBase(job), state: "cancelled" }
        : {
            ...jobBase(job),
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
          },
    notifyChanged: deps.notifyChanged,
    now: deps.now,
  });
  return {
    start: ({ target, displayName, run, requestKey }) => {
      if (requestKey !== undefined) {
        const existing = jobs
          .list()
          .find((job) => job.containment?.requestKey === requestKey);
        if (existing !== undefined) {
          if (targetKey(existing.target) !== targetKey(target))
            throw new Error(
              "install request key already belongs to another target",
            );
          return existing;
        }
      }
      const containment =
        requestKey === undefined
          ? undefined
          : {
              id: containmentIdFor(requestKey),
              requestKey,
              server: installServerIdentity(),
            };
      return jobs.start({
        key:
          containment === undefined
            ? targetKey(target)
            : `contained:${containment.id}:${targetKey(target)}`,
        lane: "plugin-install",
        create: (id) => ({
          id,
          target,
          displayName,
          state: "queued",
          ...(containment === undefined ? {} : { containment }),
        }),
        run: async ({ job, set, signal }) => {
          set({ ...jobBase(job), state: "running" });
          const execute = () => runCancellableInstall(signal, run);
          const plugin =
            containment === undefined
              ? await execute()
              : await runContainedInstall(containment, execute, () =>
                  set({
                    ...jobBase(job),
                    state: "running",
                    detail: "draining",
                  }),
                );
          return { ...jobBase(job), state: "succeeded", plugin };
        },
      });
    },
    async inspectContainment(requestKey, server) {
      const state = await inspectInstallContainment(requestKey);
      const known = jobs
        .list()
        .find((job) => job.containment?.requestKey === requestKey);
      const identity = known?.containment?.server ?? server;
      const originalServerExited =
        identity === undefined ? null : originalInstallServerExited(identity);
      const terminal =
        known !== undefined &&
        ["succeeded", "failed", "cancelled"].includes(known.state);
      return {
        id: containmentIdFor(requestKey),
        state,
        originalServerExited,
        canRelease:
          (state === "empty" || state === "gone") &&
          (terminal || (known === undefined && originalServerExited === true)),
      };
    },
    settled: (id) => jobs.settled(id)?.then((outcome) => outcome.job),
    get: (id) => jobs.get(id),
    list: () => jobs.list(),
    cancel: (id) =>
      jobs.cancel(id, {
        queued: (job) => ({ ...jobBase(job), state: "cancelled" }),
        running: (job) =>
          job.state === "running" ? { ...job, state: "cancelling" } : job,
      }),
  };
}
