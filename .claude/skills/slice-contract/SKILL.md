---
name: slice-contract
description: Run one bounded, evidence-backed engineering slice in this repository under a hard scope cap. Use when a session must pin evidence, verify inherited claims, localize a root cause, write red tests at the true seam, implement under a cap, and hand the operator a committable package — or terminate honestly instead. Covers evidence pinning, phase reports, test freezing, gate lists, subagent briefing, diagnostic-only instrumentation, and live-validation acceptance.
---

# Slice Contract

One slice = one bounded change, one gate package, one terminal state. The
caller supplies about ten lines; every other rule below is fixed and is not
the caller's to relax.

These rules were derived empirically. Each exists because a session lost work
or reached a wrong conclusion without it.

## Caller input

The caller supplies exactly this, and nothing here may be inferred:

1. **Goal** — one paragraph, in observable terms.
2. **Worktree** — absolute path.
3. **Pinned evidence** — absolute source paths of the authoritative artifacts.
4. **Scope caps** — max files per category (production TS / Rust / test /
   docs), stated as numbers.
5. **Authorized categories** — which of those categories may be touched at all.
6. **Forbidden list** — paths and behaviors that are out of bounds.
7. **Verification override**, if the root floor does not apply.
8. **Git-write policy** — normally forbidden; the operator owns commits.

Anything the caller did not authorize is unauthorized. Silence is not a grant.

## 0. Worktree safety — before the first writer

Run these before anything writes:

```bash
git status --short --branch
git rev-parse HEAD
```

Record them to `.codex/gates/<slice>/baseline-head.txt` and
`baseline-status.txt`, plus `git diff > baseline-tracked.diff` and
`git diff --staged > baseline-staged.diff`.

- **Git writes are forbidden** unless the caller grants them: no `add`,
  `commit`, `push`, `merge`, `rebase`, `reset`, `restore`, `checkout`,
  `switch`, `clean`, `stash`, `amend`, `cherry-pick`, `revert`, `tag`, `gc`,
  `prune`, `worktree add/remove`. Read-only git (`status`, `diff`, `log`,
  `show`, `rev-parse`, `ls-files`, `describe`, `check-ignore`,
  `diff --check`) is always allowed.
- If an approved file is **already dirty** at baseline, copy it byte-exact to
  `.codex/gates/<slice>/baseline-files/` first. Without that copy you cannot
  later separate your lines from the operator's, and the COMMIT-CHECKLIST
  cannot warn them truthfully.
- **One writer at a time.** Never run two agents that may touch the same file.
- Preserve every unrelated file. At the end, diff final `git status` against
  the baseline: every delta must be an approved path, or the slice is over
  scope. Add `--ignored` to that comparison whenever a deliverable lands under
  an ignored path — plain `git status` will not show it (§14).

## 1. Evidence pinning — before Phase 0

Pin every authoritative artifact into `.codex/evidence/<slice>/` before any
analysis. For each, record source path, timestamp, SHA-256, and byte size in
`.codex/evidence/<slice>/pinned-manifest.md`:

```bash
/usr/bin/stat -f "%Sm %z %N" <source>
/usr/bin/shasum -a 256 <source>
```

- **Never read evidence from `/tmp`.** Recorder traces land there and are
  rotated, truncated, and overwritten by the next launch. A number derived
  from an unpinned `/tmp` file is not re-derivable and is worthless as proof.
- **Never glob for "the newest matching file."** Name the exact file. A
  newest-match resolves differently on the next run and silently swaps the
  evidence under a conclusion.
- Re-verify with `/usr/bin/shasum -a 256 -c` at the start of every phase that
  consumes evidence. A hash mismatch invalidates every number already derived
  from that file; re-derive, do not reconcile.
- Session artifacts (phase reports, logs, diffs, checklists) go to
  `.codex/gates/<slice>/`. Evidence and artifacts never share a directory.

## 2. Step Zero — verify inherited claims

Every inherited claim is a hypothesis until it is re-derived from the pinned
artifacts. This includes claims from handoff docs, from a prior gate package,
from a prior session's "pinned facts", and **from the caller's own prompt**.

1. Enumerate the claims as a numbered list, each with its source location.
2. Verify each against the pinned artifacts by a command whose output you
   record verbatim.
3. Mark each **CONFIRMED**, **CORRECTED** (state the true value and the
   command that produced it), or **UNVERIFIABLE** (state what artifact would
   decide it).
