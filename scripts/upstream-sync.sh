#!/usr/bin/env bash
# Keep Aleph close to upstream bb in small steps.
#
#   scripts/upstream-sync.sh probe [--json]
#       Read-only. Fetches upstream, reads UPSTREAM_BASE, and finds the
#       farthest upstream first-parent commit that merges into the current
#       branch with no conflict. Reports the next conflicting commit, the
#       conflicted paths there, and the patch-ledger rows they belong to.
#
#   scripts/upstream-sync.sh prepare [UPSTREAM_COMMIT]
#       Creates branch sync/upstream-<short> at a single-parent sync commit
#       that brings upstream up to UPSTREAM_COMMIT (default: the farthest
#       clean commit from probe) and rewrites UPSTREAM_BASE. It refuses a
#       commit that conflicts. It never pushes, merges, tags or bumps the
#       Aleph version; the gate and review run on the branch afterwards.
#
# Syncs are squashed, so `git merge-base` with upstream does not move.
# Every merge here uses the explicit base recorded in UPSTREAM_BASE.
# Environment: ALEPH_UPSTREAM_REMOTE (default "upstream"),
#              ALEPH_SYNC_ONTO (default "origin/main").
set -euo pipefail

remote="${ALEPH_UPSTREAM_REMOTE:-upstream}"
onto="${ALEPH_SYNC_ONTO:-origin/main}"
ledger="docs/aleph-patch-ledger-paths.tsv"

die() { echo "upstream-sync: $*" >&2; exit 2; }

cd "$(git rev-parse --show-toplevel)"

base_field() { git show "$onto:UPSTREAM_BASE" | awk -v k="$1:" '$1==k{print $2}'; }

fetch() {
  git fetch -q "$remote" main
  git fetch -q origin main
}

# Read the whole file: an early awk exit would SIGPIPE git under pipefail.
release_at() { git show "$1:CHANGELOG.md" | awk '/^## [0-9]/ && !f {print $2; f=1}'; }

clean_at() { git merge-tree --write-tree --merge-base="$base" "$onto" "$1" >/dev/null 2>&1; }

conflicted_paths() {
  # --name-only prints the tree id, the conflicted paths, a blank line,
  # then the messages; keep only the paths.
  git merge-tree --write-tree --name-only --merge-base="$base" "$onto" "$1" 2>/dev/null \
    | sed -n '2,/^$/p' | sed '/^$/d' | sort -u || true
}

ledger_patches() {
  # stdin: paths. stdout: "patch<TAB>path" (patch "-" when unlisted).
  if [[ -f "$ledger" ]]; then
    awk -F'\t' 'NR==FNR{if(FNR>1)p[$3]=$1;next}{print (($0 in p)?p[$0]:"-") "\t" $0}' "$ledger" -
  else
    sed 's/^/-\t/'
  fi
}

