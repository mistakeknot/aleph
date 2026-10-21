# Aleph patch ledger

This ledger lists every difference between upstream bb 0.46.1 (desktop-v0.46.1, 411eac54) and Aleph at 96afe7f6, and says how each is held. It is the checklist for an upstream sync and the source of its conflict resolutions.

Each row is a patch: where it lives, why, and the resolution to use when a sync conflicts. The path-level mapping is in `aleph-patch-ledger-paths.tsv` (one line per differing path, with the patch id; the single exception is `scripts/ci-*-release-check.sh`, a deliberate redacted alias for the tracked release-check script, whose real file name carries an internal host name that the public-repo hygiene rule keeps out of tracked text). The classification is by path rule and commit history, so a path can belong to a neighbouring patch when two patches share a file. A path that fits no row is listed under `unattributed` and blocks a sync until it is classified.

Held as: *plugin* means the change lives in a plugin directory; *in-tree* means it edits upstream files and is what conflicts in a sync.

| Patch | Held as | Files | Why | Conflict resolution |
|---|---|---|---|---|
| account-pooler | plugin + in-tree | 36 | Account Pooler 0.1.2/0.6.3: owning-machine thread availability, `bb pool exec`, attempt receipts, stall tolerance, highest-priority-account fresh conversations (mk-6v3o6) | Keep the Aleph side of the fresh-conversation account choice (07c1ec9e). Contract: plugins/account-pool/RECEIPTS.md. |
| app-header-status | in-tree | 2 | Header status strip for the Account Pooler | Re-apply; upstream has no equivalent slot use. |
| thread-list-icons | plugin + in-tree | 24 | Provider icons and hull designation rows in the thread list (mk-omogp.7) | Plugin files carry the change. |
| split-panes | in-tree | 19 | Optional composer focus on pane switch; Cmd/Ctrl-W closes the focused pane (mk-3tlt) | Re-apply the Aleph side of pane navigation. |
| model-picker | in-tree | 2 | Switch a thread's provider in place | Re-apply. |
| diagnostics-log | in-tree | 19 | Renderer diagnostics log and composer-stuck guards (mk-h1q8) | The desktop logging bridge is gated on BB_DESKTOP_RELEASE_CHANNEL=aleph; the pending-interaction guards are not gated. Re-apply the emitter calls and the guards. |
| composer-gate | in-tree | 11 | Composer pending-interaction gate | Keep Aleph's gate over upstream's composer edits (07c1ec9e). |
| history-keybindings | in-tree | 34 | History back/forward keybindings (Cmd-[ and Cmd-]) and Go menu | Keep Aleph's bindings and menu entries (07c1ec9e). |
| thread-open-follow | in-tree | 2 | Background thread open without stealing focus | Keep Aleph's handling (07c1ec9e). |
| themes | in-tree | 37 | Thecla and Dorcas themes, Dorcas music mode, ambient screen care (mk-dqrwh.2) | Re-apply theme tokens; check against upstream theme changes. |
| agent-priority | in-tree | 16 | Agent worker priority (BB_AGENT_NICE) and own systemd scope | Re-apply daemon and bridge hooks. |
| provider-bridge-changes | in-tree | 42 | Provider bridge changes: promptCacheTtl, A2 cache-write split, agent scopes, rerecorded fixtures | Rerecord provider-parity fixtures after any upstream bridge change. |
| provider-usage | plugin + in-tree | 8 | Provider usage: every provider at once, burn rate on hover | Re-apply. |
| tasks-plugin | plugin + in-tree | 7 | Tasks plugin detail column and links | Re-apply. |
| plugin-surface | in-tree | 65 | Plugin SDK and server surface additions (search slot, appHeaderStatus, docs) | Re-apply; run plugin-api-docs surface tests. |
| thread-search-learned | in-tree | 2 | Learned thread search selections | Re-apply. |
| queue-transfer | in-tree | 134 | Queue retirement, transfer ledger and the G2-G6 capability fences (mk-ilhx, mk-be5r, mk-ni8m, mk-ct0k) | Retain Aleph's queued-message migration at 0151; upstream's 0143_queued_message_state is dropped. |
| timeline-build-bound | in-tree | 5 | Bounded open-turn latest timeline builds | Re-apply. |
| thread-cli | in-tree | 14 | CLI changes for thread wait and send time | Re-apply. |
| layer-groups | plugin + in-tree | 24 | Sidebar pace-layer groups plugin and conditional pin writes (mk-ks92z) | Plugin files carry the change. |
| credential-redaction | in-tree | 31 | Credential redaction layers (mk-3aoo); see docs/credential-redaction-residuals.md | Re-apply; vendored token patterns keep the MIT notice. |
| no-upstream-updates | in-tree | 38 | Server and desktop skip upstream update checks on Aleph builds | Keep the update guards (07c1ec9e). |
| signed-update-channel | in-tree | 62 | Signed update channel: manifest, floor, instance, install request and settings row | Restore the signed update contracts after a sync (fb8d2a5bdc). |
| version-scheme | in-tree | 6 | Version `<upstream>+aleph.X.Y.Z` and lockstep check | Set after the merge by the version step. |
| branding | in-tree | 8 | Desktop branding: Aleph strings, copyright, icons | Keep Aleph's desktop branding (07c1ec9e). |
| desktop-bridge | in-tree | 1 | Browser page preload test for editable-focus reporting in nested frames (mk-jwb7); the bridge EPIPE and shutdown handling is `apps/desktop/src/bridge-parent-watch.ts`, held under no-upstream-updates | Re-apply. |
| editable-focus | in-tree | 2 | Editable focus guard | Re-apply. |
| fonts | in-tree | 2 | Ioskeley Mono font route tests | Re-apply. |
| release-qualification | in-tree | 2 | Release qualification script and CI recipes | Re-apply. |
| fork-owned-migrations | in-tree | 55 | Aleph migrations and the renumbering of upstream migrations: upstream 0132-0137 are 0135-0140 here, upstream 0138-0142 are 0146-0150 here, upstream 0143_queued_message_state is replaced by 0151_queued_message_state. Aleph owns 0132-0134 and 0141-0145 | Rename each upstream migration to its Aleph number. Migration `when` timestamps must stay ordered or the boot check throws (FORK.md). A sync that adds a migration is an ESCALATE item. |
| fork-docs | in-tree | 34 | Fork documents, hygiene allowlist and changelog | Keep Aleph's text. |
| build-config | in-tree | 10 | Build, lint and test configuration edits | Re-apply. |
| web-site | in-tree | 7 | Marketing site and blog edits | Re-apply. |
| mobile | in-tree | 5 | Mobile app edits | Re-apply. |
| app-shell-ui | in-tree | 12 | App shell, pickers, dialogs and sidebar edits | Re-apply. |
| upstream-backport | in-tree | 1 | Backport of an upstream main change not yet in a release | Drops out when the release carries it. |

Totals: 779 differing paths. 2 are deletions (`.github/workflows/deploy-ai-gateway.yml`, an imported workflow Aleph does not run, and `0143_queued_message_state.sql`, deleted in favour of the renumbered 0151 migration); the rest are additions, edits and renames.

## Using the ledger

- Merge the upstream tag. For each conflict, find the path in the paths file, read the patch row, and re-apply the Aleph side.
- A conflict in a path whose patch is *keep* (composer-gate, history-keybindings, thread-open-follow, no-upstream-updates, branding) takes Aleph's version unless upstream changed the surface the patch depends on; then escalate.
- Record each real resolution with `git rerere` so the next sync replays it. Resolutions are reviewed before they are shared.
- Regenerate the paths file after every sync and check that `unattributed` is empty.
