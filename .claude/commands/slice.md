---
description: Run one bounded engineering slice under the slice-contract rules
argument-hint: goal / worktree / pinned evidence / scope caps / authorized categories / forbidden list
---

Invoke the `slice-contract` skill and follow it exactly. It supplies every
rule; the lines below supply only the caller input its "Caller input" section
requires.

Caller input for this slice:

$ARGUMENTS

Before starting, resolve any of the eight caller-input fields the text above
left unset. Do not infer a scope cap, an authorized category, or a git-write
grant from silence — an unstated field is unauthorized, and the skill's
PAUSED terminal state is the correct response to needing one.
