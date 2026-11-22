import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { evaluateChanges, parseTurbo } from "./plan-ci.mjs";

export function selectRefs(base, head) {
  try {
    if (!base || !head || base.startsWith("-") || head.startsWith("-"))
      throw new Error("Two refs required");
    const options = {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 32 * 1024 * 1024,
    };
    const git = (...args) => execFileSync("git", args, options);
    const baseSha = git("rev-parse", "--verify", `${base}^{commit}`).trim();
    const headSha = git("rev-parse", "--verify", `${head}^{commit}`).trim();
    const paths = git(
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      baseSha,
      headSha,
      "--",
    )
      .split("\0")
      .filter(Boolean);
    const turbo = parseTurbo(git("show", `${headSha}:turbo.json`));
    const result = JSON.parse(
      execFileSync(
        "pnpm",
        [
          "exec",
          "turbo",
          "query",
          "affected",
          "--base",
          baseSha,
          "--head",
          headSha,
        ],
        options,
      ),
    );
    const tasks = evaluateChanges(paths, result, turbo);
    if (tasks === "full")
      throw new Error("Unmappable path or shared test input");
    const packages = [
      ...new Set(
        tasks
          .filter((task) => task.name === "test")
          .map((task) => task.package),
      ),
    ].sort();
    if (!packages.length || packages.includes("//"))
      throw new Error("No package test targets");
    return [
      [
        "pnpm",
        "exec",
        "turbo",
        "run",
        "test",
        ...packages.map((name) => `--filter=${name}`),
      ],
    ];
  } catch (error) {
    console.error(
      `Change selection unavailable; running full suite: ${error.message}`,
    );
    return "full";
  }
}

export function executionPlan(selected, env = process.env) {
  if (env.CI_SOURCE_SHA || env.CI_RUN_PURPOSE === "qualification")
    return {
      selection: "full",
      qualificationEligible: true,
      commands: [["pnpm", "test"]],
    };
  return {
    selection: selected === "full" ? "full" : "affected",
    qualificationEligible: selected === "full",
    commands: selected === "full" ? [["pnpm", "test"]] : selected,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const run = args[0] === "--run";
  const [base, head] = run ? args.slice(1) : args;
  let selected = selectRefs(base, head);
  if (
    run &&
    selected !== "full" &&
    head &&
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !==
      execFileSync("git", ["rev-parse", head], { encoding: "utf8" }).trim()
  )
    selected = "full";
  const plan = executionPlan(selected);
  console.error(
    `selection=${plan.selection} qualificationEligible=${plan.qualificationEligible}`,
  );
  if (!run)
    console.log(
      JSON.stringify(plan.selection === "full" ? "full" : plan.commands),
    );
  else
    for (const [command, ...argv] of plan.commands) {
      const result = spawnSync(command, argv, { stdio: "inherit" });
      if (result.error || result.status !== 0) process.exit(result.status ?? 1);
    }
}