4. **A contradicted claim is discarded wholesale, not patched.** Do not carry
   a repaired version forward unless the repair is itself derived from a
   pinned artifact.
5. If a discarded claim was load-bearing for the caller's scope, re-derive the
   scope before building anything on it.

Write this to `.codex/gates/<slice>/step-zero.md` before Phase 0 starts. Two
consecutive sessions found real errors in inherited "verified facts" — one
corrected two of the operator's own pinned facts, another discarded an
inherited statement that Live Client Data was unavailable all game. Both
would have produced wrong work if trusted.

## 3. Phases

| Phase | Purpose | Report |
| --- | --- | --- |
| 0 | Evidence settlement — **only when a classification must be established** before scope can be chosen | `phase0-settlement.md` |
| 1 | Root cause — localize and quantify the mechanism | `phase1-root-cause.md` |
| 2 | Red tests at the true seam | `red-acceptance.md` |
| 3 | Implementation under the cap | `final.diff` |
| 4 | Independent verification | `phase4-independent-verification.md`, `gate-log.md` |

**Each phase's report is written to the gate directory before the next phase
starts.** A phase that has not been written down has not happened, and cannot
be inherited by whoever resumes.

Skip Phase 0 when the caller's evidence already settles the classification.
Never skip Phase 1: an implementation without a written mechanism is a guess.

## 4. Persist before proceed

Order of writes to disk, non-negotiable:

1. Baseline (§0) — before the first writer.
2. Pinned manifest (§1) — before Phase 0.
3. Each phase report — before the next phase begins.
4. `red.log` + `frozen-tests.sha256` — before implementation begins.
5. `green.log`, `final.diff`, `gate-log.md` — before the contract.
6. `contract.md` and `COMMIT-CHECKLIST.md` — last.

**After any compaction, crash, quota stop, or resume: re-read
`.codex/gates/<slice>/` before acting.** Files on disk are the state of
record; recollection is not. Re-verify the pinned hashes in the same pass.
Never restate a number from memory that a file already holds.

## 5. True-seam testing

A test must reproduce the proven failure **at the stage where it occurs**.

- **Substituting a reachable downstream seam for an upstream defect is
  forbidden.** This is the *synthetic-green* failure mode: the suite is green,
  the defect is untouched, and the green is evidence of nothing. Example: a
  TypeScript reducer test standing in for a defect in the Rust capture call
  that never reaches the reducer.
- The test must fail for the **same reason** as the live failure, not merely
  in the same file.
- **If no fixture can reach the true seam, do not write the test.** Route to
  the diagnostic-only branch (§9). Weakening the target to make a test
  possible is the failure this rule exists to prevent.

## 6. Red validity

Red means: the suite **compiles, executes, and fails on runtime assertions.**

- `tsc --noEmit` is clean and `cargo test` compiles **in the red state**.
- **A compile error is not an acceptable red.** Use the repo's soft-adapter
  pattern so tests compile before the symbol exists: dynamic symbol lookup off
  the module namespace in TypeScript; `serde_json::to_value` plus
  `value.get(..).is_some()` in Rust.
- Forbidden: sleeps as timing proof; weakened assertions; skipped or `todo`
  tests; `any`, `ts-ignore`, or `eslint-disable` used to suppress a failure;
  assertions over source text instead of behavior.
- Record `red.log` and `green.log` with per-file pass/fail counts on both
  sides. State in `red-acceptance.md` that **every new assertion failed
  first**, with the counts that show it.

## 7. Freeze by SHA-256

After red acceptance, hash every test file into
`.codex/gates/<slice>/frozen-tests.sha256`:

```bash
/usr/bin/shasum -a 256 <each test file> > .codex/gates/<slice>/frozen-tests.sha256
```

**The implementer may not edit tests.** Re-verify with
`/usr/bin/shasum -a 256 -c` at every subsequent gate.

One legitimate exception, observed in practice: **formatter-only reformatting
of a frozen file**, when a formatter gate (`cargo fmt --check`) fails on the
frozen test and the production files are already clean. It must be done by the
**freeze owner**, not the implementer: back the file up, run the formatter on
that one file, `/usr/bin/diff` the two to prove no assertion, literal, or
comparison changed, re-run the gates, then re-freeze with a note recording
what changed. Nothing else reopens a frozen file.

## 8. Scope caps and escalation

