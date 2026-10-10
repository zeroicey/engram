# A new line in a never-dropped section evicts the content it was meant to accompany

**Severity:** 🟠 medium · **First hit:** 2026-10-10 · **Hits since:** 1

## Symptom

Declaring one extra partition removed the whole `PITFALLS` block from `engram dump`:

```text
$ node build/src/cli.js dump --root $P --max-bytes 1270 | grep '^[A-Z]'
NOW BINDING RECENT PITFALLS POINTERS          # before .ai/sections.json existed
NOW BINDING RECENT POINTERS                   # after one section was declared
```

At a tighter budget `RECENT` went too, then `BINDING`. On a real bank the fingerprint was already at
the ceiling, so the new line displaced content that a resuming agent actually needs.

## Root cause

`fitToBudget` drops sections by priority — `ELASTIC_PRIORITIES = [3, 2, 1]` — and never drops
priority 4. The declared-sections line was appended to `POINTERS` (priority 4), which is the
irreducible floor, while `PITFALLS` is priority 3. So a *pointer to a directory that may not have
any content yet* outranked decoded failure modes, recent sessions and the binding decisions.

The mistake was conflating "must always be present" with "belongs in the section that is always
present". `POINTERS` earns its exemption because those two lines are the routing map without which
the fingerprint is unusable; a third line is a convenience.

## Fix

Give the line its own elastic tier, dropped **first**:

```ts
const ELASTIC_PRIORITIES = [3.5, 3, 2, 1];
```

It is pushed as a *headingless* continuation (`FingerprintSection.heading` is now optional), so it
renders inside the `POINTERS` block but can be dropped without leaving a dangling heading.

## Guard

- `test/sections.test.ts` — "declaring a section must not evict pitfalls from the fingerprint":
  builds a bank with five long accepted decisions, three sessions and three pitfalls, asserts
  `PITFALLS` is present at `--max-bytes 1270` **before** the declaration (so the fixture provably
  exercises the budget), then asserts it is still present after.

## The generalisable rule

A budget that drops by priority needs an explicit answer to "which tier is this new line in?".
Appending to whatever section is already never-dropped is the easy move and silently promotes the
newest, least-important content above everything elastic. Test a budget fix by asserting the
*content that must survive*, not the presence of the thing you just added.
