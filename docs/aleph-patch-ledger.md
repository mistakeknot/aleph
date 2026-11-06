# Aleph patch ledger

This ledger lists every difference between upstream bb bcefd50bf2 (the commit recorded in UPSTREAM_BASE) and Aleph, and says how each is held. It is the checklist for an upstream sync and the source of its conflict resolutions.

Each row is a patch: where it lives, why, and the resolution to use when a sync conflicts. The path-level mapping is in `aleph-patch-ledger-paths.tsv` (one line per differing path, with the patch id; the single exception is `scripts/ci-*-release-check.sh`, a deliberate redacted alias for the tracked release-check script, whose real file name carries an internal host name that the public-repo hygiene rule keeps out of tracked text). The classification is by path rule and commit history, so a path can belong to a neighbouring patch when two patches share a file. A path that fits no row is listed under `unattributed` and blocks a sync until it is classified.

Held as: *plugin* means the change lives in a plugin directory; *in-tree* means it edits upstream files and is what conflicts in a sync.

| Patch | Held as | Files | Why | Conflict resolution |
|---|---|---|---|---|
| account-pooler | plugin + in-tree | 41 | Account Pooler 0.1.2/0.6.3: owning-machine thread availability, `bb pool exec`, attempt receipts, stall tolerance, highest-priority-account fresh conversations (mk-6v3o6) | Keep the Aleph side of the fresh-conversation account choice (07c1ec9e). Contract: plugins/account-pool/RECEIPTS.md. |
| app-header-status | in-tree | 2 | Header status strip for the Account Pooler | Re-apply; upstream has no equivalent slot use. |
| thread-list-icons | plugin + in-tree | 25 | Provider icons and hull designation rows in the thread list (mk-omogp.7) | Plugin files carry the change. |
| split-panes | in-tree | 17 | Optional composer focus on pane switch; Cmd/Ctrl-W closes the focused pane (mk-3tlt) | Re-apply the Aleph side of pane navigation. |
| model-picker | in-tree | 2 | Switch a thread's provider in place | Re-apply. |
| diagnostics-log | in-tree | 19 | Renderer diagnostics log and composer-stuck guards (mk-h1q8) | The desktop logging bridge is gated on BB_DESKTOP_RELEASE_CHANNEL=aleph; the pending-interaction guards are not gated. Re-apply the emitter calls and the guards. |
| composer-gate | in-tree | 8 | Composer pending-interaction gate | Keep Aleph's gate over upstream's composer edits (07c1ec9e). |
| history-keybindings | in-tree | 40 | Aleph-only additions around the upstream back/forward shortcuts (`Mod+[` / `Mod+]`): the Go menu entries, the page-first `browser.back` / `browser.forward` commands in the in-app browser panel, and editable-target detection for them (mk-fruz9). `history.back` / `history.forward` and `HistoryCommandHandlers` are upstream's, not patched | Take upstream's `history.*` bindings and handlers; re-apply only the Go menu, `browser.back` / `browser.forward` and `isEditableCommandTarget`. Not a keep patch. |
| thread-open-follow | in-tree | 2 | Background thread open without stealing focus | Keep Aleph's handling (07c1ec9e). |
| themes | in-tree | 37 | Thecla and Dorcas themes, Dorcas music mode, ambient screen care (mk-dqrwh.2) | Re-apply theme tokens; check against upstream theme changes. |
| agent-priority | in-tree | 15 | Agent worker priority (BB_AGENT_NICE) and own systemd scope | Re-apply daemon and bridge hooks. |
| provider-bridge-changes | in-tree | 42 | Provider bridge changes: promptCacheTtl, A2 cache-write split, agent scopes, rerecorded fixtures | Rerecord provider-parity fixtures after any upstream bridge change. |
| provider-usage | plugin + in-tree | 8 | Provider usage: every provider at once, burn rate on hover | Re-apply. |
| tasks-plugin | plugin + in-tree | 8 | Tasks plugin detail column and links | Re-apply. |
| plugin-surface | in-tree | 60 | Plugin SDK and server surface additions (search slot, appHeaderStatus, docs) | Re-apply; run plugin-api-docs surface tests. |
| thread-search-learned | in-tree | 2 | Learned thread search selections | Re-apply. |
| queue-transfer | in-tree | 132 | Queue retirement, transfer ledger and the G2-G6 capability fences (mk-ilhx, mk-be5r, mk-ni8m, mk-ct0k) | Retain Aleph's queued-message migration at 0151; upstream's 0143_queued_message_state is dropped. |
| timeline-build-bound | in-tree | 11 | Bounded open-turn latest timeline builds | Re-apply. |
| thread-cli | in-tree | 14 | CLI changes for thread wait and send time | Re-apply. |
| layer-groups | plugin + in-tree | 20 | Sidebar pace-layer groups plugin and conditional pin writes (mk-ks92z) | Plugin files carry the change. |
| design-wiki | plugin + in-tree | 51 | Design Wiki plugin: read-only project Wiki page for docs/wiki/src CUJs and requirements (mk-vz3gw.1) | Plugin files carry the change; re-apply the registration lines. |
| contributor-gate | in-tree | 1 | Aleph's PR gate admits only contributors Aleph approved; upstream's additions to `.github/APPROVED_CONTRIBUTORS` are not taken on a sync, since the gate reads that list from Aleph's base branch (mk-8lcd6) | Keep Aleph's list; drop upstream's added logins. |
| credential-redaction | in-tree | 30 | Credential redaction layers (mk-3aoo); see docs/credential-redaction-residuals.md | Re-apply; vendored token patterns keep the MIT notice. |
| no-upstream-updates | in-tree | 35 | Server and desktop skip upstream update checks on Aleph builds | Keep the update guards (07c1ec9e). |
| signed-update-channel | in-tree | 62 | Signed update channel: manifest, floor, instance, install request and settings row | Restore the signed update contracts after a sync (fb8d2a5bdc). |
| version-scheme | in-tree | 6 | Version `<upstream>+aleph.X.Y.Z` and lockstep check | Set after the merge by the version step. |
| branding | in-tree | 8 | Desktop branding: Aleph strings, copyright, icons | Keep Aleph's desktop branding (07c1ec9e). |
| desktop-bridge | in-tree | 1 | Browser page preload test for editable-focus reporting in nested frames (mk-jwb7); the bridge EPIPE and shutdown handling is `apps/desktop/src/bridge-parent-watch.ts`, held under no-upstream-updates | Re-apply. |
| editable-focus | in-tree | 2 | Editable focus guard | Re-apply. |
| fonts | in-tree | 2 | Ioskeley Mono font route tests | Re-apply. |
| release-qualification | in-tree | 2 | Release qualification script and CI recipes | Re-apply. |
| fork-owned-migrations | in-tree | 77 | Aleph migrations and the renumbering of upstream migrations: upstream 0132-0137 are 0135-0140 here, upstream 0138-0142 are 0146-0150 here, upstream 0143_queued_message_state is replaced by 0151_queued_message_state. Aleph owns 0132-0134 and 0141-0145 | Rename each upstream migration to its Aleph number. Migration `when` timestamps must stay ordered or the boot check throws (FORK.md). A sync that adds a migration is an ESCALATE item. |
| fork-docs | in-tree | 38 | Fork documents, hygiene allowlist and changelog | Keep Aleph's text. |
| build-config | in-tree | 17 | Build, lint and test configuration edits | Re-apply. |
| web-site | in-tree | 7 | Marketing site and blog edits | Re-apply. |
| mobile | in-tree | 5 | Mobile app edits | Re-apply. |
| app-shell-ui | in-tree | 13 | App shell, pickers, dialogs and sidebar edits | Re-apply. |
| upstream-backport | in-tree | 1 | Backport of an upstream main change not yet in a release | Drops out when the release carries it. |
| secrets-plugin | plugin + in-tree | 28 | Secrets plugin and the host-daemon secret probe and commit RPCs with an allowlist enforced at request and write time (mk-vyxov) | Re-apply; bump the host daemon protocol version when upstream changes it. |
| event-cold-tier | in-tree | 45 | Event cold tier: history of long-archived threads moves to `event-archive/`, with `bb admin event-archive` (mk-o4xnc.8) | Re-apply the history gates around thread readers and writers. |
| window-presets | in-tree | 22 | Window presets: domain schema, server registry, routes, SDK area and `bb window` CLI (mk-hz175) | Re-apply; keep the CLI registries and JSON shapes in step. |
| session-search | plugin + in-tree | 39 | Session search over thread history | Re-apply. |
| host-sqlite | in-tree | 7 | Pin better-sqlite3 for the host artifact and probe FTS5 at startup | Re-apply; check against upstream artifact build changes. |
| launcher-hardening | in-tree | 28 | Launcher and daemon hardening: BB_CLI re-entry guard, startup stop guard, restart back-off, survive ENOSPC in the log transport | Re-apply. |
| layout-profiles | in-tree | 17 | Layout profiles and secondary panel storage, suppression and fixed tabs | Re-apply the Aleph side of panel and thread-screen edits. |
| extra-write-roots | in-tree | 2 | Extra workspace write roots for sandboxed agents | Re-apply. |
| upstream-sync-tooling | in-tree | 1 | `scripts/upstream-sync.sh`, the probe and prepare tool for upstream syncs | Keep Aleph's script. |
| test-hardening | in-tree | 5 | Bounded timeouts and hermetic setup for load-sensitive tests (mk-4tj93) | Re-apply. |

Totals: 1057 differing paths. 3 are deletions (`.github/workflows/deploy-ai-gateway.yml`, `close-stale-prs.yml` and `deploy-connect-next.yml`, imported workflows Aleph does not run); the rest are additions, edits and renames.

## Using the ledger

- Merge the upstream tag. For each conflict, find the path in the paths file, read the patch row, and re-apply the Aleph side.
- A conflict in a path whose patch is *keep* (composer-gate, history-keybindings, thread-open-follow, no-upstream-updates, branding) takes Aleph's version unless upstream changed the surface the patch depends on; then escalate.
- Record each real resolution with `git rerere` so the next sync replays it. Resolutions are reviewed before they are shared.
- Regenerate the paths file after every sync and check that `unattributed` is empty.