- **Caps are hard, not defaults.** They count distinct files touched per
  category, not lines.
- A file being already dirty is not permission to touch it.
- Exceeding a cap, or needing a category the caller did not authorize (Rust is
  the usual one), produces **PAUSED** (§13): the full report, the exact cap
  that would be exceeded and by how much, the minimal grant being requested,
  and **zero code changes** — proven by `git status`.
- **Never self-grant scope.** A cap raised without an operator message is a
  contract violation regardless of how good the change was.

## 9. Diagnostic-only branch

Enter when the evidence cannot prove which stage fails. Ship the smallest
instrumentation that makes the **next** run decisive; do not ship a
speculative fix.

Requirements, all mandatory:

1. **Automated proof** — tests at the true seam of the instrument itself,
   proving each new field is emitted and carries what it claims.
2. **Dev-only guarding** — `import.meta.env.DEV` (TypeScript),
   `#[cfg(debug_assertions)]` (Rust).
3. **Production-strip check** — grep the fresh production bundle / release
   binary for the new token and assert zero occurrences. Run it against a
   build produced *after* the change:
   `/usr/bin/strings -a <binary> | /usr/bin/grep -c "<token>"`.
4. **Decision matrix** — in the acceptance checklist, one row per possible
   outcome, stating what it would mean. Include the row that would **refute**
   the current hypothesis.
5. **Document each field's cause at its definition site.** A field that reads
   near zero for a reason unrelated to the hypothesis will be misread as proof
   of health. One slice shipped three doc sites claiming a counter measured
   async-runtime starvation when it measured blocking-pool queue latency; left
   uncorrected, the next run would have concluded the opposite of the truth.

State plainly, in the contract and the checklist, that the slice does **not**
fix the problem — and that a lucky passing run is noise, not evidence.

## 10. Unattended rule

**Never pause to wait for the operator.** There is no one to answer mid-run.
When you need something you do not have, finish everything that does not
depend on it, then terminate through §13 with a report the operator can act
on. The report is the message.

## 11. Subagent briefing

**Subagents inherit nothing** — not the conversation, not the evidence, not
the invariants, not the prohibitions. Pass verbatim, in every brief:

1. Worktree absolute path and the full git-write prohibition (§0).
2. The repository invariants that bound the work — reference the ARAM Mayhem
   augment cardinality invariant in `CLAUDE.md` by name; do not restate or
   reinterpret it.
3. The forbidden list, in full.
4. **That agent's** approved paths, exactly — not the slice's whole list.
5. Its exact finish condition and the absolute path of the artifact it must
   write.
6. The sentence: *you inherit nothing; verify every claim in this brief
   against the pinned artifacts before using it.*

For a verification subagent, add: **read-only**, and the task is to
**falsify** the claims, not to confirm them. A verifier told to confirm will
confirm.

## 12. Gate lists

Run the narrowest check that proves the change, then the full list for the
change type. **Gates are re-run by a hand other than the implementer's**; the
implementer's reported results are recorded, not trusted.

**Docs / tooling only**

```bash
git diff --check
```
Plus: the touched script's own test suite, and every command the docs tell a
human to run, executed for real wherever it is read-only.

**TypeScript only**

```bash
npm test                       # root
npx eslint <touched paths>
npm run build
# overlay-local:
cd overlay && npx vitest run && npx tsc --noEmit && npm run build
```

**TypeScript + Rust** — everything above, plus, from `overlay/`:

```bash
cargo fmt --check
cargo test
cargo check
npx tauri build
stat -f "%Sm %N" src-tauri/target/release/mayhem-oracle-overlay
```

`cargo check` alone is **insufficient** for a Rust change. The release build
is mandatory, and the binary timestamp must be compared to the wall clock
immediately after the build — a stale binary fails the gate.

Dev-only instrumentation adds the production-strip check (§9.3).

**Evidence capture uses absolute tool paths** — `/usr/bin/diff`,
`/usr/bin/grep`, `/usr/bin/wc`, `/usr/bin/shasum`, `/usr/bin/stat` — because
the rtk shell hook has returned wrong results for the bare commands. When
output is proof, the bare name is not acceptable.

Record every gate in `gate-log.md` as a table: number, gate, exact command,
result. Report every skipped or blocked gate; a silent skip is a false green.

## 13. Terminal states

Exactly one, stated in the first line of `contract.md`.

