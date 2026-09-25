#!/usr/bin/env bash
# Snapshot this git worktree to ~/Desktop/wt-snapshots/, and optionally commit.
#
# The snapshot is the point: it captures head, status, both diffs, and every
# untracked file so an interrupted session can be reconstructed even if the
# worktree is later lost. It never pushes, touches a remote, rebases, resets,
# or cleans — the only write it can ever make is a local commit, and only when
# --commit is passed explicitly.
set -euo pipefail
cd "$(dirname "$0")/.."

usage() {
  cat << 'USAGE'
Usage: scripts/checkpoint.sh [--commit -m MSG] [--dry-run]

Always writes a snapshot to ~/Desktop/wt-snapshots/<worktree>-<stamp>/ and
prints its path:

  head.txt        git rev-parse HEAD, the branch, and the worktree path
  status.txt      git status --short --branch --untracked-files=all
  tracked.diff    git diff            (unstaged changes to tracked files)
  staged.diff     git diff --staged   (the index)
  untracked.tgz   every untracked, non-ignored file (may be an empty archive)

Flags:
  --commit     After snapshotting, stage everything EXCEPT .codex/gates and
               .codex/evidence, commit it, and print the new HEAD. Requires
               -m. Without this flag the script is snapshot-only and makes no
               git write at all.
  -m MSG       Commit message. Used only with --commit; MSG is committed
               verbatim.
  --dry-run    Make no git write. With --commit, print exactly which paths
               would be staged (git add --dry-run) and the commit command
               that would run, then stop. The snapshot is still written.
  -h, --help   Show this message.

Never runs: push, fetch, remote, rebase, reset, clean, stash, merge,
cherry-pick, checkout, switch, or worktree add/remove.
USAGE
}

do_commit=0
dry_run=0
message=""

while [ $# -gt 0 ]; do
  case "$1" in
    --commit) do_commit=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -m)
      [ $# -ge 2 ] || { echo "checkpoint: -m needs a message" >&2; exit 2; }
      message="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "checkpoint: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$do_commit" -eq 1 ] && [ -z "$message" ]; then
  echo "checkpoint: --commit requires -m MSG" >&2
  exit 2
fi
if [ "$do_commit" -eq 0 ] && [ -n "$message" ]; then
  echo "checkpoint: -m is only meaningful with --commit" >&2
  exit 2
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "checkpoint: not inside a git worktree" >&2
  exit 1
}
cd "$ROOT"

STAMP=$(date +%Y%m%d-%H%M%S)
SNAPSHOT="$HOME/Desktop/wt-snapshots/$(basename "$ROOT")-$STAMP"
mkdir -p "$SNAPSHOT"
chmod 700 "$SNAPSHOT"

{
  echo "worktree: $ROOT"
  echo "branch:   $(git rev-parse --abbrev-ref HEAD)"
  echo "head:     $(git rev-parse HEAD)"
} > "$SNAPSHOT/head.txt"

git status --short --branch --untracked-files=all > "$SNAPSHOT/status.txt"
git diff > "$SNAPSHOT/tracked.diff"
git diff --staged > "$SNAPSHOT/staged.diff"

# -z + --null keeps filenames with spaces or newlines intact. An empty file
# list still produces a valid (empty) archive, so untracked.tgz always exists.
git ls-files --others --exclude-standard -z \
  | tar --null -T - -czf "$SNAPSHOT/untracked.tgz"

echo "snapshot: $SNAPSHOT"

[ "$do_commit" -eq 1 ] || exit 0

# .codex/gates and .codex/evidence are session artifacts and evidence pins.
# They are deliberately left out of the commit; whether they belong in the
# repository is a separate decision the operator makes on its own.
if [ "$dry_run" -eq 1 ]; then
  echo "dry-run: would stage (git add -A -- ':!.codex/gates' ':!.codex/evidence'):"
  git add --dry-run -A -- ':!.codex/gates' ':!.codex/evidence'
  echo "dry-run: would run: git commit -m \"$message\""
  exit 0
fi

git add -A -- ':!.codex/gates' ':!.codex/evidence'

if git diff --cached --quiet; then
  echo "checkpoint: nothing to commit after exclusions" >&2
  exit 1
fi

git commit -m "$message" > /dev/null
echo "committed: $(git rev-parse HEAD)"
