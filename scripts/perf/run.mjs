import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  aggregateRuns,
  baselineSummaryOf,
  checkThresholds,
  emptyScenarios,
  incompleteMetrics,
  Recorder,
  renderTable,
  resolveThresholdsPath,
  selectScenarios,
} from "./lib.mjs";
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
const scenarios = selectScenarios({
  only: args.only,
  skipBrowser: args["skip-browser"],
  skipServer: args["skip-server"],
});
const wants = (name) => scenarios.has(name);
const browserScenarios = ["startup", "cmdk", "switch", "thread", "composer"];
const thresholdsPath = resolveThresholdsPath(
  args,
  join(dirname(fileURLToPath(import.meta.url)), "thresholds.json"),
);
const thresholds =
  thresholdsPath === undefined
    ? undefined
    : JSON.parse(readFileSync(thresholdsPath, "utf8"));
const baselineSummary =
  args.baseline === undefined
    ? undefined
    : baselineSummaryOf(
        JSON.parse(readFileSync(args.baseline, "utf8")),
        args.baseline,
      );
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
  const recorder = new Recorder();
  const record = {
    index,
    serverReadyMs: Math.round(server.readyMs),
    loadAtStart,
    samples: recorder.samples,
    expected: recorder.expected,
    failures: recorder.failures,
  };
  try {
    if (wants("server")) {
      await new Promise((done) => setTimeout(done, 4000));
      await serverScenario(server.baseUrl, meta, recorder);
    }
    if (browserScenarios.some(wants)) {
      const chrome = await launchChrome();
      try {
        await installProbe(chrome.session);
        const driver = new Driver(chrome.session, server.baseUrl);
        await driver.warmBrowser();
        if (!wants("startup")) await driver.loadApp();
        if (wants("startup")) {
          await startupScenario(driver, recorder, { navigate: "cold" });
        }
        if (wants("cmdk")) {
          await cmdkScenario(driver, recorder, { queries: meta.queries, reps });
          await driver.goHome();
        }
        if (wants("switch")) {
          await switchScenario(driver, recorder, { reps });
        }
        if (wants("thread")) {
          await threadOpenScenario(driver, recorder, { meta, reps });
        }
        if (wants("composer")) {
          await composerScenario(driver, recorder, { meta });
        }
        if (wants("startup")) {
          await startupScenario(driver, recorder, { navigate: "warm" });
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
  config: {
    runs,
    reps,
    seed: meta.counts,
    only: args.only ?? null,
    scenarios: [...scenarios],
  },
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

for (const name of emptyScenarios(summary, scenarios)) {
  process.stdout.write(`FAIL scenario ${name} produced no samples\n`);
  process.exitCode = 1;
}

for (const metric of incompleteMetrics(summary, scenarios)) {
  const reasons = metric.reasons.length === 0 ? "" : ` (${metric.reasons.join("; ")})`;
  process.stdout.write(
    `FAIL ${metric.name}: ${metric.n} of ${metric.expected} expected samples${reasons}\n`,
  );
  process.exitCode = 1;
}

if (thresholds !== undefined) {
  const { failures, skipped } = checkThresholds(summary, thresholds, baselineSummary, {
    scenarios,
  });
  if (skipped.length > 0) {
    process.stdout.write(
      `thresholds: skipped ${skipped.length} metric(s) from scenarios not run\n`,
    );
  }
  for (const failure of failures) {
    if (failure.kind === "incomplete") continue;
    process.stdout.write(`FAIL ${failure.name}: ${failure.message}\n`);
  }
  if (failures.length > 0) process.exitCode = 1;
}
