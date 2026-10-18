# L2 handoff: the in-process timer, and what a wake transport still cannot prove

**Date:** 2026-10-18 · **Branch/Commit:** `main` @ (this commit) · **Duration:** one session (the fourth
in this line today)

## Where we ended

L2 landed. A `wait` no longer needs a systemd unit to come back on its own:

`goal_report(status="wait", wakeOnType="time", wakeOnSeconds=600)` → the engine latches the wait and
publishes an **absolute** `fireAt` → the generated extension arms a `setTimeout` → at that instant it
asks `engram goal event --type poll` → the engine answers with the message to deliver → the extension
delivers it with `pi.sendMessage(…, { triggerTurn: true })` → **and only then** claims the wake.

The shape that matters is the split: **the host holds a clock, the engine holds the judgment.** The
extension never inspects the machine — it does not know whether a pid is gone or an artifact exists,
and it cannot run a gate. Decided in
`.ai/decisions/2026-10-18-l2-is-an-in-process-timer-that-asks-the-engine.md`, including why L2 is a
`setTimeout` and not the "background task that waits" the waiting decision's rule 4 described (a
background task's runtime is session-scoped — the ghost-process failure rule 5 exists to prevent).

**Two live probes then found the real bug of the session, and it was not in the timer.** Both
transports consumed the wake *before* delivering it:

- L2: a `--print` session parked a goal on a 12s wait; at the planned instant the timer fired,
  `pi.sendMessage` threw `This extension ctx is stale after session replacement or reload.`, the throw
escaped a `setTimeout` callback, and **node died with an uncaught exception** — while the record had
already moved to `running` with `wake: null`.
- L3: `runGoalWake` wrote the consumed record *before* asking herdr to prompt the pane, and its test
  asserted that with the comment "the token is still consumed … the deadline is what recovers it".
  False twice over: `onReconcile` only looks at a goal that is still `waiting`, so the 24h deadline
  never looks at a consumed wake.

Full write-up: `.ai/pitfalls/cases/a-wake-consumed-before-it-was-delivered.md`. Fixed by delivering
first and claiming second in both transports, guarding every `pi` call the timer makes, and *not*
retrying a failed delivery (a stale runtime never recovers, and a pending timer would hold a
shutting-down process open until the deadline).

Also fixed on the way, both found by making the host consume effects for the first time:

- two more paths cleared `wake` without emitting `clear-wake` → `a-cleared-wake-left-its-timer-armed.md`
- an `ignore` effect had no reader, so a refusal answered `ok: true, reason: null` and `/goal` printed
  "goal woken" → `a-refused-event-read-as-success.md`

## What changed

| File / area | Change | Why |
| --- | --- | --- |
| `src/core/goal.ts` | `schedule-wake` carries `fireAt` (absolute, from `requestedAt`); `poll` event + `onPoll` answering `wake-ready` (a peek, no state change); `wakeMessage`; `clear-wake` on the two paths that leaked it | the plan has to be absolute, and a question must not consume its own answer |
| `src/core/goal.ts` | `wake`/`poll` refuse an **identified** non-holder; an unidentified emitter stays allowed | a wait survives a handoff, so the predecessor's timer is still armed in the wrong pane |
| `src/commands/goal.ts` | `conditionObserved` (artifact via `staysInsideRoot`, pid via `kill(pid, 0)`); `event --type poll` | reading the machine is I/O, so it cannot be in `core/` or in `templates/` |
| `src/commands/goal.ts` | `runGoalWake` **delivers before it writes**, and a failed delivery is exit 1 with the latch intact | the same consume-first defect as L2, and its test had locked it in |
| `src/core/goal-host.ts` | `responseFromEffects` reads an `ignore` reason into `reason` | a refusal must not read as success |
| `src/templates/goal-extension.ts` | the timer: hop splitting at `MAX_TIMER_MS`, `WAKE_POLL_MS`/`WAKE_FIRST_LOOK_MS`, `clearWake` by token, `ask()` → `deliver()` → claim, `safeNotify` | L2 itself, and the delivery ordering |
| `src/cli.ts`, `src/commands/goal.ts` | `poll` documented in the usage lines | a host must not have to guess |
| `.ai/ARCHITECTURE.md` | the goal diagram, invariant 11 | the host's one new responsibility |

## Verified / unverified

- [x] tested: 304 tests green, `tsc` clean, `engram sync` clean, `dump` inside budget
- [x] tested **live, in a real pi process (RPC mode)**: the model parked the goal on
      `wakeOnSeconds=12`; the run ended and the session stayed alive; two seconds after the plan
      `agent_start #2` fired with `wake: null` — the timer really did start a new run in a live session.
      This is the hop `--print` cannot test, and the one the whole transport exists for.
- [x] tested **live, `--print` mode**: the runtime is stale when the timer fires, and the extension now
      survives it — no uncaught exception, no hang, the wait still latched, the process exits ~1s after
      the fire. Before the fix this probe killed the process and left `status: running`.
- [x] tested **live, print mode, L3 ordering**: not re-run against a real herdr this session; covered by
      `goal-unit.test.ts` with injected herdr deps (fail → latch intact → retry delivers).
- [x] tested in the emitted extension (loaded against a stub `pi`, real CLI, real record): a 1s `time`
      wait fires once and starts exactly one turn; a release cancels it; a restart re-arms from
      `goal.json` alone; an artifact wait polls and only wakes when the file appears; a delivery that
      throws does not consume the wait and a fresh instance recovers it
