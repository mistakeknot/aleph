# Rig manager

A standalone, offline CLI and TypeScript API for describing an installation.
The package lives alongside the other workspace tools so it can reuse the
repository's migration and verification tools. It does not need a running server
and can inspect a stock bb database. No service or hook is started by the CLI.

Run from the repository after installing its dependencies:

```sh
pnpm --filter @bb/rig rig --help
pnpm --filter @bb/rig rig export --data-dir ./installation --agent-home ./provider-home --source-root ./bundle --output ./bundle/rig.yaml
pnpm --filter @bb/rig rig diff ./bundle/rig.yaml --data-dir ./installation --agent-home ./provider-home
pnpm --filter @bb/rig rig apply ./bundle/rig.yaml --target ./fresh-install --dry-run
pnpm --filter @bb/rig rig apply ./bundle/rig.yaml --target ./fresh-install
```

`export` requires explicit input directories and an output file that does not
already exist. It reads plugin rows and settings, pool configuration and account
metadata, provider configuration, and bb/Claude/Codex/agent global skill roots.
It enumerates plugin secret filenames without opening their contents. Sensitive
settings and suspicious strings become named references; stdout lists each
conversion's field and reference, never its value. An exported local source is
an inventory pointer: bundle the source or choose a common `--source-root` for
export and apply before moving the rig to another machine.

`diff` prints added, removed, and changed entries in each section. Its status is
0 for equality, 1 for drift, and 2 for error. Entry identity is a plugin/skill ID,
an agent name, or a pool field. No setting values appear in its output.
Unsupported native fields also produce status 1, with opaque diagnostics, even
when the portable rig contains no corresponding field. Equality is never
inferred from a lossy export alone.

