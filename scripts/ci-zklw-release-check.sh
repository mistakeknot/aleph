#!/usr/bin/env bash
# Manual zklw CI qualification for the bb-app Account Pooler release.
# The fleet worker runs this in a fresh, credential-free Ubuntu guest.
set -euo pipefail

[[ "${CI:-}" == true && -n "${CI_SOURCE_SHA:-}" ]] || {
  echo 'fresh CI guest and source SHA are required' >&2
  exit 2
}
[[ "$(git rev-parse HEAD)" == "$CI_SOURCE_SHA" ]] || {
  echo 'guest source does not match the admitted commit' >&2
  exit 2
}
[[ "$(node --version)" == v22.* ]] || {
  echo 'the pinned guest image must provide Node 22' >&2
  exit 2
}
[[ -z "${CODEX_POOL_AUTH_TOKEN:-}" && -z "${ANTHROPIC_AUTH_TOKEN:-}" ]] || {
  echo 'model-service credentials must not enter the CI guest' >&2
  exit 2
}
export TZ=UTC

# Reuse the repository's checksum-verified pnpm installer and committed pin.
pnpm_path_file="$(mktemp)"
pnpm_env_file="$(mktemp)"
export GITHUB_WORKSPACE="$PWD" GITHUB_PATH="$pnpm_path_file" GITHUB_ENV="$pnpm_env_file"
export PNPM_VERSION=9.15.0 RUNNER_TEMP="${TMPDIR:-/tmp}"
bash .github/actions/setup-workspace/install-pnpm.sh
export PATH="$(cat "$pnpm_path_file"):$PATH"
[[ "$(pnpm --version)" == "$PNPM_VERSION" ]] || {
  echo 'the verified pnpm version differs from the repository pin' >&2
  exit 2
}

export npm_config_cache="$(mktemp -d)"
export npm_config_fetch_timeout=120000
export CODEX_HOME="$(mktemp -d)"
printf '[features]\nshell_snapshot = false\n' > "$CODEX_HOME/config.toml"
if command -v codex >/dev/null 2>&1; then
  [[ "$(codex features list 2>/dev/null | awk '$1 == "shell_snapshot" { print $3 }')" == false ]] || {
    echo 'Codex shell snapshots are not disabled in the isolated profile' >&2
    exit 2
  }
fi

pnpm install --frozen-lockfile
node scripts/check-source-nul.mjs
node .github/workflows/check-version-lockstep.mjs
pnpm exec turbo run typecheck test \
  --filter=@bb/app --filter=@bb/config --filter=bb-app --concurrency=2 --env-mode=loose
pnpm exec turbo run typecheck --filter=@bb/server --concurrency=2 --env-mode=loose
# The runbook's default five-second Vitest timeout fails under parallel load.
# Preserve every assertion while allowing the installer and machine tests time.
pnpm exec turbo run test --filter=@bb/server --concurrency=2 --env-mode=loose -- --testTimeout=30000
env -u CODEX_HOME pnpm exec turbo run test typecheck --concurrency=2 --env-mode=loose \
  --filter=bb-plugin-account-pool --filter=bb-plugin-bb-account \
  --filter=bb-plugin-bb-ai --filter=bb-plugin-connect \
  --filter=bb-plugin-provider-codex --filter=@get-bb/plugin-sdk \
  --filter=@bb/templates --filter=@bb/cli
pnpm exec turbo run prepare:bundled --filter=bb-plugin-account-pool --env-mode=loose
pnpm exec turbo run smoke:tarball --filter=bb-app --force --env-mode=loose
(cd packages/bb-app && npm pack --json --dry-run --ignore-scripts) | node -e '
let json = "";
process.stdin.on("data", chunk => { json += chunk; });
process.stdin.on("end", () => {
  const paths = new Set(JSON.parse(json)[0].files.map(file => file.path));
  for (const required of [
    "server/dist/builtin-plugins/account-pool/dist/server.js",
    "server/dist/builtin-plugins/account-pool/package.json",
  ]) {
    if (!paths.has(required)) throw new Error(`bb-app tarball omits ${required}`);
  }
  const manifest = require("./packages/bb-app/server/dist/builtin-plugins/account-pool/package.json");
  if (manifest.version !== "0.1.1") throw new Error("bb-app bundles the wrong Account Pooler version");
});
'
[[ ! -e "$CODEX_HOME/shell_snapshots" ]] || {
  echo 'Codex shell snapshots were unexpectedly created' >&2
  exit 2
}