- [ ] **assumed, NOT tested: the 24h liveness deadline.** The host asks `reconcile` at `deadlineAt` and
      the engine escalates (reducer + `goal-cli` tests only). A real one is a day long.
- [ ] assumed, NOT tested: a wait that survives a **handoff in two real panes**. The reducer proves the
      predecessor's poll is refused and the successor's re-arm is sourced from `goal.json`; M4's spawn
      has still never run end to end.
- [ ] assumed, NOT tested: `WAKE_POLL_MS` (15 s) against a real multi-hour observed wait.
- [ ] seen, not ours: a run started by `triggerTurn` produced a pi-side `extension_error` on `turn_end`
      ("could not resolve the persisted assistant entry ID", `extensionPath: "<boundary>"`). The engram
      carrier's `turn_end` handler only reads context usage; the message appears in no engram source.

## Loose ends

- [x] **The adversarial review of this diff.** It was launched as a subagent and **timed out after 30
      minutes having produced one line** ("I'll start by reading the changed files") — no findings, no
      partial diff, tree clean. It was redone by hand afterwards and **found a fourth defect of the same
      class**: `/goal wake` released the latch and discarded the message its own claim returned, so the
      wait was consumed and no run started (probed against the CLI, then fixed and verified live in RPC
      mode). The structural guard is `EFFECT_DISPOSITIONS` in `core/goal-host.ts`. Recorded here because
      "a review was requested" and "a review happened" are not the same claim.
- [ ] **Run one real multi-hour goal** — still the largest untested assumption in the design (the
      commit-at-settlement rule, the traceability promise, the liveness deadline). Now cheap to try: a
      goal whose only work is a `wait` of 30–60 minutes.
- [ ] The five live timer tests cost ~10s of the suite's 12s. They are the only tests that prove L2
      works, so they stay — but do not add more sleeps of a second each without thinking about it.
- [ ] Publish 0.5.0 (human, 2FA). Still never installed by anyone; 0.5.0 is also the first version
      whose carrier consumes `schedule-wake`.
- [ ] `research` has not declared `.ai/sections.json`; the extension surface is unproven by a second
      project.
- [ ] A wake that fires while the goal is `blocked` re-raises and is recorded in `pendingWakes`, but
      nothing ever drains that list — the human reads it in `goal status` and that is all.

## Do not repeat

- **Do not consume a wake before delivering it.** `poll` peeks, `wake` claims, `runGoalWake` delivers
  before it writes. If a delivery fails after the consumption, the goal is `running` with nothing to
  re-arm it and the 24h deadline does not look at it.
- **Do not send a claim whose message you drop.** A `wake` releases the latch, so its `message` is the
  delivery. `/goal wake` did exactly this: consumed the wait, started no run. Every call site that can
  receive a `message` must deliver it, and `EFFECT_DISPOSITIONS` exists so a new effect cannot be
  unassigned.
- **Do not trust a subagent review that timed out.** A `reviewer` run returned one line after 30 minutes;
  the findings that mattered came from a hand-built probe against the CLI. Check the artifact, not the
  launch receipt.
- **Do not retry a failed delivery.** A stale extension runtime never becomes live again, and a pending
  `setTimeout` holds the whole process open: a 24h wait would have spun a spawn per second for a day.
- **Do not trust a comment that claims a guarantee.** L3's `deliverNudge` doc said "the token stays
  latched", and two tests asserted the opposite behaviour with a reason that sounded right. The L2 lesson
  is the same one: a claim in prose is unverified until a test fails without the code.
- **Do not put `node:fs` in `templates/`.** It is not just style: `test/architecture.test.ts` fails, and
  the reason it exists is that the whole pipeline stays testable in memory. It is also why the artifact
  check is in `commands/goal.ts`.
- **Do not let the host decide whether a condition is true.** `conditionObserved` is the single
  observation, `conditionDue` is the single judgment.
- **Do not compute `fireAt` from `now` on a re-arm.** It restarts the full duration; derive it from
  `record.wake.requestedAt`.
- **Do not ask the engine synchronously when arming an observed wait.** The arming happens inside the
  `goal_report` tool call, and a satisfied answer there would `triggerTurn` mid-turn. That is why
  `WAKE_FIRST_LOOK_MS` is a hop and not a call.
- **Do not cancel a timer without matching the token.** `[clear-wake old, schedule-wake new]` arrives in
  that order today; an unconditional clear is one reordering away from cancelling the live wait.
- **Do not put backticks in the generated extension's comments.** The whole file is one TS template
  literal in `templates/goal-extension.ts`; a backtick ends it and the error surfaces as
  `TS1443: Module declaration names may only use ' or " quoted strings` at a line that looks fine.
- **Do not probe a timer with `pi --print` and believe the result.** The session is disposed before a
  wait of minutes can fire, so the runtime is stale by design. Use `pi --mode rpc` (a process that stays
  alive) — that is what proved the last hop.

## Next step

Run one real multi-hour goal. `engram goal new "<text>" --cmd "<project gate>"`, then work, then
`goal_report(status="wait", wakeOnType="time", wakeOnSeconds=1800)` and let the timer bring the session
back. Everything about the loop is now built; what has never happened is a day of it.
