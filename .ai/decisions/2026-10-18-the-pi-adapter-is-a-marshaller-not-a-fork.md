# The pi adapter is a marshaller, not a fork

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Follows:** `2026-10-18-fold-the-goal-engine-into-engram-instead-of-a-separate-packa.md`

## Context

The goal engine's rules live in `src/core/goal.ts` as a pure reducer. The thing that actually drives
them is a pi extension, which must live at `.pi/extensions/engram-goal.ts` inside the **user's**
repository, loaded by pi's own loader (`jiti`), with no guaranteed module resolution back to
`@zeroicey/engram/build/`.

That constraint has exactly two exits, and the choice between them decides whether this project keeps
its central promise ("one implementation of a rule"):

- **Bundle the engine into the generated file.** Self-contained, no CLI dependency at run time — and a
  fork. Every rule would exist twice. The copy the model talks to is the one inside the user's
  repository, which is also the copy that never gets upgraded with the package. The day they disagree,
  the stale copy silently wins.
- **Generate a marshaller and let the installed `engram` do the thinking.** One extra process per
  lifecycle event, and a dependency on the CLI being reachable — in exchange for exactly one
  implementation of every rule.

## Decision

1. **The generated extension contains no rule.** It maps four pi events onto
   `engram goal event --type … --json` and applies the answer:
   `agent_start` → `run-started`, `session_start` → `reconcile`,
   `agent_before_settle` → `settled`, `turn_end` → the context reminder.
   `test/goal-extension.test.ts` fails if the emitted source contains any rule name
   (`stuckRounds`, `livenessMs`, `blockedRepeats`, `closedAt`, `unchangedRounds`).
2. **The `evaluate` effect is resolved inside the CLI, not by the host.** `runGoalEvent` runs
   `done_when`, reduces the verdict, and answers in one round trip. A host that had to run the gate
   and feed the answer back would be a second place where "done" is decided — and the host is
   precisely where that rule must not exist.
3. **The extension is emitted as JS-valid TypeScript** (no annotations, no imports beyond
   `node:child_process`) so `node --check` can syntax-check the generated string on every test run.
   A generated file with a typo otherwise fails inside pi's loader, where the error points at the
   loader rather than at the file engram wrote.
4. **`ENGRAM_BIN` overrides the compiled-in path at run time.** A development checkout, and a machine
   without a global install, must not require regenerating the file.
5. **An unreachable binary is a distinct, reported state.** `spawnSync` reports ENOENT/EACCES as
   `res.error` with `status: null`; collapsing that into "no answer" makes a missing install look
   identical to a closed goal. It notifies once per session.
6. **The opt-in is separate from the tool set.** `.engram/config.json` gains `goal: { enabled }`.
   `tools` records *which rule files to write*; a lifecycle hook is a different consent, so
   `engram config --goal on|off` flips it and `sync` writes or removes the carrier accordingly.
7. **Only a generated carrier is ever written or removed** — whole-line header match, same rule as
   `prune-carriers.ts`. A hand-written file at the same path is reported and never touched, because
   there is no safe merge for two extensions that would both register `goal_report`.
8. **pi first, others later.** No other tool exposes `agent_before_settle` with a continuation
   result, so no other carrier can host this. That was already the decision; this makes the reason
   mechanical rather than stylistic.

## Consequences

- Every settlement costs one subprocess. Acceptable: it is once per turn, ~50 ms, and the
  alternative is a fork.
- The generated file is short enough to audit by reading (~180 lines, no logic), which matters
  because it runs with the user's OS permissions.
- `engram` must be on `PATH` (or `ENGRAM_BIN` must point at it) for the goal engine to work. That is
  a real new deployment requirement, and it is stated in the generated file's header and in the
  notification when it is missing.
- The engine is exercised end-to-end by a **live pi run**, not only by unit tests: a latched wait was
  released, a `progress` was recorded, a `done` claim was verified by the CLI, and the goal closed
  itself. Recorded in `.ai/sessions/`.

## Revisit when

- pi gains a supported in-process extension API that can import a package (then the subprocess
  disappears).
- A second host grows an equivalent continuation hook, which would justify a `goal report` verb in
  the CLI rather than only `goal event`.
- The per-settlement subprocess turns out to cost more than measured.