| State | Meaning | Required artifacts |
| --- | --- | --- |
| **COMPLETE** | The slice shipped and all gates are green | `contract.md`, all phase reports, `red-acceptance.md`, `frozen-tests.sha256`, `final.diff`, `gate-log.md`, `COMMIT-CHECKLIST.md`, plus the acceptance checklist if a live run is required |
| **PAUSED (scope)** | The work needs a cap or category the caller did not grant | Phase report, the exact overage, the minimal grant requested, `git status` proving zero code changes |
| **BLOCKED (operator input)** | A product or policy decision is required | The decision, options with a recommended default, and what is already built and safe to keep |
| **BLOCKED (insufficient evidence)** | The pinned evidence cannot decide the question | What was pinned, precisely what it cannot prove, and the exact next capture that would decide it — a diagnostic-only slice (§9) or a live-run spec (§16) |

COMPLETE is a statement about gates, not about the problem. A diagnostic slice
completes without fixing anything, and must say so in its first paragraph.

## 14. Final package

`.codex/gates/<slice>/` contains, at minimum:

```
contract.md                 baseline-head.txt      red.log
step-zero.md                baseline-status.txt    green.log
phase1-root-cause.md        baseline-staged.diff   final.diff
red-acceptance.md           frozen-tests.sha256    gate-log.md
COMMIT-CHECKLIST.md
```

`contract.md` states, in order: terminal state, what shipped, what did **not**
ship, the root cause as understood, invariants preserved, compliance
statement, and verification findings with their disposition.

`COMMIT-CHECKLIST.md` names **exact files** from
`git status --short --untracked-files=all`, split modified vs new, with the
diffstat. **When an approved file carried pre-existing uncommitted work at
baseline, say so at the top**: state which lines are the slice's and which
were already there, because the operator is committing both. Use the baseline
copies from §0 to prove the split. Skeletons: `templates.md`.

**That status command omits ignored files.** If any deliverable sits under an
ignored path, it is absent from every integrity view in the package — the
report understates the change set instead of overstating it, which is the
opposite of what it is for. Enumerate those files explicitly, with SHA-256,
labelled *ignored but intended*, and show the command that surfaces them:

```bash
git status --short --ignored --untracked-files=all -- <path>
```

Then hand the operator a force-add naming **every path individually**. Never
`git add -f <dir>` or `<dir>/*`: the rule that ignores the directory usually
exists to keep something large or machine-local out of the repo, and both
forms sweep it into the index. Say in the checklist *why* the `-f` is there —
the reader six months later has no idea. A force-add fixes only the files it
names; anything added under that path later is invisible again, so record the
durable ignore-rule fix as a follow-up with its reasoning, not just its diff.

## 15. Operator instructions must be literal

Every command handed to a human contains **real values**. Never
`PID_FROM_PREFLIGHT`, `SESSION_DIR`, `<fill in>`, or `EXACT_..._PID`. Two
sessions lost time to placeholders pasted verbatim into a shell.

When a value is not knowable at write time, put the command that produces it
on the line immediately above, and show the substitution — do not leave the
reader to invent it.

## 16. Live validation

When the proof requires a real run, the acceptance checklist must name:

- **The recorder workflow** — `.codex/skills/test-league-augment-overlay`,
  invoked exactly as its SKILL.md documents. Do not improvise a launch.
- **Exact preconditions**, including **dev vs release build**: instrumentation
  guarded by `#[cfg(debug_assertions)]` is compiled out of release binaries
  and a release run emits nothing at all. Say which build, and why.
- **Authorization state confirmed before the run starts** — one prior run was
  wasted because authorization was silently false for the whole session.
- **The operator's own recorded windows** for each event of interest, with the
  video↔game offset, in the same format the prior run used. Statistics that
  need per-interval attribution are underivable without them.
- **Sanity checks on the instrument itself**, listed before any reading of its
  numbers. An instrument that already misbehaves during the healthy phase
  invalidates the run.
- **A second confirmation run before merge** whenever the failure is latency-
  or timing-coupled. A single passing game is not evidence against a history
  of failing ones.

Pin the run's artifacts under `.codex/evidence/<slice>-live/` (§1) so the next
session re-derives every number instead of inheriting a claim.

## Compliance

Overlay work is compliance-sensitive: no game automation, no hidden-
information access, no client injection, and League is never launched by an
agent. State this explicitly in `contract.md`, alongside the confirmation that
no git write ran.
