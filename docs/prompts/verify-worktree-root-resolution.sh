#!/usr/bin/env bash
# Prove the verification worktree in codex-sync-to-current-overlay.md resolves
# to the SAME absolute path from the main checkout and from a linked worktree,
# and that the nesting guard fires.
#
# Read-only: it never creates, moves, prunes, or deletes a worktree or branch.
#
#   bash docs/prompts/verify-worktree-root-resolution.sh
set -euo pipefail

PROMPT_REL="docs/prompts/codex-sync-to-current-overlay.md"
WORKTREE_NAME="overlay-lifecycle-verify"
failures=0

check() {
  if [ "$2" = "$3" ]; then
    printf 'ok    %s\n' "$1"
  else
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$3" "$2" >&2
    failures=$((failures + 1))
  fi
}

# THE resolution under test, verbatim from the prompt. It is a function so it
# can be evaluated from more than one working directory in this one process.
resolve_worktree_dir() {
  local common_git_dir repo_root
  common_git_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
  repo_root="$(cd "$common_git_dir/.." && pwd -P)"
  printf '%s/.claude/worktrees/%s\n' "$repo_root" "$WORKTREE_NAME"
}

resolve_repo_root() {
  local common_git_dir
  common_git_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
  (cd "$common_git_dir/.." && pwd -P)
}

# The nesting guard, verbatim from the prompt: 0 = allowed, 1 = refused.
nesting_guard_allows() {
  local current_tree="$1" repo_root="$2" worktree_dir="$3"
  if [ "$current_tree" != "$repo_root" ]; then
    case "$worktree_dir/" in
      "$current_tree"/*) return 1 ;;
    esac
  fi
  return 0
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
REPO_ROOT="$(cd "$HERE" && resolve_repo_root)"
EXPECTED="$REPO_ROOT/.claude/worktrees/$WORKTREE_NAME"

echo "main repository root: $REPO_ROOT"
echo "expected worktree:    $EXPECTED"
echo

# 1. From the main repository root.
check "resolves from the main repository root" \
  "$(cd "$REPO_ROOT" && resolve_worktree_dir)" "$EXPECTED"

# 2. From every linked worktree, including the one this file lives in.
while IFS= read -r tree; do
  [ -d "$tree" ] || continue
  tree="$(cd "$tree" && pwd -P)"
  [ "$tree" = "$REPO_ROOT" ] && continue
  # A registered-but-detached directory (a stale entry) cannot answer git at
  # all. Report and skip it — never prune it here.
  if ! (cd "$tree" && git rev-parse --git-dir >/dev/null 2>&1); then
    printf 'skip  %s is registered but is not a git worktree (report, do not prune)\n' "$tree"
    continue
  fi
  check "resolves from linked worktree $tree" \
    "$(cd "$tree" && resolve_worktree_dir)" "$EXPECTED"
  # …and never the nested path a relative instruction would have produced.
  nested="$tree/.claude/worktrees/$WORKTREE_NAME"
  check "does not resolve to the nested path under $tree" \
    "$([ "$(cd "$tree" && resolve_worktree_dir)" = "$nested" ] && echo nested || echo not-nested)" \
    "not-nested"
  # The guard must refuse a target that WOULD be nested under this worktree.
  check "nesting guard refuses $nested" \
    "$(nesting_guard_allows "$tree" "$REPO_ROOT" "$nested" && echo allowed || echo refused)" \
    "refused"
done < <(git -C "$REPO_ROOT" worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}')

# 3. The guard must still ALLOW the intended target from the main checkout.
check "nesting guard allows the intended target from the main checkout" \
  "$(nesting_guard_allows "$REPO_ROOT" "$REPO_ROOT" "$EXPECTED" && echo allowed || echo refused)" \
  "allowed"

# 4. The prompt itself must carry the absolute resolution and no relative path.
PROMPT="$HERE/$PROMPT_REL"
for needle in \
  'COMMON_GIT_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"' \
  'REPO_ROOT="$(cd "$COMMON_GIT_DIR/.." && pwd -P)"' \
  "WORKTREE_DIR=\"\$REPO_ROOT/.claude/worktrees/$WORKTREE_NAME\"" \
  'git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR"'
do
  check "prompt documents: $needle" \
    "$(grep -Fq -- "$needle" "$PROMPT" && echo present || echo missing)" "present"
done
# No EXECUTABLE relative path may remain: every worktree is created at
# "$WORKTREE_DIR" and every follow-up command addresses it absolutely. (Prose
# that names the hazard is fine — that is what the guard is documenting.)
bad_add="$(grep -F 'worktree add' "$PROMPT" | grep -cv '"\$WORKTREE_DIR"' || true)"
check "every 'git worktree add' targets \$WORKTREE_DIR" "${bad_add:-0}" "0"
check "no relative 'cd overlay' launch remains" \
  "$(grep -Eq '^[[:space:]]*\(?cd overlay' "$PROMPT" && echo found || echo none)" "none"
check "no relative '.claude/worktrees' appears inside a command" \
  "$(grep -Eq '^[[:space:]]*(git|cd|bash|\(cd)[^#]*[^/"$]\.claude/worktrees' "$PROMPT" \
      && echo found || echo none)" "none"

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
