# The goal is a slice of the project, not a second CURRENT_TASK

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey

## Context

Adding the goal engine gave the memory bank two things that both answer "what am I working on":

| | `.ai/CURRENT_TASK.md` | `.ai/goal/<id>/` |
| --- | --- | --- |
| Written by | a human, and the agent at settlement | **only the engine** (`goal.json`), plus the model for `BRIEF.md` |
| Lifetime | durable — survives every goal | one bounded run, then closed and kept as a record |
| Judged | by a reader | by a machine, against `done_when` |
| Shape | status, project goal, milestone checklist, code state, blockers, next action | `BRIEF.md` (project/run goal + `done_when`), `TASKS.md` (the run's checklist) |

The user noticed the overlap from the outside: "我感觉它们两个说的是同一个东西了" — and asked what a goal
for a *task list* item (not development, not research) has to do with `CURRENT_TASK.md`.

The overlap was real and not only conceptual. `dump` printed **two lines labelled `goal`** in one
1400-byte digest:

```text
NOW
goal: Make an agent able to run for hours or days without a human present: …
GOAL
  goal: L2 wake transport: an in-process timer, so a time wait of minutes needs no systemd unit
```

A fresh session reading that is told there are two tasks and not which one to work on — the exact
failure the GOAL block was added to prevent, created by the block's own label.

## Decision

1. **They are different scopes, and the words are different.** `CURRENT_TASK.md` is **where the project
   stands**; a goal is **the current run**. Nothing in the bank calls both of them a goal.
   - The fingerprint line is `project:` and the GOAL block's text line is `run:`
     (`core/fingerprint.ts`). Same bytes, no ambiguity.
2. **A goal is a slice of `CURRENT_TASK.md`, never a copy of it.** A goal may serve any of the
   checklist items — research, development, or a task-list item that is neither — because it says only
   *what the run must produce*, not what the project is. The item it serves stays in `CURRENT_TASK.md`.
3. **`TASKS.md` is the only checklist a verdict may gate on.** `done_when: {kind: checklist}` reads
   `.ai/goal/<id>/TASKS.md`. `CURRENT_TASK.md`'s checklist is a **roadmap** and is never a gate: a
   milestone list that a machine judges would freeze the project's direction into a test.
4. **`Next action` belongs to the project; the run's steps belong to the goal.** While a goal is
   active, the goal is the only "what to do now" — `CURRENT_TASK`'s next action must not restate the
   run's plan, and `BRIEF.md`'s "## Not the goal" is where a route is explicitly excluded.
5. **Settlement writes back to both.** Closing a goal ticks the milestone it served in
   `CURRENT_TASK.md` and sets the new next action. `goal.json` records the run; `CURRENT_TASK.md`
   records what changed about the project. That is the existing definition-of-done rule (a change that
   the bank records is written back in the same change), applied to goals.
6. **One goal per project, and it outranks the roadmap in the fingerprint.** Already true
   (`sections.push` before `BINDING`), and it is what makes rule 4 safe: while a run is live, the run
   is what a fresh session sees first.

## Consequences

- A goal for a "task list" item is legitimate and needs no special handling: the run says what it must
  produce, the project says which item it serves.
- Two checklists exist with two jobs, named: roadmap (`CURRENT_TASK.md`) vs gate (`TASKS.md`).
- The remaining duplication risk is prose, not structure — if `CURRENT_TASK.md`'s goal paragraph is
  rewritten to describe the *current run*, the two do say the same thing again. That is a review
  question, not something a test can see, so it is in the `audit` skill's remit.

## Revisit when

- A project genuinely wants several concurrent runs. Today one goal per project is the design
  (`.ai/decisions/2026-10-18-scope-the-goal-to-the-project-with-a-single-baton-and-no-wor.md`), and it
  is what makes "the run outranks the roadmap" unambiguous.
- `CURRENT_TASK.md` grows a machine-read field, which would make it an engine input rather than prose.
