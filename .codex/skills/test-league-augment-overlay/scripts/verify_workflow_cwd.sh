#!/usr/bin/env bash
# Prove the validation workflow documented in SKILL.md runs from the repository
# root: the overlay launch is scoped to `overlay/` without moving the workflow
# shell, and every documented script, repo argument, and package path resolves
# from that root.
#
# Read-only: it starts no overlay, records nothing, and touches no Git state.
#
#   bash .codex/skills/test-league-augment-overlay/scripts/verify_workflow_cwd.sh
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
SKILL="$SKILL_DIR/SKILL.md"
REPO="$(cd "$SKILL_DIR/../../.." && pwd -P)"
SCRIPTS="$SKILL_DIR/scripts"
failures=0

check() {
  if [ "$2" = "$3" ]; then
    printf 'ok    %s\n' "$1"
  else
    printf 'FAIL  %s\n        expected: %s\n        actual:   %s\n' "$1" "$3" "$2" >&2
    failures=$((failures + 1))
  fi
}

echo "repository root: $REPO"
echo

# ── 1. The canonical launch scopes to overlay/ without moving the shell ──────
cd "$REPO"
BEFORE="$PWD"

# `npm --prefix overlay` is an npm-only flag; prove it actually resolves the
# overlay package (not the repository root) rather than merely trusting the
# documentation. `pkg get name` reads package.json and runs no script, so
# nothing is launched.
OVERLAY_NAME="$(npm --prefix overlay pkg get name 2>/dev/null | tr -d '"[:space:]')"
check "npm --prefix overlay resolves the overlay package" "$OVERLAY_NAME" \
  "mayhem-oracle-overlay"
check "the workflow shell stays at the repository root" "$PWD" "$BEFORE"
check "the workflow shell is the repository root" "$PWD" "$REPO"

# The env-unset/assignment clause, exercised for real with harmless synthetic
# placeholders standing in for credentials — never real values. This proves
# the documented command strips both variables even when the launching shell
# already has them set, and that the flags and cwd land as documented. No
# value is ever printed; only presence booleans and cwd/flag strings are.
CRED_PROBE="$(
  export MAYHEM_TELEMETRY_ENDPOINT="https://example.invalid/collect"
  export MAYHEM_DEVICE_TOKEN="placeholder-device-token"
  env -u MAYHEM_TELEMETRY_ENDPOINT -u MAYHEM_DEVICE_TOKEN \
    MAYHEM_OVERLAY_TRACE=1 \
    MAYHEM_OVERLAY_TIER_FIXTURE=1 \
    bash -c 'printf "trace=%s fixture=%s telemetry=%s token=%s pwd=%s" \
      "${MAYHEM_OVERLAY_TRACE-unset}" "${MAYHEM_OVERLAY_TIER_FIXTURE-unset}" \
      "${MAYHEM_TELEMETRY_ENDPOINT+set}" "${MAYHEM_DEVICE_TOKEN+set}" "$PWD"'
)"
check "the canonical env clause strips credentials and sets both flags" \
  "$CRED_PROBE" "trace=1 fixture=1 telemetry= token= pwd=$REPO"

# ── 2. Every documented path resolves from the repository root ───────────────
for rel in \
  .codex/skills/test-league-augment-overlay/scripts/preflight.py \
  .codex/skills/test-league-augment-overlay/scripts/record_session.py \
  .codex/skills/test-league-augment-overlay/scripts/analyze_trace.py \
  .codex/skills/test-league-augment-overlay/scripts/extract_event_frames.py \
  .codex/skills/test-league-augment-overlay/references/validation-protocol.md \
  overlay/package.json
do
  check "resolves from the root: $rel" \
    "$([ -f "$PWD/$rel" ] && echo present || echo missing)" "present"
done

# Every script SKILL.md invokes must exist at the path SKILL.md gives.
while IFS= read -r rel; do
  check "SKILL.md path exists: $rel" \
    "$([ -f "$PWD/$rel" ] && echo present || echo missing)" "present"
done < <(grep -oE '\.codex/skills/[^ )`"]+\.py' "$SKILL" | sort -u)

