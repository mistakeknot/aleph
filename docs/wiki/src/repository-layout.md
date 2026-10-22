# Repository layout

Aleph is a pnpm workspace. The top level holds
<!--fig:apps=10-->10 apps (`apps/`),
<!--fig:packages=41-->41 packages (`packages/`) and
<!--fig:plugins=44-->44 plugins (`plugins/`). Integration and QA suites live in

`tests/`, runnable examples in `examples/plugins/`.

## Plugins

Most behavior ships as plugins. Of the
<!--fig:plugins=44-->44, <!--fig:official-plugins=44-->44 are listed in

`plugins/bb-official.json`, the official marketplace manifest.

- <!--fig:provider-plugins=7-->7 provider plugins (`provider-*`): ACP, Claude
  Code, Codex, Pi, plus retry and usage helpers.
- <!--fig:environment-plugins=4-->4 environment plugins (`environment-*`):
  git worktree, Modal sandbox, personal workspace and project checkout.
- `account-pool`: the Aleph account pool, described in
  [Account pool](account-pool.md).

## Where Aleph differs from upstream

`docs/forkable-plugins.md` and `scripts/forkable-plugins.json` name the
built-in plugins held to a portability rule: a copy of the plugin directory,
taken out of the repository, must install, typecheck, test and build with
public dependencies only. `node scripts/check-plugin-forks.mjs` checks that
rule. It does not measure how far a plugin differs from upstream.
