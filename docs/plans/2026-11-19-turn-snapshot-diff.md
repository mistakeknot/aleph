# Bounded interval snapshot prototype

Source: the approved capture-engine prototype brief. This plan implements
comparison only. Restore, rewind, provider-native diffs and UI are excluded.
The server flag stays off by default.

The server takes a baseline before a new provider command can execute,
binds that baseline to the root turn, and takes the second snapshot before
completion follow-ups dispatch another turn. A serialized pending capture
prevents overlapping requests from taking competing baselines. Missing
boundaries and server restarts must report unavailable data rather than
claim a complete interval.

The server admits only an exclusively assigned worktree with matching
provider-created ownership and an owned-branch resource. The Git host plugin
verifies the actual linked worktree, its source repository and branch.
Git operations use a private temporary index, optional locks off, hooks off,
external filters off and automatic maintenance off. They never check out
files, stage into the real index or change HEAD or the branch tip.

Design choices: 20,000 files, 64 MiB and two seconds per snapshot; 2 MiB per
patch; ten snapshot-ref pairs per thread; at most 32 in-memory interval
records globally. Delete older private refs before publishing a new pair.
Leave object reclamation to normal maintenance. A cap or capture failure
returns incomplete with a reason and empty diff data. An unowned target
returns not-captured.

The authenticated HTTP read uses the existing thread route style and returns
status, reason, label, name-status entries and patch. Reads invoke no Git.
The label describes interval changes without attributing them to the agent.
The prototype does not add a dedicated SDK method, CLI command or UI.

Verification uses synthetic scratch worktrees: edits, new untracked files,
deletions, renames, binaries and existing staged/unstaged splits. Compare
status, cached diff, HEAD, branch tip and index bytes around captures.
Exercise file/byte/time/patch caps, hooks and filters, ref retention, ownership
changes, disabled capture, pending-command serialization and the HTTP read.
Keep existing assertions unchanged. Run affected typechecks, Git and contract
package tests and targeted server tests; defer the complete server suite.

One independent code review covers the complete PR diff. Freeze a passing
head before requesting the coordinator's verification slot. No provider
session or deployed flag activation is needed for this implementation.
