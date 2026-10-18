# Section priority is not render order

**Severity:** 🟠 medium · **Date:** 2026-10-18

## Symptom

The live goal was added to the fingerprint with `priority: 0.5` — below `NOW` (0), above `BINDING`
(1) — and it rendered **under** the binding decisions:

```
NOW
state: …
BINDING
  ✅ …
GOAL
  id: …
```

The test asserting `GOAL` appears before `BINDING` failed, which is the only reason this was caught:
the output looked plausible.

## Root cause

Two different things were conflated in `src/core/fingerprint.ts`:

- **`sections.push(...)` order** decides what the reader sees. `fitToBudget` renders `kept.flatMap`
  in array order.
- **`priority`** decides only what gets *dropped* when the byte budget is tight
  (`ELASTIC_PRIORITIES`).

Pushing the goal section after `BINDING` therefore rendered it after `BINDING` while still giving it
the stronger drop priority. Both halves were "correct" in isolation and the combination was wrong.

## Fix

Push in priority order. The rule is now written at the push site: **the render order is the priority
order**. A section that outranks another must be pushed before it, or the reader sees the opposite of
what the budget protects.

## Guard

`test/goal-cli.test.ts` — "an active goal reaches the fingerprint, above the binding decisions"
asserts `out.indexOf('GOAL') < out.indexOf('BINDING')`, not merely that both are present. A presence
assertion would have passed with the bug in place.