load() {
  fetch
  base="$(base_field commit)"
  [[ -n "$base" ]] || die "UPSTREAM_BASE on $onto has no commit line"
  git cat-file -e "$base^{commit}" 2>/dev/null || die "base $base is not fetched"
  mapfile -t commits < <(git rev-list --first-parent --reverse "$base..$remote/main")
  # Cleanliness is not monotonic (a later upstream commit can revert a
  # conflicting one), so scan back from the head for the farthest clean
  # commit instead of bisecting. A merge-tree costs well under a second.
  # clean_upto is a count: commits[clean_upto-1] is the tip, and every
  # commit after it conflicts.
  clean_upto=${#commits[@]}
  while (( clean_upto > 0 )) && ! clean_at "${commits[clean_upto-1]}"; do
    clean_upto=$((clean_upto - 1))
  done
}

cmd_probe() {
  local json=0; [[ "${1:-}" == "--json" ]] && json=1
  load
  local total=${#commits[@]} tip="" next="" head_conf=0 next_paths=""
  (( clean_upto > 0 )) && tip="${commits[clean_upto-1]}"
  if (( clean_upto < total )); then
    next="${commits[clean_upto]}"
    next_paths="$(conflicted_paths "$next")"
    head_conf="$(conflicted_paths "$remote/main" | grep -c . || true)"
  fi
  local up_release; up_release="$(release_at "$remote/main")"
  if (( json )); then
    {
      printf '%s\n' "$next_paths" | sed '/^$/d' | ledger_patches
    } | jq -Rn \
      --arg base "$base" --arg base_release "$(base_field release)" \
      --arg upstream_head "$(git rev-parse "$remote/main")" --arg upstream_release "$up_release" \
      --argjson behind "$total" --argjson clean_upto "$clean_upto" \
      --arg clean_tip "$tip" --arg next "$next" --argjson head_conflicts "$head_conf" \
      --arg next_subject "$([[ -n "$next" ]] && git log -1 --format=%s "$next")" '
      {base:$base, base_release:$base_release, upstream_head:$upstream_head,
       upstream_release:$upstream_release, new_release:($upstream_release != $base_release),
       behind:$behind, clean_upto:$clean_upto, clean_tip:$clean_tip,
       next_conflict:(if $next=="" then null else
         {commit:$next, subject:$next_subject,
          paths:[inputs | split("\t") | {patch:.[0], path:.[1]}]} end),
       head_conflicts:$head_conflicts}'
  else
    echo "base:            $base ($(base_field release))"
    echo "upstream main:   $(git rev-parse --short "$remote/main") (CHANGELOG top: $up_release)"
    echo "behind:          $total first-parent commits"
    echo "clean through:   $clean_upto${tip:+ ($(git log -1 --format='%h %s' "$tip"))}"
    if [[ -n "$next" ]]; then
      echo "next conflict:   $(git log -1 --format='%h %s' "$next")"
      printf '%s\n' "$next_paths" | sed '/^$/d' | ledger_patches | sed 's/^/                 /'
      echo "conflicts at upstream head: $head_conf paths"
    else
      echo "upstream head merges cleanly"
    fi
  fi
}

cmd_prepare() {
  load
  local target="${1:-}"
  if [[ -z "$target" ]]; then
    (( clean_upto > 0 )) || die "no clean upstream commit past the base"
    target="${commits[clean_upto-1]}"
  fi
  target="$(git rev-parse --verify "$target^{commit}")"
  git merge-base --is-ancestor "$base" "$target" || die "$target does not descend from the base"
  local tree
  tree="$(git merge-tree --write-tree --merge-base="$base" "$onto" "$target")" \
    || die "$target conflicts with $onto; resolve it on a branch by hand"
  local release short branch idx
  release="$(release_at "$target")"
  short="$(git rev-parse --short=10 "$target")"
  branch="sync/upstream-$short"
  git show-ref -q --verify "refs/heads/$branch" && die "branch $branch already exists"
  idx="$(mktemp)"; trap 'rm -f "$idx"' RETURN
  GIT_INDEX_FILE="$idx" git read-tree "$tree"
  local blob
  blob="$(git show "$onto:UPSTREAM_BASE" \
    | awk -v c="$target" -v r="$release" '$1=="commit:"{$0="commit: " c} $1=="release:"{$0="release: " r} {print}' \
    | git hash-object -w --stdin)"
  GIT_INDEX_FILE="$idx" git update-index --cacheinfo "100644,$blob,UPSTREAM_BASE"
  tree="$(GIT_INDEX_FILE="$idx" git write-tree)"
  local n; n="$(git rev-list --first-parent --count "$base..$target")"
  local msg
  msg="Sync Aleph to upstream bb $short ($n commits past $(base_field release))

Upstream: $(git log -1 --format='%H %s' "$target")
Base:     $base
Release:  $release (top of upstream CHANGELOG at this commit)

Merged with git merge-tree --merge-base=$base, no conflicts.
Prepared by scripts/upstream-sync.sh."
  local commit; commit="$(git commit-tree "$tree" -p "$(git rev-parse "$onto")" -m "$msg")"
  git branch "$branch" "$commit"
  local migrations
  migrations="$(git diff --name-only --diff-filter=A "$onto" "$commit" -- packages/db/drizzle)"
  if [[ -n "$migrations" ]]; then
    echo "upstream-sync: this step adds migrations; run the FORK.md timestamp check:" >&2
    printf '  %s\n' $migrations >&2
  fi
  echo "$branch $commit"
}

case "${1:-probe}" in
  probe) shift || true; cmd_probe "$@" ;;
  prepare) shift; cmd_prepare "$@" ;;
  -h|--help) sed -n '2,20p' "$0" ;;
  *) die "unknown command: $1 (probe | prepare)" ;;
esac
