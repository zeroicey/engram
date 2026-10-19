# Two more paths cleared `wake` and left its timer armed

**Severity:** 🟡 low · **Date:** 2026-10-18

## Symptom

None, for as long as nothing consumed the effect. `onProgress` (both the unclassified and the
no-change branches) and `onReconcile`'s expired branch set `wake: null` on the record and emitted no
`clear-wake`. The record was correct; the host's handle stayed live.

This is the third, fourth and fifth instance of a class the review round already logged once
(`asymmetric-guards-and-leaked-effects.md`, finding #3: `onWake` cleared a wake without emitting
`clear-wake`). That one was fixed where it was found, and the *class* was not swept: `onClose`,
`onBlocked`, `onRunStarted` and `onWake` emit the clear, and these three paths did not.

## Root cause

`record.wake = null` and `clear-wake` are two halves of one transition, and only the record is
inspectable in a unit test of the reducer. A leak is therefore invisible to every test that asserts on
the record — and it was invisible in production too, because until L2 there was no consumer at all.

**What it actually cost, measured once a consumer existed: one wasted CLI call.** The host asked about
a token the record no longer held, `onPoll` answered empty (not "still waiting"), and the host stopped.
No lost wake, no spurious turn — a stale token cannot match a newer wait, because tokens are monotonic.
The guard is symmetry, not a rescued symptom, and saying otherwise would be the dishonest version of
this entry.

## Fix

Both paths now emit `clear-wake` for the token they drop, and `clear-wake` is matched by token on the
host side so `[clear-wake old, schedule-wake new]` cannot cancel the new timer in either order.

## A fourth instance of the same class, found months later in the same field

`pendingWakes` — the record of wakes that arrived while a human was the blocker — was **never drained**.
`onRunStarted` cleared `unreportedSettles` and `wake` when a human answered, and left the accumulated
wakes, so `goal status` kept saying `3 wake(s) arrived while blocked` about wakes from unrelated
incidents the human had already been told about.

It is the same question as `wake`/`clear-wake`, one field over: **a `pending*` field needs the
transition that retires it, on every path** — and here the answer is "the human's answer", i.e.
`run-started` out of `blocked`. Now drained there, with a test that also proves a *later* blockage starts
from empty instead of re-reporting the old wakes.

## Guard

- `test/goal.test.ts` — "a report that releases a wait cancels its timer" asserts the effect list, not
  just `wake === null`, on both `onProgress` branches; the expired-reconcile case asserts
  `['clear-wake', 'escalate', 'silent']` in that order.
- The invariant to apply to any future path: **a transition that sets `wake: null` must emit
  `clear-wake` in the same `GoalStep`.** Ask it of every branch that writes the field, the way
  `pendingHandoff` has its own "which transition retires it, on every path?" question.
