# A restarted pi could not adopt its own goal, so the wait never came back

**Severity:** 🔴 high · **Date:** 2026-10-19

## Symptom

A goal was waiting on a 10-minute timer. The pi process was killed (only pi — the herdr server was left
alone) and a new pi was started in the same pane. The goal stayed `waiting` and the agent stayed `idle`
**for the rest of the observed window**: `02:52:21Z` came and went, `02:59Z` still showed `waiting`. The
goal was recovered only by hand-running `engram goal baton`.

Same run, after the fix: the new pi adopted the goal at session start and the timer fired at
`03:13:14Z` for a wait latched at `03:06:10Z` — exactly the 420 s the model asked for — with no human
intervention. Leg 2 ran in the *new* process and the engine closed the goal on `2 command(s) exited 0`.

## Root cause

`reconcile` was baton-guarded like every other event, and **a restart changes the baton's session file**:

1. pi's session file is created per process (`2026-...Z_01a15209-...` → `..._01a1520b-...`), and
   `goal.json` records the *old* one at creation and at every baton transfer.
2. `holdsBaton` compares session paths, so the new process's `reconcile` was refused:
   `{"reason":"not the baton holder for this goal","effects":[{"kind":"ignore"}]}`.
3. An ignored event produces no `schedule-wake` effect, so the host had no timer.
4. And nothing else would arrive: `waiting` is silent by design, and the only deadline-driven recovery
   (`onReconcile`'s expiry check) is *the very handler that was being refused*.

So the design's own safety rule — one baton, identified — combined with a runtime detail (session files
are per-process) to produce a permanently parked goal. The 24 h liveness deadline could never fire,
because the path that checks it was on the refused side of the guard.

Diagnosed by watching `goal.json.updatedAt` stay frozen while the new process answered prompts normally,
then reproducing the refusal by hand:
`engram goal event --type reconcile --session <new session>` → `not the baton holder`.

## Fix

`reconcile` is the **one** event that may adopt a goal, and only under conditions that make it not a
loophole:

| Condition | Why it is safe |
| --- | --- |
| `record.baton === null` | nothing to displace — a goal created outside a session gets its first holder |
| same `sessionPath` | nothing changed; a `session_start` inside one process |
| **same `paneId`** | the pane is the continuity across a pi restart |

A different pane is refused exactly as before, so an intruder opening the same project cannot take a goal
over — `reconcile` still answers only with `schedule-wake` for them. A closed goal is never adopted.

This works because of the earlier measurement in
`.ai/pitfalls/cases/terminal-id-looks-like-an-id-and-is-not.md`: **pane ids survive a herdr restart, session
files do not survive a pi restart.** One is the right identity for "the same agent slot", the other for "one
run of it". The baton stores both, which is what makes the adoption decidable.

`HostEventInput` gained `paneId`; `runGoalEvent` fills it from `HERDR_PANE_ID` when the host does not.

## Guard

- `test/goal.test.ts` — "a restarted session in the same pane adopts the goal and re-arms the wait":
  adoption + `schedule-wake`, refusal for a different pane (baton unmoved), and an expired wait still
  escalating *after* adoption. Plus "an unclaimed goal is claimed by the first session that reconciles it".
- The live run above: kill pi, start a new one in the same pane, and the timer fires on schedule with the
  baton naming the *new* session and the original pane.
- **The general rule this adds:** a guard that refuses an event also refuses the *recovery* that event
  carries. When a state is only escapable through one handler, ask what identity that handler will have
  after a restart — and make sure at least one of the identities it presents is one the engine still
  recognises.