`apply` requires `--target`. Provider homes default to `TARGET/rig-home`; an
explicit `--agent-home` must remain inside the target. It writes the target's
`env.json` with `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. An absent database is
initialized with this checkout's migrations; initialize stock bb normally first
to retain its schema. An existing target must contain no threads and no runtime
marker. Stop the target before use. These checks are an offline freshness
boundary, not a replacement for process isolation or a filesystem sandbox.
The tool refuses symbolic links and hard-linked writable files. It never
changes the caller's home or selects a target from ambient bb configuration.
A dry run plans changes and reports unsupported entries without writing files,
downloading sources, initializing a database, or executing hooks.
When native settings contain unsupported fields or values, apply reports them
and skips all writes, including unrelated planned changes. This preserves
unmodeled native keys rather than deleting them during whole-file rewrites.
Resolve unsupported configuration separately before applying the rig.

Plugins can use a relative local source, an HTTPS Git source pinned to a full
commit, an exact npm version, or an installed builtin. `--builtin-root` names
the target distribution's directory of builtin plugin directories. A builtin
absent from the target is reported as unsupported; other sections continue.
Sources are retained under the target. Source package versions must match the
rig. Dependency installation disables lifecycle scripts; dependencies requiring
those scripts need separate preparation. The native runtime builds plugin
entry points when it next starts. Skill source files are copied into the target's
global skill roots; replaced skills are retained under `rig-retained`.

Pool configuration is unsupported when the target lacks the account-pool plugin.
Reference bindings are retained separately in `rig-secret-references.json` and
are included in later exports and comparisons. **References never resolve to
credential values in this tool.** Fields containing references remain inactive
in native settings; stdout reports this unsupported activation. Provision the
named credentials using the target's native secure mechanism separately. The
rig does not make a credential available merely by naming it. Account metadata
uses native bb account IDs and configuration fields.

The tool uses SQLite transactions for database changes. Files and downloaded
sources are outside that transaction; an error can leave staged sources or
partially written configuration. Retain the target for inspection and rerun
after correcting the error. Use only fresh, stopped targets. It makes no change
to an active installation and does not provide a rollback command.

## Format reference

YAML keeps nested hooks and settings readable and supports the audit's proposed
shape. `apiVersion: bb.rig/v1` and `kind: Rig` are required. The runtime schema is
`rigSchema` in `src/index.ts`; `schema.json` is its JSON Schema representation.
Unknown structural fields, duplicate IDs, malformed references, and inline
secret-like values are rejected. Native settings use explicit non-secret key
allowlists in `src/secret-policy.ts`, scoped to agents, hooks, plugins, pool
settings, and account metadata. Unknown plain keys are omitted and listed as
warnings using an opaque reference ID; neither their names nor values appear in
the warning. Sensitive known fields become named references. A hand-authored rig
must use references for unknown or sensitive values before apply can accept it.
Native plugin secret filenames are retained as named references, including
env-style and custom names outside the plain-setting allowlist. Unsupported
names receive opaque warnings; the reference list includes only references
present in the resulting rig. Structural export failures identify schema paths
and input types, with dynamic field names suppressed and no input values.
The JSON Schema describes structure; use `parseRig` or the CLI for the full key,
value-shape, and command-argument policy.

Commands and argument arrays have a separate conservative grammar. Only a
single executable path or an explicitly listed executable, followed by listed
boolean flags, can remain plain. Arbitrary argument values, unknown flags,
credential flags, shell expansions, and complex shell syntax become one dormant
reference for the whole payload. No argument or command value is included in
conversion diagnostics. Ordinary long executable paths remain paths. The policy
also checks credential prefixes, bearer values, private-key material, assignment
syntax, opaque values, and URL credentials or query parameters.

An export can therefore omit unsupported settings and deactivate complex hooks.
In v1 arbitrary dormant hook references cannot be reactivated by this tool;
native credential provisioning does not supply a hook-command binding mechanism.
Inspect the warning
list before using an exported rig. The allowlist trusts the declared semantics
of known native metadata fields; selected source programs remain trusted code,
and their contents are not made secret-free by this configuration policy.

Known limits: permission-rule arrays (`allow`, `deny`, `ask`, and
`additionalDirectories`) and arbitrary plugin-specific plain settings remain
unsupported. Use named references for hand-authored unknown fields; v1 does not
resolve them. Hook plans report unsupported reference activation generally,
without enumerating dormant events. Account identity metadata (including email
and account IDs), endpoint hosts, and source paths can remain plain in a private
export. A filtered rig is not a share-safe artifact; inspect it before sharing.

| Field                         | Meaning                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| metadata.name                 | Portable rig name                                                                          |
| compatibility.extensionPoints | Required native extension points; nonempty requirements refuse activation until verifiable |
| plugins                       | IDs, sources, versions, enabled state, settings, and requires                              |
| skills                        | IDs, sources, and targets: bb, claude, codex, or agents                                    |
| agents.claude                 | Native settings object and native hooks object                                             |
| agents.codex                  | Native TOML settings object and native hooks.json object                                   |
| accountPool                   | Settings and accounts with id, provider, credential reference, and native config           |

A source is exactly one of `{path: relative-directory}`, `{builtin: id}`,
`{git: URL, ref: full-commit, subdir: relative-directory}`, or
`{npm: package-name, version: exact-version}`. Local sources must resolve inside
`--source-root` (the rig file's directory by default). Git subdirectories cannot
escape their checkout. The tool rejects source symlinks and credential-bearing
source filenames or recognizable inline credentials. Source programs and
installed hooks remain executable code: review the rig and sources before use.

A reference is exactly `{secretRef: 'env:VARIABLE_NAME'}` or
`{secretRef: 'store:logical/key'}`. Neither form contains a credential value.
Hooks retain the provider's native JSON structure rather than introducing a
command translation layer. Unsupported extension requirements fail closed.
The v1 schema accepts no unverifiable bb version-range claim.

## Worked example

Place an example plugin's package and source at `bundle/plugins/example`, with
package version `1.0.0`, and a skill at `bundle/skills/review/SKILL.md`:

```yaml
apiVersion: bb.rig/v1
kind: Rig
metadata: { name: example }
compatibility: { extensionPoints: [] }
plugins:
  - id: example
    source: { path: plugins/example }
    version: 1.0.0
    enabled: true
    settings:
      endpoint: https://example.test
      apiKey: { secretRef: "env:EXAMPLE_API_KEY" }
skills:
  - id: review
    source: { path: skills/review }
    targets: [claude, codex]
agents:
  claude:
    settings: { permissions: { defaultMode: default } }
    hooks: {}
  codex:
    settings: { approval_policy: on-request }
    hooks: {}
accountPool: { settings: {}, accounts: [] }
```

Apply this rig to a fresh directory using the commands above. The plugin and
skill are installed, provider settings are written, and `apiKey` is recorded
as an inactive reference. Reapplying the same rig produces no changes. On a
stock target, unsupported builtin plugins and pool settings are reported without
preventing supported entries from being applied.

The API exports `parseRig`, `loadRig`, `formatRig`, `schemaJson`, `exportRig`,
`diffRig`, and `applyRig`. Callers must supply the same explicit install paths
as the CLI. Errors suppress configuration and subprocess output.

Fixture verification:

```sh
pnpm exec turbo run typecheck lint test --filter=@bb/rig --concurrency=2
pnpm exec oxfmt --check packages/rig pnpm-lock.yaml
```
