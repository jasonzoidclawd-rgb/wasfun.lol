# Slice-contract templates

Skeletons referenced by `SKILL.md`. Copy, fill, delete nothing structural.
`<slice>` is the slice's kebab-case name and is the same string in
`.codex/evidence/<slice>/` and `.codex/gates/<slice>/`.

---

## `pinned-manifest.md`

```markdown
# Pinned evidence — <slice>

Pinned <ISO date>. Nothing here is read from /tmp; nothing here was resolved
by a newest-match glob.

| # | Artifact | Source path (absolute) | mtime | Bytes | SHA-256 |
| --- | --- | --- | --- | --- | --- |
| 1 | trace | /Users/.../session-.../trace.timestamped.jsonl | ... | ... | ... |

Re-verify before each consuming phase:

    /usr/bin/shasum -a 256 -c .codex/evidence/<slice>/pinned-manifest.sha256
```

---

## `step-zero.md`

```markdown
# Step Zero — inherited-claim verification

| # | Claim | Source | Verdict | Evidence |
| --- | --- | --- | --- | --- |
| 1 | <claim as stated> | <file:line or "caller prompt"> | CONFIRMED / CORRECTED / UNVERIFIABLE | <command + output> |

## Corrections

For each CORRECTED claim: the true value, the command that produced it, and
what downstream reasoning is now discarded.

## Discarded wholesale

<claims that were contradicted, and what was built on them — nothing, if this
report was written before Phase 0 as required>

## Scope consequence

<whether any correction changes the caller's scope, and the re-derivation>
```

---

## `red-acceptance.md`

```markdown
# Phase 2 — red acceptance

## Seam

The proven failure occurs at <stage>. Each test below fails at that stage for
the same reason. No downstream seam was substituted.

## Red state

| Suite | Before implementation | Compiles? | Type-clean? |
| --- | --- | --- | --- |
| <file> | N failed / N total | yes | `tsc --noEmit` exit 0 |

Every new assertion failed first. Raw output: `red.log`.

No sleeps, no weakened assertions, no skipped/todo tests, no `any` /
`ts-ignore` / `eslint-disable`, no assertions over source text.

## Freeze

    /usr/bin/shasum -a 256 <test files> > frozen-tests.sha256

The implementer may not edit these files.
```

---

## `gate-log.md`

```markdown
# Phase 4 — gate log

Gates run by: <implementer (recorded, not trusted)> / <orchestrator> /
<independent verifier>. The authoritative pass is <which>, reflecting the
code as it now stands.

| # | Gate | Command | Result |
| --- | --- | --- | --- |
| 1 | ... | ... | ... |

## Skipped or blocked gates

<every one, with the reason — or "none">

## Frozen test hashes

    /usr/bin/shasum -a 256 -c frozen-tests.sha256   # all OK

## Scope, final

<git status --short --untracked-files=all output, plus the diffstat>
```

---

## `contract.md`

```markdown
# Slice contract — <goal>

Worktree: <absolute path>
Branch: <branch>
Baseline HEAD: <sha>
Final HEAD: <sha> (unchanged — no git write was run)

## Terminal state

**<COMPLETE | PAUSED (scope) | BLOCKED (operator input) | BLOCKED
(insufficient evidence)>**

<One paragraph a reader must not be able to misread. If the slice does not fix
the problem, say so here, first.>

## History

| Phase | Outcome | Artifact |
| --- | --- | --- |

## Root cause as understood

<mechanism, quantified, with the evidence it came from — or an explicit
statement of what remains unknown>

## What shipped

## What this slice does NOT do

## Behavior changes, stated plainly

<Any change that is not pure instrumentation gets its own table: field,
before, after. Trace archaeology depends on it.>

## Invariants — preserved

<Reference the ARAM Mayhem augment cardinality invariant in CLAUDE.md by name.
Do not restate or reinterpret it.>

## Compliance

No game automation, no hidden-information access, no client injection. League
was not launched. No git write command was run — not `add`, `commit`, `push`,
`merge`, `rebase`, `reset`, `restore`, `checkout`, `switch`, `clean`, `stash`,
`amend`, or `worktree add/remove`. Every git invocation was read-only.

## Independent verification — findings and disposition

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |

## Follow-ups recorded, not fixed

<Everything found out of scope. Reported only.>

## Next step
```

---

## `COMMIT-CHECKLIST.md`

```markdown
# COMMIT CHECKLIST — operator action required

**Nothing was committed.** Git writes were forbidden, so the worktree is left
dirty at baseline HEAD `<sha>` and the commit decision is yours.

## Pre-existing work warning

<Delete this section only if no approved file was dirty at baseline.>
`<file>` carried uncommitted work before this slice began. Baseline copy:
`.codex/gates/<slice>/baseline-files/<file>`. Lines <...> are the slice's;
the rest were already there. **Committing the file commits both.**

## What you are committing

<N> modified, <N> new. **<X> insertions, <Y> deletions.**

    M <path>
    ?? <path>

## Before you commit

- [ ] <Each judgement call the operator should agree with before it lands,
      one line each, naming the contract section that explains it.>

## Gates already green (commands and raw results in `gate-log.md`)

- [x] <gate> — <result>

## Suggested commit message

    <type>(<scope>): <subject>

    <body: what it does, what it explicitly does not do, and any behavior
    change stated plainly>

## After committing

- [ ] Tag it, so any live run's artifacts tie to an exact build.
- [ ] <live run instruction, with literal commands — no placeholders>
- [ ] Pin the run's artifacts under `.codex/evidence/<slice>-live/`.
```

---

## Subagent brief

Every field is mandatory. Send verbatim; a subagent inherits nothing.

```markdown
Worktree: <absolute path>. Work only there.

Git writes are forbidden: no add, commit, push, merge, rebase, reset,
restore, checkout, switch, clean, stash, amend, cherry-pick, revert, tag, gc,
prune, worktree add/remove. Read-only git is allowed.

Invariants: follow CLAUDE.md, including the ARAM Mayhem augment cardinality
invariant. Do not restate or reinterpret it.

Forbidden: <full list, verbatim from the caller>

Your approved paths — these and no others:
  <exact paths for THIS agent, not the slice's whole list>

Pinned evidence (read-only, never from /tmp, never resolved by glob):
  <exact absolute paths + SHA-256>

Finish condition: <exactly what "done" means>
Write your report to: <absolute path>

You inherit nothing. Verify every claim in this brief against the pinned
artifacts before using it.
```

For a verification subagent, append:

```markdown
You are READ-ONLY. Change no file.

Your task is to FALSIFY the claims below, not to confirm them. Report each as
refuted, unsupported, or survived, with the command and output that decided
it. A finding you cannot reproduce is not a finding.

Claims to attack:
  <numbered list>
```
