Schedule work once or on a repeat, and let bb run it while you do something else. An automation can start an agent thread with a prompt, or run a stored script on the bb server.

## What you get

- An Automations panel in the sidebar. Create, edit, pause, resume, and run automations there. Each automation shows its run history.
- Two schedule types. Use a cron expression with a timezone for repeating work. Use a date, or a delay such as `2h`, for one-shot work.
- Agent mode. Pick the provider, model, reasoning level, and permission mode. Start a new thread, re-prompt an existing thread, or create a new worktree for each run.
- Script mode. Store a bash, sh, node, or python3 script. Each run records stdout, stderr, and the exit code. A script that prints nothing is recorded as a silent tick.

## For agents

Agent automations may set `execution.checkCommand` (CLI: `--check-command`; remove with `--clear-check-command`). Before a scheduled tick, bb runs this shell command in the automation's directory. Exit 0 proceeds; other exits, timeout, or a spawn failure record a skipped run without starting or waking a thread. Manual **Run now** bypasses the check.

Checks currently require full access and an explicit absolute unmanaged path on the server host, without branch changes or a target thread. Remote hosts, reused environments, project defaults, Personal environments, and new managed worktrees are unsupported and rejected when saved. Stored unsupported configurations skip safely. Checks use the server process environment and a 60-second timeout to bound a lightweight readiness probe. History retains the exit code, elapsed run time, reason, and last 2 KB of stderr; stdout is discarded. Avoid printing secrets to stderr.

Agents get the `automations` skill and the `bb automation` command: `create`, `list`, `show`, `update`, `pause`, `resume`, `run`, `runs`, and `delete`. All commands accept `--json`. Threads that an automation starts cannot create automations.

Scripts run on the machine that hosts the bb server. New standard-project scripts use that host's project source when available; Personal and projects without one run in the plugin's shared script storage. Existing scripts run there until changed. A script can instead select an absolute server-host path, and its detail view shows the resolved directory. Agent runs use the providers you already have installed.
