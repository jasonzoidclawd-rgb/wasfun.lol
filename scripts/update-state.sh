#!/usr/bin/env bash
# Regenerate scripts/state.json and the CLAUDE.md <!-- STATE --> block.
# Installed as a post-commit hook by scripts/install-hooks.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

REPORT=$(mktemp)
trap 'rm -f "$REPORT"' EXIT

if ! ./node_modules/.bin/vitest run --reporter=json > "$REPORT"; then
  echo "Refusing to update state from a failed test run" >&2
  exit 1
fi

# Two clocks, recorded separately. `meta.json` is the STATISTICS clock; the
# structural (current game) patch comes from the pipeline status. Collapsing
# them into one "Patch:" line is the same conflation this slice removed from
# the product surfaces.
PATCH=$(python3 -c "import json; print(json.load(open('public/data/meta.json'))['patch'])")
STRUCTURAL_PATCH=$(python3 -c "
import json
try:
    print(json.load(open('public/data/pipeline-status.json'))['structural']['patch'] or 'unknown')
except Exception:
    print('unknown')
")
# Live augments (offerable now) and known entities (everything we track) are
# different populations and are never published under one bare number.
AUGMENTS=$(python3 -c "
import json
rows = json.load(open('public/data/augments.json'))['augments']
print(sum(1 for r in rows if (r.get('availability') or {}).get('status') == 'confirmed_live'))
")
KNOWN_AUGMENTS=$(python3 -c "import json; print(len(json.load(open('public/data/augments.json'))['augments']))")
TESTS=$(python3 - "$REPORT" <<'PY'
import json
import sys

text = open(sys.argv[1], encoding="utf-8").read()
start = text.find("{")
if start == -1:
    raise SystemExit("Vitest JSON report was not found")
report = json.loads(text[start:])
if not report.get("success") or report.get("numFailedTests") != 0:
    raise SystemExit("Refusing to update state from a failed test run")
print(report["numPassedTests"])
PY
)
PARITY=$(/usr/bin/grep -o 'PARITY_BUDGET = [0-9]*' src/lib/__tests__/cross-parity.test.ts | /usr/bin/grep -o '[0-9]*$')
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "none")

PATCH="$PATCH" STRUCTURAL_PATCH="$STRUCTURAL_PATCH" AUGMENTS="$AUGMENTS" KNOWN_AUGMENTS="$KNOWN_AUGMENTS" TESTS="$TESTS" PARITY="$PARITY" LAST_TAG="$LAST_TAG" python3 << 'PY'
import json
import os
import re

state = {
    "structuralPatch": os.environ["STRUCTURAL_PATCH"],
    "patch": os.environ["PATCH"],
    "augments": int(os.environ["AUGMENTS"]),
    "knownAugments": int(os.environ["KNOWN_AUGMENTS"]),
    "tests": os.environ["TESTS"],
    "parityBudget": int(os.environ["PARITY"]),
    "lastTag": os.environ["LAST_TAG"],
}
with open("scripts/state.json", "w", encoding="utf-8") as f:
    json.dump(state, f, indent=2)
    f.write("\n")

block = (
    "<!-- STATE:START -->\n"
    f"- Game patch (structural): `{state['structuralPatch']}`\n"
    f"- Statistics patch: `{state['patch']}`\n"
    f"- Live augments: `{state['augments']}`\n"
    f"- Known augment entities: `{state['knownAugments']}`\n"
    f"- Tests passing: `{state['tests']}`\n"
    f"- Cross-parity budget: `{state['parityBudget']}` divergent champions\n"
    f"- Last tag: `{state['lastTag']}`\n"
    "<!-- STATE:END -->"
)
path = "CLAUDE.md"
text = open(path, encoding="utf-8").read()
updated = re.sub(r"<!-- STATE:START -->.*?<!-- STATE:END -->", block, text, flags=re.DOTALL)
if "<!-- STATE:START -->" not in text:
    raise SystemExit("CLAUDE.md is missing the STATE sentinel block")
open(path, "w", encoding="utf-8").write(updated)
print(f"state: structural={state['structuralPatch']} statistics={state['patch']} "
      f"live_augments={state['augments']} known={state['knownAugments']} "
      f"tests={state['tests']} parity={state['parityBudget']} tag={state['lastTag']}")
PY
