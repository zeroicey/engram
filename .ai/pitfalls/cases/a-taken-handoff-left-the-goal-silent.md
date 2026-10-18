# A taken handoff left the goal silent

**Severity:** 🔴 high · **First hit:** 2026-10-18 · **Hits since:** 0

## Symptom

Not a crash and not a wrong value — a **missing** one. After a successful handoff the successor
received the baton, the brief, and then no nudges at all. And 24 hours later the goal would have
escalated:

```
stuck: handoff was requested but never taken (asked 2026-10-18T21:31:00.000Z).
```

about a handoff that *had* been taken.

## Root cause

`pendingHandoff` means "a handoff is owed". Two places read it, both as a mute switch:

- `onSettled` → `silent('handoff-requested')`: while a handoff is pending the continuation guard
  returns nothing, so the goal is never nudged.
- `onReconcile` → escalate `REASON_HANDOFF_STALE` once the liveness window passes.

`goal baton` moved the holder and left `pendingHandoff` untouched. The only thing that cleared it was
the successor's own first **`progress`** report — which a successor that immediately hits a blocker,
or waits, or hands off again never sends. So the common case was: handoff succeeds, successor works,
successor is never nudged, and the human is paged about a handoff that landed.

The general shape, same family as
`.ai/pitfalls/cases/asymmetric-guards-and-leaked-effects.md`: **a state that means "owed" was
established on one side of a transition and never retired on the other.**

## Fix

`runGoalBaton` (in `src/commands/goal.ts`) clears `pendingHandoff` when it moves the baton, because
taking the baton *is* taking the handoff.

The rollback path is the deliberate exception, and it is why the undo does not reuse `runGoalBaton`:
a failed handoff returns the baton to the predecessor and **restores** the request the reducer wrote,
because that handoff was *not* taken. Clearing it there would erase the only evidence that a handoff
was attempted and did not land.

## Guard

- `test/goal-handoff.test.ts` — *"a handoff opens a pane, starts pi, transfers the baton, then
  prompts"* asserts `pendingHandoff === null` after a successful handoff; *"a successor that never
  received the brief does not keep the baton"* asserts it is **not** null after a failed one.
- `test/goal-handoff.test.ts` — *"taking the baton clears a pending handoff, and says so"* pins the
  `goal baton` path, and the command prints `pending handoff cleared — it was taken, not abandoned`
  so the transition is visible rather than implied.
- Review question for any future `pending*` field: **which transition retires it, on every path?**
  A field that is only ever set, or only ever cleared by the *other* party's good behaviour, is this
  bug waiting to happen.
