# Aleph patch ledger

This ledger lists every difference between upstream bb bcefd50bf2 (the commit recorded in UPSTREAM_BASE) and Aleph, and says how each is held. It is the checklist for an upstream sync and the source of its conflict resolutions.

Each row is a patch: where it lives, why, and the resolution to use when a sync conflicts. The path-level mapping is in `aleph-patch-ledger-paths.tsv` (one line per differing path, with the patch id; the single exception is `scripts/ci-*-release-check.sh`, a deliberate redacted alias for the tracked release-check script, whose real file name carries an internal host name that the public-repo hygiene rule keeps out of tracked text). The classification is by path rule and commit history, so a path can belong to a neighbouring patch when two patches share a file. A path that fits no row is listed under `unattributed` and blocks a sync until it is classified.

Held as: *plugin* means the change lives in a plugin directory; *in-tree* means it edits upstream files and is what conflicts in a sync.

| Patch | Held as | Files | Why | Conflict resolution | Audit verdict |
|---|---|---|---|---|---|
| account-pooler | plugin + in-tree | 41 | Account Pooler 0.1.2/0.6.3: owning-machine thread availability, `bb pool exec`, attempt receipts, stall tolerance, highest-priority-account fresh conversations (mk-6v3o6) | Keep the Aleph side of the fresh-conversation account choice (07c1ec9e). Contract: plugins/account-pool/RECEIPTS.md. | **Keep.** Pool exec, receipts and quota history have no upstream equivalent; upstream's refusal-based quota refactor (#6849) conflicts with quota.ts/hub.ts and needs a real rebase. |
| app-header-status | in-tree | 2 | Header status strip for the Account Pooler | Re-apply; upstream has no equivalent slot use. | **Keep.** Upstream has no app-header slot; the strip and its experimental_appHeaderStatus slot are Aleph-only. The slot is generic and a candidate to propose upstream. |
| thread-list-icons | plugin + in-tree | 25 | Provider icons and hull designation rows in the thread list (mk-omogp.7) | Plugin files carry the change. | **Keep.** Hull badge and provider icon colour have no upstream equivalent; helpers are plugin-held, only ThreadRow.tsx edits remain in-tree (conflicts with #6754). Slot absorption is unverified. |
| split-panes | in-tree | 17 | Optional composer focus on pane switch; Cmd/Ctrl-W closes the focused pane (mk-3tlt) | Re-apply the Aleph side of pane navigation. | **Keep.** Still needed: upstream's close-window request only handles the secondary panel, so Cmd/Ctrl-W pane close and split layout have no upstream equivalent. Re-check on each base move. |
| model-picker | in-tree | 2 | Switch a thread's provider in place | Re-apply. | **Keep.** Small picker/menu behaviour deltas not present upstream; no extension point exists. Candidate to propose upstream as a small generic change; re-diff on each rebase. |
| diagnostics-log | in-tree | 19 | Renderer diagnostics log and composer-stuck guards (mk-h1q8) | The desktop logging bridge is gated on BB_DESKTOP_RELEASE_CHANNEL=aleph; the pending-interaction guards are not gated. Re-apply the emitter calls and the guards. | **Keep.** for now; upstream composer-stuck fixes (#6630, #7001) may supersede some guards. Not verified; follow-up bead re-tests each guard on the new base. |
| composer-gate | in-tree | 8 | Composer pending-interaction gate | Keep Aleph's gate over upstream's composer edits (07c1ec9e). | **Keep.** Gate still needed. The question-draft map is dead code superseded by upstream's useQuestionFormDraft; remove it and regenerate the registry JSON (child bead). |
| history-keybindings | in-tree | 40 | Aleph-only additions around the upstream back/forward shortcuts (`Mod+[` / `Mod+]`): the Go menu entries, the page-first `browser.back` / `browser.forward` commands in the in-app browser panel, and editable-target detection for them (mk-fruz9). `history.back` / `history.forward` and `HistoryCommandHandlers` are upstream's, not patched | Take upstream's `history.*` bindings and handlers; re-apply only the Go menu, `browser.back` / `browser.forward` and `isEditableCommandTarget`. Not a keep patch. | **Keep (narrowed).** PR #128 adopted upstream's history bindings; what remains is the Go menu and the page-first browser back/forward fall-through. Upstream any remaining delta. |
| thread-open-follow | in-tree | 2 | Background thread open without stealing focus | Keep Aleph's handling (07c1ec9e). | **Keep.** Still needed: upstream's thread-open signal handler is unchanged since base and has no follow gating. Small generic helper, good upstream candidate. |
| themes | in-tree | 37 | Thecla and Dorcas themes, Dorcas music mode, ambient screen care (mk-dqrwh.2) | Re-apply theme tokens; check against upstream theme changes. | **Keep.** Palettes (Thecla, Dorcas) could become upstream-style custom themes; music mode and ambient screen care stay in core. Move-to-theme bead recommended. |
| agent-priority | in-tree | 15 | Agent worker priority (BB_AGENT_NICE) and own systemd scope | Re-apply daemon and bridge hooks. | **Keep.** No upstream equivalent (checked at 5758b8c09a). Daemon and bridge hooks conflict-prone: upstream touched app.ts and runtime-manager.ts 3 times since base. Generic nice part is an upstream candidate. |
| provider-bridge-changes | in-tree | 42 | Provider bridge changes: promptCacheTtl, A2 cache-write split, agent scopes, rerecorded fixtures | Rerecord provider-parity fixtures after any upstream bridge change. | **Keep.** Spawn hooks, cgroup thread scopes and promptCacheTtl have no upstream equivalent; upstream #7039 (oom_score_adj) solves a related problem differently. Recordings need rerecording after sync. |
| provider-usage | plugin + in-tree | 8 | Provider usage: every provider at once, burn rate on hover | Re-apply. | **Keep.** Burn-rate/projection UI is Aleph-only and a candidate to propose upstream; the `kind` passthrough is now upstream (usage-source-contract.ts) and can be dropped. |
| tasks-plugin | plugin + in-tree | 8 | Tasks plugin detail column and links | Re-apply. | **Keep.** Palette search and the detail split have no upstream equivalent; palette search needs the Aleph-only command-palette slot. App-shell edits should be re-checked against #7056. |
| plugin-surface | in-tree | 60 | Plugin SDK and server surface additions (search slot, appHeaderStatus, docs) | Re-apply; run plugin-api-docs surface tests. | **Keep.** Aleph slots (app-header status, command-palette search, message transfer) have no upstream equivalent; ownership is mixed across rows. Palette-search slot and sdk-compat parameter are upstream candidates. |
| thread-search-learned | in-tree | 2 | Learned thread search selections | Re-apply. | **Keep.** Learned search selections have no upstream equivalent and need a server route plus an Aleph migration. The row's path list is incomplete (implementation files are attributed elsewhere). |
| queue-transfer | in-tree | 136 | Queue retirement, transfer ledger and the G2-G6 capability fences (mk-ilhx, mk-be5r, mk-ni8m, mk-ct0k) | Re-apply. The queue schema lives in fork migration A0009 (see fork-owned-migrations). | **Keep.** No upstream queue retirement/transfer. Resolution: re-apply; queue schema lives in A0009. Upstream candidate: archived-thread insert fence (fb8d014dbd). |
| timeline-build-bound | in-tree | 11 | Bounded open-turn latest timeline builds | Re-apply. | **Keep.** , partly superseded. Upstream #6964/#7012/#7033 replace our selection reuse; the per-thread build coalescer has no upstream equivalent. Take upstream's memo/cache, re-validate the coalescer. |
| thread-cli | in-tree | 14 | CLI changes for thread wait (`--terminal`), conditional writes (`--if-*`) and the theme command | Re-apply. | **Keep, upstream candidate.** Upstream lacks wait --terminal, the --if-* conditional writes and Aleph's theme command (upstream candidates). Send-time is now upstream's own; only a wrap-only test diff remains. |
| layer-groups | plugin + in-tree | 20 | Sidebar pace-layer groups plugin and conditional pin writes (mk-ks92z) | Plugin files carry the change. | **Keep.** Compare-and-set thread section writes (409 on conflict) have no upstream equivalent and are a generic upstream candidate. Ledger attribution of base.ts is mixed with other rows. |
| design-wiki | plugin + in-tree | 51 | Design Wiki plugin: read-only project Wiki page for docs/wiki/src CUJs and requirements (mk-vz3gw.1) | Plugin files carry the change; re-apply the registration lines. | **Move to plugin.** Only bundled-plugin registration, marketplace and icon lines remain in-tree; external install could drop them (feasibility unverified). |
| contributor-gate | in-tree | 1 | Aleph's PR gate admits only contributors Aleph approved; upstream's additions to `.github/APPROVED_CONTRIBUTORS` are not taken on a sync, since the gate reads that list from Aleph's base branch (mk-8lcd6) | Keep Aleph's list; drop upstream's added logins. | **Keep.** Aleph's list; drop upstream's added logins (3 since base). The sync script does not do this yet (bead pending). |
| credential-redaction | in-tree | 30 | Credential redaction layers (mk-3aoo); see docs/credential-redaction-residuals.md | Re-apply; vendored token patterns keep the MIT notice. | **Keep.** Upstream has no redaction layer (checked at 5758b8c09a). Vendored token patterns keep the MIT notice. Some listed paths are formatting-only; those belong to the format-cleanup bead. |
| no-upstream-updates | in-tree | 35 | Server and desktop skip upstream update checks on Aleph builds | Keep the update guards (07c1ec9e). | **Keep.** the update guards. Upstream's new updateWhenIdle scheduler keys off status.available, so null stays "up to date"; a regression test is pending. Several listed desktop and theme paths are mis-attributed. |
| signed-update-channel | in-tree | 62 | Signed update channel: manifest, floor, instance, install request and settings row | Restore the signed update contracts after a sync (fb8d2a5bdc). | **Keep.** Only the settings row could become a plugin settingsSection, and that would move it off the Updates page. Server routes, manifest, floor and install request stay in tree. Restore after a sync. |
| version-scheme | in-tree | 6 | Version `<upstream>+aleph.X.Y.Z` and lockstep check | Set after the merge by the version step. | **Keep.** Set by the version step after each merge; upstream moved to 0.48.1 and the +aleph suffix is re-applied then. |
| branding | in-tree | 8 | Desktop branding: Aleph strings, copyright, icons | Keep Aleph's desktop branding (07c1ec9e). | **Keep.** Aleph's desktop branding. No upstream overlap found at 5758b8c09a. |
| desktop-bridge | in-tree | 1 | Browser page preload test for editable-focus reporting in nested frames (mk-jwb7); the bridge EPIPE and shutdown handling is `apps/desktop/src/bridge-parent-watch.ts`, held under no-upstream-updates | Re-apply. | **Keep.** Preload/IPC support for editable-focus and split-pane close; needed while those rows stay. Retire together with them. |
| editable-focus | in-tree | 2 | Editable focus guard | Re-apply. | **Keep.** Superset of upstream's isEditableKeyboardTarget; still needed. Small generic fix, good upstream candidate. Ties to desktop-bridge. |
| fonts | in-tree | 2 | Ioskeley Mono font route tests | Re-apply. | **Keep.** Mono font service and route have no upstream equivalent. Could move with the themes bead if custom themes can load font files (unverified). |
| release-qualification | in-tree | 2 | Release qualification script and CI recipes | Re-apply. | **Keep.** Release check script is Aleph-only. Upstream edited a workflow Aleph deletes (deploy-ai-gateway.yml, 7f5d39cdd8); resolve the next sync by deleting again. |
| fork-owned-migrations | in-tree | 77 | Fork-owned migrations A0001-A0011 in `packages/db/drizzle-aleph/` (manifest `after` and `supersedes`) beside the frozen upstream `drizzle/` folder; one fork step supersedes upstream 0143_queued_message_state | Keep the fork folder and the frozen upstream pin. A sync that adds an upstream migration is an ESCALATE item; keep journal `when` values ordered or the boot check throws (FORK.md). | **Keep.** Fork migrations A0001-A0011 in `drizzle-aleph/` (manifest `after`/`supersedes`); upstream folder stays frozen. A sync that adds a migration is an ESCALATE item; keep journal `when` increasing. |
| fork-docs | in-tree | 38 | Fork documents, hygiene allowlist and changelog | Keep Aleph's text. | **Keep.** Aleph's text. Five shared files (api_to_audit, release-process, debugging-and-qa, CHANGELOG, changelog-preview test) conflict with upstream edits; take both sides on a sync. |
| build-config | in-tree | 17 | Build, lint and test configuration edits | Re-apply. | **Keep.** vite-react-compiler.ts is formatting-only (format-cleanup bead). package.json versions come from the version step. app-update.ts and the integration harness conflict with upstream updateWhenIdle work. |
| web-site | in-tree | 7 | Marketing site and blog edits | Re-apply. | **Retire after cleanup.** Retire after the format-cleanup bead: at the pinned upstream base (UPSTREAM_BASE, bcefd50bf2) all 7 paths differ by formatting only. Upstream has changed `public-marketplace.tsx` since (marketplace arrival tracking, 9662c45478), so retire by taking upstream's current text on a sync, not by restoring the base text. Adopting upstream's text needs format:check to pass or an oxfmt ignore entry. |
| mobile | in-tree | 5 | Mobile app edits | Re-apply. | **Keep.** Mobile shell deltas still present; thread-open-follow is the verified one. Other mobile differences are likely upstream drift but unconfirmed. |
| app-shell-ui | in-tree | 13 | App shell, pickers, dialogs and sidebar edits | Re-apply. | **Keep.** Catch-all shell row; Aleph-only hunks remain, but not every hunk is verified against upstream drift. Hunk-level review recommended before the next base move. |
| upstream-backport | in-tree | 1 | Aleph's own small fix (offline-host discovery logs at debug, with hostId); upstream still warns | Drops out when the release carries it. | **Keep, upstream candidate.** Mislabelled: this is Aleph's own fix (offline-host discovery logs at debug); upstream still warns. Upstream candidate. Move execution-options.ts here from no-upstream-updates. |
| secrets-plugin | plugin + in-tree | 28 | Secrets plugin and the host-daemon secret probe and commit RPCs with an allowlist enforced at request and write time (mk-vyxov) | Re-apply; bump the host daemon protocol version when upstream changes it. | **Keep.** No upstream secret RPCs. Resolution: re-apply; on a sync take upstream's host daemon protocol version and add one; conflicts in commands/protocol/session. |
| event-cold-tier | in-tree | 45 | Event cold tier: history of long-archived threads moves to `event-archive/`, with `bb admin event-archive` (mk-o4xnc.8) | Re-apply the history gates around thread readers and writers. | **Keep.** No upstream cold tier; upstream pruning (5758b8c09a) deletes events, ours archives them. Re-apply history gates and re-run the reader audit after a sync. |
| window-presets | in-tree | 22 | Window presets: domain schema, server registry, routes, SDK area and `bb window` CLI (mk-hz175) | Re-apply; keep the CLI registries and JSON shapes in step. | **Keep.** No upstream window presets. Not plugin-able until the SDK can arrange panes. Re-apply; keep `window` CLI registries and JSON shapes in step; upstream edited ui-preferences, server.ts. |
| session-search | plugin + in-tree | 19 | Session search over thread history | Re-apply. | **Keep.** Session search package is Aleph-only; the host-daemon probe hook has no plugin extension point. No upstream equivalent found (not exhaustively searched). |
| host-sqlite | in-tree | 7 | Pin better-sqlite3 for the host artifact and probe FTS5 at startup | Re-apply; check against upstream artifact build changes. | **Keep.** Upstream host-daemon does not depend on better-sqlite3 or probe FTS5. Upstream changed bb-app-artifact.ts (ef3d23f40b); re-check the build-host externals on a sync. |
| launcher-hardening | in-tree | 28 | Launcher and daemon hardening: BB_CLI re-entry guard, startup stop guard, restart back-off, survive ENOSPC in the log transport | Re-apply. | **Keep.** No upstream equivalent for the ENOSPC, stop-guard and BB_CLI re-entry guards (upstream candidates). Upstream's host-daemon back-off overlaps restart-policy.ts; compare at merge. |
| layout-profiles | in-tree | 17 | Layout profiles and secondary panel storage, suppression and fixed tabs | Re-apply the Aleph side of panel and thread-screen edits. | **Keep.** Still needed, but upstream's new raw fixed-panel tab read (#6594) bypasses the suppression mask. Follow-up bead audits and re-applies the mask at that read. |
| extra-write-roots | in-tree | 2 | Extra workspace write roots for sandboxed agents | Re-apply. | **Keep.** Host-daemon env hook for extra writable roots; no upstream equivalent. Small, opt-in, generic: upstream candidate. |
| upstream-sync-tooling | in-tree | 1 | `scripts/upstream-sync.sh`, the probe and prepare tool for upstream syncs | Keep Aleph's script. | **Keep.** Aleph's script. Upstream has no equivalent. It does not yet restore the contributor list (bead pending). |
| test-hardening | in-tree | 5 | Bounded timeouts and hermetic setup for load-sensitive tests (mk-4tj93) | Re-apply. | **Keep.** Two files also changed upstream (clipboard test 78671a2d66, protocol-self-update test 6d8e0d107d); re-test them after a sync. Generic timeout fixes are upstream candidates. |

Totals: 1041 differing paths. 3 are deletions (`.github/workflows/deploy-ai-gateway.yml`, `close-stale-prs.yml` and `deploy-connect-next.yml`, imported workflows Aleph does not run); the rest are additions, edits and renames.

## Audit summary (bead mk-uyf3d.2)

Audited against upstream bcefd50bf2 (this ledger's base) and upstream main as fetched on 2026-11-05. Each row's verdict answers four questions: still needed, superseded by upstream, movable to a plugin or upstream extension point, and worth proposing upstream. Evidence per row is in the verdict column and in the child beads. Claims marked *unverified* were not reproduced.

Verdict counts (48 rows): KEEP 44, MOVE-PLUGIN 1, UPSTREAM-CANDIDATE 2, RETIRE-BEAD 1, RETIRE-NOW 0.

No row retires now: every superseded fragment needs a code change that is a child bead (rebase, test or cleanup), not a ledger-only edit. The one RETIRE-BEAD row (web-site) differs from the pinned upstream base by formatting only; upstream main has moved on since.

### What moves to a plugin, and what stays core

Group counts: a 6, b 18, c 23, d 1. Each row appears once, in its main group; a row's other direction is in its note.

#### (a) Move to a plugin: 6 rows

| Patch | Extension point it needs | In upstream bb today? | Scope |
|---|---|---|---|
| thread-list-icons | `experimental_providerIcon` for the colour; a thread-row badge slot for hull designation | Icon slot: yes. Row-badge slot: no | ThreadRow render edits; the plugin-held files already live in the plugin |
| themes | Custom CSS-variable themes (`theme.css` in the data dir) | Yes | Thecla and Dorcas palettes only; music mode and ambient screen care stay core |
| design-wiki | External plugin install (replace the bundled-plugin registration lines) | Install path exists upstream; feasibility for a non-bundled default-enabled plugin unverified | whole row |
| signed-update-channel | `settingsSection` slot | Slot yes, but it renders on the plugin's own page, not inside the built-in Updates section | the settings row only; manifest, floor and install request stay core |
| fonts | Custom theme that loads a font file | Unknown: a theme loading a font file is unverified | decide with the themes move |
| window-presets | Plugin SDK API to arrange panes and threads, plus a plugin-owned `window` CLI command | No: `window` is a reserved CLI command and the SDK has only navigation hooks | registry, routes and CLI could move; the app controller cannot |

#### (b) Propose upstream (list only; nothing is filed on upstream): 18 rows

| Patch | What to propose | Extension point or note | Scope |
|---|---|---|---|
| app-header-status | Slot `experimental_appHeaderStatus` (Aleph-only today) | No: Aleph-only | the slot is generic; the header layout edit stays core until it lands |
| model-picker | Switch a thread's provider in place | n/a | small diff if the behaviour is generic |
| composer-gate | The pending-interaction gate | n/a | the dead question-draft map is deleted, not proposed |
| history-keybindings | Any remaining keybinding-context delta now that PR #128 has narrowed the override | n/a | Go menu and browser fall-through only |
| thread-open-follow | Follow only when appropriate on background open | n/a | small generic fix |
| agent-priority | Agent worker niceness (BB_AGENT_NICE) | n/a | the systemd-scope part is Linux-only |
| provider-usage | Burn rate and projection in an upstream-owned forkable plugin | n/a | generic feature |
| tasks-plugin | Palette search with its `experimental_commandPaletteSearch` slot | No: Aleph-only | app-shell edits stay core |
| plugin-surface | `experimental_commandPaletteSearch` slot and the `sdk-compat` runningVersion parameter | No: Aleph-only | this row is the extension surface itself |
| thread-cli | `wait --terminal` and `--if-*` conditional writes | n/a | send time is now upstream's own |
| layer-groups | Conditional thread-section write (409 on stale write) | n/a | best candidate: fixes a lost-update race |
| credential-redaction | Redaction layers in the event-storage path | n/a | large; vendored token patterns carry an MIT notice |
| editable-focus | Widened editable-target check | n/a | small generic fix |
| upstream-backport | Offline-host discovery logs at debug, with hostId | n/a | Aleph's own fix; upstream still warns |
| secrets-plugin | A no-file-access secret request path for upstream's plugin | n/a | idea only; the daemon RPCs are core |
| launcher-hardening | ENOSPC log-transport guard, startup stop guard, BB_CLI re-entry guard | n/a | generic |
| extra-write-roots | Opt-in extra workspace write roots for sandboxed agents | n/a | small, env-gated |
| test-hardening | Bounded timeouts and hermetic setup | n/a | generic |

#### (c) Fork core (Aleph identity, updates, migrations, and edits no extension point reaches): 23 rows

| Patch | Why it stays core |
|---|---|
| account-pooler | Edits to an upstream-owned forkable plugin; the rest is plugin-held already |
| split-panes | Core layout, desktop IPC and keybinding contexts |
| diagnostics-log | Guards sit inside composer and thread code paths; re-test against upstream fixes |
| provider-bridge-changes | Hooks live in agent-runtime; the cgroup scope file is Aleph-only already |
| thread-search-learned | Needs a server route and a database table |
| queue-transfer | DB data layer, thread ingress and server fences; no plugin point reaches them (the archived-thread insert fence is also a proposal) |
| timeline-build-bound | Server timeline internals; rebase onto upstream's incremental path first |
| contributor-gate | Fork policy: Aleph's approved-contributor list |
| no-upstream-updates | Aleph identity: no upstream update checks |
| version-scheme | Aleph identity: version scheme and lockstep check |
| branding | Aleph identity: desktop strings, copyright, icons |
| desktop-bridge | Desktop preload and IPC |
| release-qualification | Aleph release process and CI recipes |
| fork-owned-migrations | Core database boot path and the namespaced migration runner |
| fork-docs | Fork documents and changelog |
| build-config | Build, lint and test configuration of the fork |
| mobile | Mobile shell edits (partly follows thread-open-follow) |
| app-shell-ui | Core shell edits (catch-all row; hunk-level review advised) |
| event-cold-tier | 18 reader and writer gates across server code plus the data layer |
| session-search | The package is Aleph-only already; the host-daemon probe hook has no plugin point |
| host-sqlite | Native module in the host bundle; pairs with session-search |
| layout-profiles | Core panel storage and thread-screen edits |
| upstream-sync-tooling | Fork tooling for syncing upstream |

#### (d) Superseded: 1 row

| Patch | Superseded by | Action |
|---|---|---|
| web-site | Upstream's own text (only formatting differs at the pinned base; upstream main has since added marketplace arrival tracking) | Drop the 7 paths after the format-cleanup bead and take upstream's current text; adopting upstream's text needs `format:check` to pass or an oxfmt ignore entry |

Superseded in part, held under other rows (child beads are listed in the PR): account-pooler: quota and receipts rebase onto upstream's refusal-based quota (#6849); provider-usage: the `kind ?? "custom"` passthrough hunk (#7006); timeline-build-bound: incremental timeline path (`timeline-selection-memo.ts`, `timeline-cache.ts`, `thread-timeline-windows.ts`); diagnostics-log: composer-stuck guards that #6630 and #7001 may cover (unverified); composer-gate: the dead question-draft map; history-keybindings: Cmd-[ and Cmd-] bindings, retired to upstream by PR #128.

Extension points that exist in upstream today: plugin SDK slots (`experimental_providerIcon`, `experimental_ThreadStatusGlyph`, `experimental_resolveThreadStatus`), `settingsSection`, custom CSS-variable themes, and the forkable-plugin rules (`docs/forkable-plugins.md`). Aleph-only today: `experimental_appHeaderStatus` and `experimental_commandPaletteSearch`. Missing for the moves above: a thread-row badge slot, a pane-arrange SDK API, a plugin hook into the host daemon, and a settings slot inside a built-in section.

### Ledger corrections made by this audit

- queue-transfer and fork-owned-migrations: the old text named migration 0151 and renumbered upstream migrations; the fork now uses the namespaced runner with `A0001` to `A0011`. Text corrected.
- upstream-backport: it is Aleph's own fix, not a backport. thread-cli: send time is now upstream's own.
- Path attribution that the paths file gets wrong (a bead covers regeneration): `execution-options.ts` sits under no-upstream-updates but belongs to upstream-backport; `base.ts` is claimed by layer-groups although it also holds event-cold-tier and thread-search code; thread-search-learned owns only two test files; credential-redaction picks up unrelated files (`app-keybindings.ts`, `app-theme.ts`, `update-state.ts`, `changelog-metadata.ts`, `native-roots.ts`, `thread-create-origin.ts`).

### Child beads

Every row that needs code work has a bead under mk-uyf3d.2, with the evidence in the bead:

- mk-uyf3d.2.1: Rebase A0009 queued-message rebuild onto upstream 0148/0149 and re-derive journal when bumps (row: fork-owned-migrations)
- mk-uyf3d.2.2: Rebase timeline build coalescer onto upstream incremental timeline path (row: timeline-build-bound)
- mk-uyf3d.2.3: Rebase account-pool quota and receipts onto upstream refusal-based quota (#6849) (row: account-pooler)
- mk-uyf3d.2.4: Move ThreadRow icon colour and hull badge onto upstream slots (row: thread-list-icons)
- mk-uyf3d.2.5: Drop provider-usage kind passthrough and re-apply burn rate on upstream #7006 (row: provider-usage)
- mk-uyf3d.2.6: List upstream candidate: conditional thread-section write (no upstream PR) (row: layer-groups)
- mk-uyf3d.2.7: Install design-wiki as an external plugin instead of bundled (row: design-wiki)
- mk-uyf3d.2.8: Split plugin-surface ledger row by owner and list command-palette-search slot as upstream candidate (row: plugin-surface)
- mk-uyf3d.2.9: Rerecord provider-parity recordings and re-check agent-runtime hooks after sync (row: provider-bridge-changes)
- mk-uyf3d.2.10: Re-test diagnostics-log composer guards on the new base (row: diagnostics-log)
- mk-uyf3d.2.11: Remove dead question-draft map and regenerate registry JSON (row: composer-gate)
- mk-uyf3d.2.12: Move Thecla and Dorcas palettes to custom themes (decide fonts alongside) (row: themes)
- mk-uyf3d.2.13: Audit unmasked fixed-panel tab reads on the new base (row: layout-profiles)
- mk-uyf3d.2.14: upstream-sync.sh: restore Aleph APPROVED_CONTRIBUTORS after the merge step (row: contributor-gate)
- mk-uyf3d.2.15: Regression test: updateWhenIdle scheduler and bb updates --when-idle stay inert on Aleph builds (row: no-upstream-updates)
- mk-uyf3d.2.16: Drop formatting-only divergences from upstream (web-site paths and four other files) (row: web-site)
- mk-uyf3d.2.17: List upstream candidate: offline-host discovery logs at debug with hostId (no upstream PR) (row: upstream-backport)
- mk-uyf3d.2.18: List upstream candidate: thread wait --terminal and --if-* conditional writes (no upstream PR) (row: thread-cli)
- mk-uyf3d.2.19: Fix path attribution in aleph-patch-ledger-paths.tsv and its regeneration rules
- mk-uyf3d.2.20: Hunk-level review of catch-all ledger rows: app-shell-ui, mobile, session-search
- mk-uyf3d.2.21: List small generic fixes as upstream candidates (list only): editable-focus, extra-write-roots, thread-open-follow, model-picker, launcher-hardening, test-hardening, agent-priority, secrets request path, archived-thread queue insert fence

### Not verified

diagnostics-log guards against #6630 and #7001, app-shell-ui hunks, mobile hunks, session-search upstream equivalents, design-wiki external install, and whether a custom theme can load a font file (fonts). Child beads of mk-uyf3d.2 cover each.


## Using the ledger

- Merge the upstream tag. For each conflict, find the path in the paths file, read the patch row, and re-apply the Aleph side.
- A conflict in a path whose patch is *keep* (composer-gate, history-keybindings, thread-open-follow, no-upstream-updates, branding) takes Aleph's version unless upstream changed the surface the patch depends on; then escalate.
- Record each real resolution with `git rerere` so the next sync replays it. Resolutions are reviewed before they are shared.
- Regenerate the paths file after every sync and check that `unattributed` is empty.
