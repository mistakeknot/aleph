import { writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { readRegistry, type RegistryReadResult } from "./registry";
import { openStore } from "./store";
import {
  adoptSection,
  applyProvision,
  planProvision,
  recoverAdoptions,
  type ProvisionReport,
  type SectionsPort,
} from "./provision";

const contract = defineRpcContract({
  listOwnedSections: {
    input: z.object({}).strict(),
    output: z
      .object({
        stale: z.boolean(),
        sections: z.array(
          z
            .object({
              sectionId: z.string(),
              layer: z.string(),
              letter: z.string(),
              layerName: z.string(),
              sectionName: z.string(),
              accent: z.string(),
              rank: z.number().nullable(),
              order: z.number(),
            })
            .strict(),
        ),
      })
      .strict(),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    mode: {
      type: "select",
      label: "Mode",
      options: ["preview", "apply"],
      default: "preview",
    },
    registryPath: { type: "string", label: "Registry path", default: "" },
  });
  const db = bb.storage.database();
  const store = openStore(db, bb.storage.migrate);
  const signal = { aborted: false };
  let tail: Promise<void> = Promise.resolve();
  let inFlight: Promise<ProvisionReport | undefined> | null = null;
  let lastRead: RegistryReadResult | { kind: "unconfigured" } = {
    kind: "unconfigured",
  };
  function enqueue<T>(fn: () => Promise<T> | T): Promise<T | undefined> {
    const operation = tail.then(() => (signal.aborted ? undefined : fn()));
    tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  const assertRunning = () => {
    if (signal.aborted) throw new Error("Layer groups is disposing");
  };
  const port: SectionsPort = {
    list: () => {
      assertRunning();
      return bb.sdk.threadSections.list();
    },
    create: (name) => {
      assertRunning();
      return bb.sdk.threadSections.create({ name });
    },
    async hasThreads(sectionId) {
      assertRunning();
      return (
        (
          await bb.sdk.threads.list({
            sectionId,
            includeHidden: true,
            limit: 1,
          })
        ).length > 0
      );
    },
  };
  bb.onDispose(async () => {
    signal.aborted = true;
    await tail;
  });
  async function readSnapshot(path: string) {
    if (!path) {
      lastRead = { kind: "unconfigured" };
      return lastRead;
    }
    const result = await readRegistry({
      path,
      lastGood: store.lastSnapshot(),
      now: Date.now(),
    });
    if (signal.aborted) return result;
    lastRead = result;
    if (result.kind === "fresh") store.saveSnapshot(result.snapshot);
    return result;
  }
  async function provision(): Promise<ProvisionReport | undefined> {
    const values = await settings.get();
    if (signal.aborted) return;
    const mode = z.enum(["preview", "apply"]).parse(values.mode);
    const result = await readSnapshot(values.registryPath);
    if (signal.aborted) return;
    const report: ProvisionReport = {
      mode,
      applied: false,
      actions: [],
      errors: [],
    };
    if (result.kind === "unconfigured") return report;
    await recoverAdoptions({ store, port, now: Date.now() });
    if (signal.aborted) return;
    if (result.kind === "unavailable" || result.kind === "stale") {
      report.errors.push(result.error);
      if (result.kind === "unavailable" || mode === "apply") {
        store.recordRun({ kind: "provision", mode, at: Date.now(), report });
        return report;
      }
    }
    if (!("snapshot" in result)) return report;
    const actions = await planProvision({
      snapshot: result.snapshot,
      rows: store.layerSections(),
      port,
    });
    if (signal.aborted) return;
    if (result.kind === "stale") {
      report.actions = actions;
      store.recordRun({ kind: "provision", mode, at: Date.now(), report });
      return report;
    }
    return applyProvision({
      mode,
      actions,
      store,
      port,
      now: Date.now(),
      signal,
    });
  }
  function run() {
    if (signal.aborted) return Promise.resolve(undefined);
    if (inFlight) return inFlight;
    const operation = enqueue(provision);
    inFlight = operation;
    void operation.then(
      () => {
        inFlight = null;
      },
      () => {
        inFlight = null;
      },
    );
    return operation;
  }
  const json = (value: unknown, exitCode = 0) => ({
    exitCode,
    stdout: `${JSON.stringify(value, null, 2)}\n`,
  });
  const letter = [
    {
      name: "letter",
      description: "Layer letter (GSV selects Studio)",
      required: true,
    },
  ] as const;
  bb.cli.register(
    defineCli({
      name: "layer-groups",
      summary: "Preview and provision pace-layer sections",
      commands: {
        status: cliCommand({
          summary: "Show registry identity, age and last run",
          async run() {
            return json(
              await enqueue(async () => {
                const values = await settings.get();
                if (signal.aborted) return;
                const result = await readSnapshot(values.registryPath);
                if (signal.aborted) return;
                const snapshot =
                  "snapshot" in result ? result.snapshot : store.lastSnapshot();
                return {
                  kind: result.kind,
                  commit: snapshot?.commit ?? null,
                  sha256: snapshot?.sha256 ?? null,
                  ageMs: snapshot ? Date.now() - snapshot.readAt : null,
                  lastRun: store.lastRun(),
                };
              }),
            );
          },
        }),
        provision: cliCommand({
          summary: "Run provision now",
          async run() {
            return json(await run());
          },
        }),
        "enable-layer": cliCommand({
          summary: "Reenable a deleted layer for the next run",
          positionals: letter,
          async run(input) {
            return json(
              await enqueue(() => ({
                enabled: store.reenableLayer(
                  input.positionals.letter === "GSV"
                    ? "STUDIO"
                    : input.positionals.letter!,
                  Date.now(),
                ),
              })),
            );
          },
        }),
        adopt: cliCommand({
          summary: "Adopt an empty matching section",
          positionals: letter,
          async run(input) {
            const result = await enqueue(async () => {
              const values = await settings.get();
              if (signal.aborted) return;
              const registry = await readSnapshot(values.registryPath);
              if (signal.aborted) return;
              if (registry.kind !== "fresh" && registry.kind !== "unchanged")
                return { kind: registry.kind };
              await recoverAdoptions({ store, port, now: Date.now() });
              if (signal.aborted) return;
              const key =
                input.positionals.letter === "GSV"
                  ? "STUDIO"
                  : input.positionals.letter;
              const layer = registry.snapshot.layers.find(
                (item) => item.key === key,
              );
              if (!layer) return { kind: "not-found", layer: key };
              return adoptSection({ layer, store, port, now: Date.now() });
            });
            return json(result, result?.kind === "adopted" ? 0 : 1);
          },
        }),
        export: cliCommand({
          summary: "Write all plugin data as JSON",
          positionals: [
            {
              name: "path",
              description: "Absolute path to the destination JSON file",
              required: true,
            },
          ],
          async run(input) {
            if (!isAbsolute(input.positionals.path!)) {
              return json({ error: "Export requires an absolute path" }, 1);
            }
            await enqueue(async () => {
              await writeFile(
                input.positionals.path!,
                `${JSON.stringify(store.exportAll(), null, 2)}\n`,
              );
            });
            return json({ path: input.positionals.path });
          },
        }),
      },
    }),
  );
  bb.rpc.register(contract, {
    async listOwnedSections() {
      const snapshot = store.lastSnapshot();
      const sections = await port.list();
      const live = new Map(
        sections.map((section) => [section.id, section.name]),
      );
      const active = new Map(
        store
          .layerSections()
          .filter((row) => row.state === "active")
          .map((row) => [row.layer, row]),
      );
      return {
        stale:
          (lastRead.kind === "stale" || lastRead.kind === "unavailable") &&
          snapshot !== null,
        sections: (snapshot?.layers ?? [])
          .slice()
          .sort((a, b) => a.order - b.order)
          .flatMap((layer) => {
            const row = active.get(layer.key);
            const sectionName = row ? live.get(row.sectionId) : undefined;
            return row && sectionName !== undefined
              ? [
                  {
                    sectionId: row.sectionId,
                    layer: layer.key,
                    letter: layer.letter,
                    layerName: layer.name,
                    sectionName,
                    accent: layer.accent,
                    rank: layer.rank,
                    order: layer.order,
                  },
                ]
              : [];
          }),
      };
    },
  });
  bb.background.schedule("provision", "*/15 * * * *", async () => {
    await run();
  });
  let startupRecovered = false;
  bb.background.service("startup-recovery", {
    async start(serviceSignal) {
      if (serviceSignal.aborted || signal.aborted) return;
      try {
        await enqueue(async () => {
          if (startupRecovered || serviceSignal.aborted) return;
          await recoverAdoptions({ store, port, now: Date.now() });
          startupRecovered = true;
        });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
      if (serviceSignal.aborted || signal.aborted) return;
      await new Promise<void>((resolve) => {
        serviceSignal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
    },
  });
}
