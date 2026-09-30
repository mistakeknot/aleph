import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { launchChrome } from "./cdp.mjs";
import {
  cloneSeed,
  ensureSeed,
  gitInfo,
  machineInfo,
  perfHome,
  perfTmp,
  startServer,
} from "./env.mjs";
import { aggregateRuns, checkThresholds, renderTable } from "./lib.mjs";
import {
  cmdkScenario,
  Driver,
  composerScenario,
  installProbe,
  serverScenario,
  startupScenario,
  switchScenario,
  threadOpenScenario,
} from "./scenarios.mjs";

const { values: args } = parseArgs({
  options: {
    runs: { type: "string", default: "5" },
    reps: { type: "string", default: "5" },
    label: { type: "string", default: "baseline" },
    out: { type: "string" },
    "rebuild-seed": { type: "boolean", default: false },
    "skip-browser": { type: "boolean", default: false },
    "skip-server": { type: "boolean", default: false },
    baseline: { type: "string" },
    thresholds: { type: "string" },
    only: { type: "string" },
  },
});

const runs = Number(args.runs);
const reps = Number(args.reps);
const only = args.only === undefined ? null : new Set(args.only.split(","));
const wants = (name) => only === null || only.has(name);
const outDir = resolve(args.out ?? join(perfHome(), "results"));
mkdirSync(outDir, { recursive: true });

const { seedDir, meta } = await ensureSeed({ rebuild: args["rebuild-seed"] });
const runRecords = [];

for (let index = 0; index < runs; index += 1) {
  process.stderr.write(`perf: run ${index + 1}/${runs}\n`);
  const dataDir = cloneSeed(seedDir, `run${index}`);
  const loadAtStart = machineInfo().loadAvg[0];
  const tmpDir = join(perfTmp(), `run${index}-${process.pid}`);
  mkdirSync(tmpDir, { recursive: true });
  const server = await startServer({ dataDir, tmpDir, label: `run${index}` });
  const samples = {};
  const record = {
    index,
    serverReadyMs: Math.round(server.readyMs),
    loadAtStart,
    samples,
  };
  try {
    if (!args["skip-server"] && wants("server")) {
      await new Promise((done) => setTimeout(done, 4000));
      Object.assign(samples, await serverScenario(server.baseUrl, meta));
    }
    if (!args["skip-browser"]) {
      const chrome = await launchChrome();
      try {
        await installProbe(chrome.session);
        const driver = new Driver(chrome.session, server.baseUrl);
        await driver.warmBrowser();
        if (wants("startup")) {
          await startupScenario(driver, samples, { navigate: "cold" });
        }
        if (wants("cmdk")) {
          await cmdkScenario(driver, samples, { queries: meta.queries, reps });
          await driver.goHome();
        }
        if (wants("switch")) {
          await switchScenario(driver, samples, { reps });
        }
        if (wants("thread")) {
          await threadOpenScenario(driver, samples, { meta, reps });
        }
        if (wants("composer")) {
          await composerScenario(driver, samples, { meta });
        }
        if (wants("startup")) {
          await startupScenario(driver, samples, { navigate: "warm" });
        }
      } finally {
        await chrome.close();
      }
    }
    record.loadAtEnd = machineInfo().loadAvg[0];
  } finally {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  }
  runRecords.push(record);
}

const summary = aggregateRuns(runRecords);
const machine = machineInfo();
const git = gitInfo();
const result = {
  schema: "bb-perf-v1",
  label: args.label,
  startedAt: new Date().toISOString(),
  machine,
  git,
  config: { runs, reps, seed: meta.counts, only: args.only ?? null },
  runs: runRecords,
  summary,
};
const stamp = result.startedAt.replace(/[:.]/gu, "-");
const outFile = join(outDir, `perf-${args.label}-${stamp}.json`);
writeFileSync(outFile, JSON.stringify(result, null, 2));

const machineLine = `${machine.cpu} x${machine.logicalCores}, ${machine.memGb}GB, ${machine.os}, node ${machine.node}, ${machine.chrome}; load avg at end ${machine.loadAvg.join("/")}; commit ${git.commit}${git.dirty ? "+dirty" : ""}`;
process.stdout.write(
  `${renderTable(summary, { title: `bb perf "${args.label}" (${runs} runs x ${reps} reps)`, machine: machineLine })}\n`,
);
process.stdout.write(`\nresult: ${outFile}\n`);

if (args.thresholds !== undefined) {
  const thresholds = JSON.parse(readFileSync(args.thresholds, "utf8"));
  const baseline =
    args.baseline === undefined
      ? undefined
      : JSON.parse(readFileSync(args.baseline, "utf8")).summary;
  const { failures } = checkThresholds(summary, thresholds, baseline);
  for (const failure of failures) {
    process.stdout.write(`FAIL ${failure.name}: ${failure.message}\n`);
  }
  if (failures.length > 0) process.exitCode = 1;
}
