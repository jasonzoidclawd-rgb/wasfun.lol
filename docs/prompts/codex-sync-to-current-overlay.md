# Codex Task — Sync to the current overlay (stop building on stale code)

You previously implemented a level-11/15 lifecycle fix on a **stale base**. This
prompt is self-contained; you do not need any prior conversation.

## Ground truth

- **Canonical overlay line** = branch `feat/overlay-tier-card` (the PR #46 head).
  Its tip **moves**. Resolve it at run time with the block below — never from a
  SHA copied out of a document.
- **The stale line** = branch `fix/level-11-15-lifecycle-current`, forked from the
  merge-base of the two lines and carrying only the lifecycle commit plus a
  generated-state commit. It is missing the entire post-fork overlay evolution.
- **The lifecycle fix already exists on the canonical line**, on top of the latest
  product state, with a byte-identical `overlay/src/liveGamePoll.ts`. There is
  **nothing to port** — verify, do not re-implement.

## Resolve the canonical base (do this first, every time)

Never hard-code a base SHA. Fetch, resolve, and prove ancestry:

```bash
set -euo pipefail
CANONICAL_BRANCH="feat/overlay-tier-card"
REMOTE="origin"

git fetch "$REMOTE" "$CANONICAL_BRANCH"

# Upstream tracking must exist and must point at the intended remote branch.
TRACKING="$(git rev-parse --abbrev-ref --symbolic-full-name \
  "${CANONICAL_BRANCH}@{upstream}" 2>/dev/null || true)"
[ "$TRACKING" = "${REMOTE}/${CANONICAL_BRANCH}" ] || {
  echo "STOP: ${CANONICAL_BRANCH} does not track ${REMOTE}/${CANONICAL_BRANCH} (got '${TRACKING:-none}')." >&2
  exit 1
}

LOCAL_TIP="$(git rev-parse "$CANONICAL_BRANCH")"
REMOTE_TIP="$(git rev-parse "${REMOTE}/${CANONICAL_BRANCH}")"

# The local canonical branch may be AHEAD of the remote (unpushed work is
# expected here), but it must never have diverged from it.
git merge-base --is-ancestor "$REMOTE_TIP" "$LOCAL_TIP" || {
  echo "STOP: ${CANONICAL_BRANCH} has diverged from ${REMOTE}/${CANONICAL_BRANCH}; do not build on it." >&2
  exit 1
}

CANONICAL_TIP="$LOCAL_TIP"
echo "canonical tip: $CANONICAL_TIP"
echo "ahead of ${REMOTE}/${CANONICAL_BRANCH}: $(git rev-list --count "${REMOTE_TIP}..${CANONICAL_TIP}")"
```

Before you touch any working branch, prove it is **not** based on stale history:

```bash
git merge-base --is-ancestor "$CANONICAL_TIP" HEAD || {
  echo "STOP: HEAD is based on stale history; it is missing $(git rev-list --count "HEAD..${CANONICAL_TIP}") canonical commit(s)." >&2
  exit 1
}
```

If either check fails, stop and report. Do not rebase, reset, or force anything
to make the check pass.

## What to do

1. **Abandon** `fix/level-11-15-lifecycle-current` as an implementation base.
2. **Keep** that branch only as reference/backup — it is already preserved under
   `backup/level-11-15-lifecycle-current-*`. Do not reset, rebase, delete, or
   force-push it.
3. Create a **fresh worktree/branch from the resolved canonical tip**, at an
   **absolute** path derived from the main repository root. Do not assume you
   started in the main checkout — a relative `.claude/worktrees/...` run from a
   linked worktree nests a checkout inside a checkout, and because `.claude/` is
   ignored that accident stays invisible to an ordinary `git status`:
   ```bash
   set -euo pipefail

   # `--git-common-dir` is the ONE shared .git directory: the same answer from
   # the main checkout and from every linked worktree. That is what makes this
   # location-independent.
   COMMON_GIT_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
   REPO_ROOT="$(cd "$COMMON_GIT_DIR/.." && pwd -P)"
   WORKTREE_DIR="$REPO_ROOT/.claude/worktrees/overlay-lifecycle-verify"
   BRANCH="work/overlay-lifecycle-verify"
   CURRENT_TREE="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"

   # The canonical resolution above must have run: never create a worktree from
   # an unresolved or hand-copied base.
   [ -n "${CANONICAL_TIP:-}" ] || {
     echo "STOP: resolve CANONICAL_TIP first." >&2; exit 1; }

   # REPO_ROOT must be the MAIN repository root, not a linked worktree: in a
   # linked worktree --git-dir is .git/worktrees/<name>, not the common dir.
   [ "$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-dir)" \
       = "$COMMON_GIT_DIR" ] || {
     echo "STOP: '$REPO_ROOT' is not the main repository root." >&2; exit 1; }

   # Never nest inside the worktree you are standing in. (When you ARE in the
   # main checkout, .claude/worktrees/ under it is the intended location.)
   if [ "$CURRENT_TREE" != "$REPO_ROOT" ]; then
     case "$WORKTREE_DIR/" in
       "$CURRENT_TREE"/*)
         echo "STOP: refusing to nest a worktree inside '$CURRENT_TREE'." >&2
         exit 1 ;;
     esac
   fi

   [ ! -e "$WORKTREE_DIR" ] || {
     echo "STOP: '$WORKTREE_DIR' already exists; report it, do not remove it." >&2
     exit 1; }
   git show-ref --verify --quiet "refs/heads/$BRANCH" && {
     echo "STOP: branch '$BRANCH' already exists; report it, do not reset it." >&2
     exit 1; } || true

   echo "worktree target: $WORKTREE_DIR"
   git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" -b "$BRANCH" "$CANONICAL_TIP"
   ```
   Run `bash docs/prompts/verify-worktree-root-resolution.sh` first: it proves
   the target resolves to the same absolute path from the main checkout and from
   a linked worktree, and that the nesting guard fires.

   If you find an **existing** worktree at that path — or an accidental nested
   one under `.claude/worktrees/*/.claude/worktrees/` — **report it and stop**.
   Do not reset, remove, prune, or delete any worktree, branch, or directory to
   make room.
4. **Verify the lifecycle semantics are already present** on canonical — do NOT
   re-port them from the stale line:
   - `overlay/src/liveGamePoll.ts` `resolveLiveDataPoll` with
     `LIVE_DATA_FAILURE_GRACE_MS = 30_000`.
   - `poll()` wiring in `overlay/src/App.tsx` and `[game-poll]` diagnostics in
     `overlay/src/dev/publicationDiagnostics.ts`.
   - Tests `overlay/src/liveGamePoll.test.ts`,
     `overlay/src/liveGamePollIntegration.test.ts`.
   Confirm behavior: preserve game/offer/OCR ownership through a transient Live
   Client Data outage; 30 s grace = three worst-case ~9 s polls; clear
   immediately on confirmed non-live gameflow; fail closed after grace; reset
   the failure window on recovery; never activate a new game from missing data.
5. **Do not import any generated state** (CLAUDE.md STATE block, `scripts/state.json`)
   from the stale line. If a test count changes, let the canonical post-commit
   hook regenerate it.
6. If a test or snapshot must change, **regenerate it from canonical source** —
   never from the stale base.
7. **Preserve all latest** UI, CSS, calibration, authentication/device-token,
   window geometry/detection, OCR ownership, offer-surface state, statistics,
   Tauri window behavior, and production configuration. Do **not** touch the
   scoring-parity twins (`src/lib/scoring/`, `overlay/src/scoring/`).
8. If — and only if — a *specific* lifecycle refinement from the stale line is
   genuinely absent from canonical, apply just that delta **on top of canonical**.
   Diff the actual files before assuming any gap; the `liveGamePoll.ts` diff has
   historically been empty. Do not resurrect stale product code to obtain it.
9. Show the **final diff against the resolved base**:
   ```bash
   git diff "$CANONICAL_TIP"
   ```
10. Run the **canonical test inventory** in the new worktree and report the
    numbers you actually observe — do not assert counts copied from a document.
    Address it absolutely; a bare `cd overlay` depends on where you happen to be:
    ```bash
    (cd "$WORKTREE_DIR/overlay" && npx vitest run)
    (cd "$WORKTREE_DIR" && npx tsc --noEmit -p overlay/tsconfig.json)
    (cd "$WORKTREE_DIR" && npx vitest run)
    # Rust changes only: cargo build --release + binary timestamp check
    ```
11. **Launch from the new worktree** to validate visually:
    ```bash
    # with League in a live ARAM match
    (cd "$WORKTREE_DIR/overlay" && MAYHEM_OVERLAY_TIER_FIXTURE=1 npm run tauri dev)
    ```
    The fixture flag (or real member auth) is **required** — local overlay
    content is authorized by a member entitlement or by the explicit flag, never
    by a development build alone, so a bare `npm run tauri dev` correctly renders
    no badges.
    Acceptance: compact cards anchored to the game window; CALIBRATION shows the
    real game window at scale 1.00 once League is live; `S+/S/A/B/C` badges with
    win-rate; member coach authenticated when `MAYHEM_DEVICE_TOKEN` is set.

## Hard stops

Stop before any **push, PR update, merge, force-push, history rewrite, worktree
deletion, or publication**. **Do not modify PR #46** (`feat/overlay-tier-card` →
`main`). The local canonical tip is ahead of the pushed PR head; pushing it would
alter the PR. Report your diff and test results and wait.

## Likely conclusion

The most probable correct outcome is: **no code change is required** — the
lifecycle fix is already correctly integrated on canonical. Your deliverable is
the validation evidence plus explicit confirmation that the stale recovery line
should not be used as a base.
