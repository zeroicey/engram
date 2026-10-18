# A default that reads the environment silently re-owns the goal

**Severity:** 🟠 medium · **First hit:** 2026-10-18 · **Hits since:** 0

## Symptom

Adding two environment defaults — `engram goal new` reading `PI_SESSION_FILE` and `HERDR_PANE_ID`
to record the baton — broke four tests that had nothing to do with identity:

```
not ok 104 - baton transfers and status names the holder
not ok 128 - goal event --type report answers one JSON document
not ok 129 - a done claim resolves its own verdict, so the extension never runs a gate
not ok 130 - a failed gate comes back as a nudge, not as an escalation
```

`/sessions/two.jsonl` was expected to be the first holder but the goal already had one, and the event
tests were refused with `not the baton holder for this goal`. Nothing in those tests mentioned a
baton; none of them passed `--session`.

## Root cause

The suite drives the CLI **in-process** (`main()` inside `node --test`), so `process.env` is the
developer's environment — which, when the tests are run from a pi session inside a herdr pane,
contains both variables. The tests had been asserting an *unowned* goal without ever saying so: the
absence of a baton was an accident of the environment, not an input they controlled.

Two properties combined to make it silent:

1. `holdsBaton` refuses a *different* session only when a baton exists, so an environment-derived
   baton turns a previously permissive path into a refusal — the failure lands in unrelated tests.
2. `ok: true` is still returned for an ignored event (it means "the call was well formed"); the
   refusal appears only as `effects[0].reason`. Reading the exit code, or `ok`, tells you nothing.

## Fix

`test/helpers.ts::runCli(args, identity)` **deletes** `PI_SESSION_FILE` and `HERDR_PANE_ID` by
default and restores them in a `finally`; a test that wants an identity passes it explicitly.
`test/goal-cli.test.ts` and `test/goal-extension.test.ts` now delegate their local `run()` to it.
`test/goal-unit.test.ts` covers the defaulting itself, both directions: identity present → the holder
is recorded; a different identity → `effects[0].reason` is `not the baton holder`.

The product change was kept: it is what gives a goal a wake address at all (see
`.ai/decisions/2026-10-18-emit-the-wake-unit-and-deliver-the-wake-through-herdr.md`).

## Guard

- `test/helpers.ts::runCli` is the only in-process CLI harness, and it scrubs the identity variables.
  A new suite that calls `main()` directly reintroduces the trap — so a new suite should import
  `runCli`, and a reviewer should ask why it did not.
- A baton assertion must read `effects[0].reason`, not `ok` or the exit code: `ok: true` is returned
  for an ignored event.
