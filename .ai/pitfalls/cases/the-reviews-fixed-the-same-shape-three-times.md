# Three independent reviews, the same two shapes every time

**Severity:** 🔴 high · **Date:** 2026-10-19

## Symptom

Three reviewers ran in parallel over one change set, with no shared context: goal engine, host boundary,
memory-bank reader/writer. All three returned **BLOCK**, and 25 of the findings reduce to two shapes.

**Shape 1 — a guard enforced on one side of a transition and not the other.** The class this repository has
already paid for three times (`asymmetric-guards-and-leaked-effects.md`), still producing P1s:

- `init` wrote the config through `writeGenerated` (replaces content) instead of a write-once path, so a
  re-run replaced `{version:2, goal, limits}` with `{version:2}` — and the next `sync` **deleted the goal
  carrier**. Destructive, silent, and reachable by running `engram init` twice.
- The legacy-config migration passed only the goal opt-in to `writeConfig`, which emits `limits` only when
  given one, so the first `sync` erased a tuned deadline.
- `onVerdict`'s failed branch was the one transition that left `waiting` without retiring `wake` and
  without emitting `clear-wake`.
- `pendingHandoff` was retired by `onProgress` and by nothing else that mattered.
- `reconcile`'s `isPast`-style timestamp guard was applied in one place and bypassed in two (an inline
  `Date.parse(...) + livenessMs` that throws, and one that silently never escalates on NaN).
- `handled` on `WakeRecord` was written by nothing, read in four places, and reported by `doctor`.
- `warnUnreachable` was the one `pi.sendMessage` a timer callback could reach unguarded.

**Shape 2 — a report that disagrees with the artefact it describes.** The product is a digest pasted into
a session, and twice the digest and its own accounting told different stories:

- `truncated: true` said content was dropped without saying what, and when the notice was added the loop
  that was supposed to converge compared a value with itself, so `dropped` named sections the `omitted:`
  line did not.
- `doctor` printed `✅ bank is healthy` over a `chmod 000 .ai/decisions`, while `dump` had silently lost the
  whole BINDING block. A checker that reports health over an unreadable bank is worse than no checker.
- `dump`'s read errors went to stderr only, so `--out fp.json` and the pasted artefact both showed a
  complete-looking document.

## Root cause

Both shapes come from **checking the input instead of the result**. `seconds > 0` was validated and
`seconds * 1000 + now` was not, so `1e15` threw a `RangeError` out of a reducer that is documented as
total. `existing === content → kept` was checked and "does the file hold fields I do not own" was not.
`fits()` was checked after dropping, not after adding the notice that reports the dropping.

And the digest case is worse than an asymmetry: **the detector's input was the engine's own output.** Every
transition rewrites `goal.json`, `workingTreeDigest` walks `.ai`, so two consecutive digests could never be
equal — `unchangedRounds` was structurally pinned at 0 in production while the tests that cover it inject a
literal digest and stay green. A detector that measures its own writing is not a detector.

## Fix

All 25 findings, P0 through P2, in one pass: `writeOnce` for the config, `limits` preserved through the
migration, `wake` retired in `onVerdict`'s failed branch, `pendingHandoff` retired by `onBlocked`/`onWait`
and no longer able to mute a settlement unboundedly, `isoOrNull` bounding both wake timestamps, the
`pendingVerdict` timestamp parsed once, `handled` deleted, `warnUnreachable` guarded, the notice loop
iterating to a fixed point with its bytes reserved, `bank/unreadable` as an error, read errors on the
artefact and in `--json`, `.ai/goal` excluded from the digest, and `trimTo`/`severityOf`/`setGoalEnabled`
corrected.

## Guard

- `test/fingerprint.test.ts` — a **budget sweep** from 1 to 1800 bytes asserting the ceiling is a ceiling
  and that nothing dropped goes unnamed above the notice floor. A single-budget assertion cannot see the
  two disagree, which is why the first notice loop survived its own test.
- `test/commands.test.ts` — a re-init must leave `goal.enabled` and `limits` intact and the carrier alive.
- `test/goal.test.ts` — `1e15` and an unparseable `claimedAt` must not throw; a failed verdict retires the
  wait; a later statement retires a pending handoff; a wait with no condition escalates; the first
  identified session claims a holderless goal.
- **Ask of any detector:** *what can change its input without anything having happened?* If the answer
  includes the thing you are measuring, it is pinned and you will not see it, because the tests inject.
- **Ask of any report:** *does the artefact carry the same statement?* stderr is invisible to the reader of
  a pasted fingerprint, and `--json` is what a CI gate reads.
