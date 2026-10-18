# Three review passes found seven P1s the probe scripts missed

**Severity:** 🔴 high · **Date:** 2026-10-18

## Symptom

Five probe scripts and 245 green tests said the goal engine was sound. Three independent review
passes then returned **two BLOCK verdicts** with seven P1s between them. Every one was real, and
several were unreachable by the tests that existed.

## The findings, and the class each belongs to

| # | Finding | Class |
| --- | --- | --- |
| 1 | `close` left `baton` set, so the holder was refused by `isClosed` and everyone else by the baton — the goal became undrivable by anyone | **asymmetric guards** |
| 2 | `holdsBaton` returned `true` for `sessionPath === undefined`, so any unidentified session drove a goal that had a holder | **absent-means-permitted** |
| 3 | `onWake` cleared `wake` without emitting `clear-wake`, so `reconcile` re-armed a consumed token and the arrival was dropped | **state cleared, effect not** |
| 4 | `onProgress` **reset** `unchangedRounds` on a `null` digest instead of preserving it, so the no-change detector could be held at 0 forever | **wrong three-way branch** |
| 5 | `pendingVerdict` had no ceiling: an unanswered `done` claim re-emitted `evaluate` on every settlement, and `unreportedSettles` never incremented on that path — two unbounded questions with no detector | **unbounded in-flight state** |
| 6 | `/goal wake` called the *human* output channel and then tried to `JSON.parse` it, so it always reported failure after succeeding | **channel mismatch** |
| 7 | the host bounded `spawnSync` at 30 s while `done_when` is allowed 10 min → any real `npm test` was SIGTERMed mid-gate, losing the report and firing a false "not recording" warning | **timeout inversion** |

Plus a CSV short row making `!=` pass vacuously, and a header match loose enough to delete a
hand-written extension whose first line merely *starts with* the marker.

## Root cause: three recurring shapes

1. **Asymmetric guards.** A rule enforced on one side of a transition and not the other (#1, #2).
   The probe scripts walked *event sequences*, and still missed these because they started from a
   record with a baton and never tried the anonymous caller.
2. **State cleared, effect not.** Clearing `record.wake` while forgetting `clear-wake` (#3) looks
   correct in the record and leaks in the adapter. The record is not the system.
3. **A detector with a hole its own name hides.** "Two stuck detectors" was three, and two of the
   three could be defeated by input the model controls (#4, #5).

## Fix

All seven, plus the P2s that were free. The lesson is not "review more" — it is that a review asked
to *break* the code found what a probe asked to *exercise* it did not. The probe scripts all started
from a plausible record; every P1 needs an implausible one.

## Guard

- `test/goal.test.ts` gained eight cases, one per P1 it can reach: an unidentified session, a closed
  goal's baton, a consumed wake under `reconcile`, a `null` digest mid-streak, an unanswered verdict,
  a stale handoff, repeated failed verdicts, and an unparseable timestamp.
- `test/goal-extension.test.ts` gained a **behavioural** test that loads the emitted module against a
  stub `pi` and a missing binary, and asserts `sendMessage` fired exactly once. The previous version
  asserted three regexes over the source text, so deleting every `warnUnreachable(pi)` call stayed
  green.
- The carrier's foreign-file test now uses a file whose first line *starts with* the marker — the
  old one used a file with no marker at all, which is why the loose match survived.