# ── 3. The doubled path the old instructions produced is never consulted ─────
# Run from `overlay/`, `--repo "$PWD"` made preflight look for
# overlay/overlay/package.json. It does not exist, which is exactly why the
# workflow stopped before recording.
check "overlay/overlay/package.json does not exist" \
  "$([ -e "$PWD/overlay/overlay/package.json" ] && echo present || echo absent)" \
  "absent"
check "no .codex tree exists under overlay/" \
  "$([ -e "$PWD/overlay/.codex" ] && echo present || echo absent)" "absent"
check "the documented --repo root holds overlay/package.json" \
  "$([ -f "$PWD/overlay/package.json" ] && echo present || echo missing)" "present"

# ── 4. The documented commands actually resolve and parse ───────────────────
# `--help` proves the interpreter finds the script from the repository root
# without starting a recording or inspecting any process.
for script in preflight record_session; do
  check "documented command runs: $script.py --help" \
    "$(python3 ".codex/skills/test-league-augment-overlay/scripts/$script.py" --help \
        >/dev/null 2>&1 && echo ok || echo failed)" "ok"
done

# ── 5. SKILL.md documents the root-first sequence ───────────────────────────
for needle in \
  'REPO="/Users/jason/Desktop/mayhem-oracle/.claude/worktrees/overlay-tier-card"' \
  'cd "$REPO"' \
  '--repo "$REPO" --require-overlay' \
  '--repo "$REPO" \'
do
  check "SKILL.md documents: $needle" \
    "$(grep -Fq -- "$needle" "$SKILL" && echo present || echo missing)" "present"
done

check "no command passes --repo \"\$PWD\"" \
  "$(grep -Fq -- '--repo "$PWD"' "$SKILL" && echo found || echo none)" "none"
check "no instruction says to run the workflow from overlay/" \
  "$(grep -Eq 'overlay (from|in) `overlay/`|from `overlay/` with' "$SKILL" \
      && echo found || echo none)" "none"

# ── 6. Exactly ONE overlay dev-launch invocation is documented, and it is  ───
# ── the complete safe command — not a second, subtly different one-liner. ───
# Extract every fenced bash block that actually launches the overlay and
# require there be exactly one; then require that single block to carry every
# safety clause. A stripped-down "equivalent" missing the env guard, the
# trace/fixture flags, or the tee log can never pass this.
LAUNCH_BLOCKS="$(awk '
  /^[[:space:]]*```bash[[:space:]]*$/ { buf=""; incode=1; next }
  /^[[:space:]]*```[[:space:]]*$/ { if (incode && buf ~ /npm .*run tauri -- dev/) { print "-----BLOCK-----"; print buf }
            incode=0; next }
  incode { buf = buf $0 "\n" }
' "$SKILL")"
check "exactly one overlay dev-launch command block is documented" \
  "$(printf '%s\n' "$LAUNCH_BLOCKS" | grep -c -- '-----BLOCK-----')" "1"

for needle in \
  'env -u MAYHEM_TELEMETRY_ENDPOINT -u MAYHEM_DEVICE_TOKEN' \
  'MAYHEM_OVERLAY_TRACE=1' \
  'MAYHEM_OVERLAY_TIER_FIXTURE=1' \
  'npm --prefix overlay run tauri -- dev 2>&1' \
  '/usr/bin/tee "/tmp/mayhem-overlay-$(date +%Y%m%d-%H%M%S).log"'
do
  check "the documented launch includes: $needle" \
    "$(printf '%s\n' "$LAUNCH_BLOCKS" | grep -Fq -- "$needle" && echo present || echo missing)" \
    "present"
done

# The old two-command form (a `cd overlay` subshell plus a separate stripped
# "equivalent one-liner" lacking the safety clauses) must not reappear.
check "no leftover 'cd overlay' launch subshell remains" \
  "$(grep -cE '^[[:space:]]*cd overlay[[:space:]]*$' "$SKILL")" "0"
check "no second, incomplete launch one-liner remains" \
  "$(grep -cE 'npm (--prefix overlay run|run) tauri -- dev' "$SKILL")" "1"

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all checks passed"
