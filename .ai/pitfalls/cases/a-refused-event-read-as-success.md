# A refused event came back `ok: true` with `reason: null`

**Severity:** 🟠 medium · **Date:** 2026-10-18

## Symptom

`responseFromEffects` derived `reason` from `handoff`, `done-observed` and the caller's argument, and
never from an `ignore` effect. So the one effect whose entire content is *why nothing happened* was
dropped on the way out: the wire response was `{ok: true, continue: false, message: null, notify: null,
reason: null, effects: [{kind: "ignore", reason: "not the baton holder for this goal"}]}`.

A host that reads `reason` — and the generated `/goal` handler does — fell through to its own default
and printed **"goal woken"** for a wake the engine had refused. `ok: true` was not a lie; the message
was.

## Root cause

Two channels existed for the same fact (the `effects` array and `reason`) and only one was populated.
`reason` had been read as "why `continue` is false *for a host decision*" rather than "what the engine
decided", which is why a refusal had no home.

The ordering that produced it is worth keeping: the `ignore` was already in the effects, so nothing
needed to be invented — the refusal simply had no reader until the baton guard started refusing a
**timer** (`poll`) rather than only an unidentified session. A guard that fires in practice is what
makes an invisible refusal visible as a lie.

## Fix

`responseFromEffects` now prefers an `ignore` effect's reason, before the handoff/done cases. It is the
only effect that means "nothing happened, and here is why", so it cannot compete with the others.

## Guard

- `test/goal-cli.test.ts` — "a refused poll names the baton, so a host is not left thinking it woke the
  goal" drives a real CLI: `ok: true`, `continue: false`, `status: waiting` (untouched) and
  `reason` matching `/not the baton holder/`.
- The general rule: **an effect a host cannot see is a decision the engine did not make.** When a new
  effect kind is emitted anywhere, check that `GoalResponse` has a field for it — `describeEffects`
  already filters `escalate`/`nudge` out of the human output, and `effects` is only read by hosts that
  choose to.
