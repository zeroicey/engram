# L2 is an in-process timer that *asks* — the host holds the clock, the engine holds the judgment

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey

## Context

`waiting` was a state with a plan and no transport. `schedule-wake` emitted a token, a condition and a
deadline, and nothing consumed any of it, so a `wait` parked the loop until a new run or the 24h
liveness deadline — the opposite of "may stop, must be able to come back on its own".

`2026-10-18-treat-waiting-as-a-first-class-goal-state-with-a-self-wake-c.md` already fixed the layers
by expected duration (L1 = any new run, no code; **L2 = an in-process timer**; L3 = a systemd unit) and
who decides (rule 2: the engine names the condition, the model never picks a transport; rule 6: a wake
is addressed to the goal, not to a pane).

What it did not settle is **what L2 *is*, mechanically** — and its rule 4 wording ("a background task
whose only job is to wait, so its completion *is* the timer") describes a route that would re-import
the failure rule 5 exists to prevent: a background task's runtime lives under
`.pi/tasks/<session-id>-<pid>/`, so it dies with the session, which is the ghost-background-process
failure the same decision names in its own context. The goal that produced this entry is titled after
the verdict: *an in-process timer, so a time wait of minutes needs no systemd unit*.

## Options

- **A. A background task that sleeps.** The letter of rule 4. *Rejected*: session- and
  process-scoped, so it is lost exactly when a wait is long enough to need one, and it needs
  `pi-background-tasks` to be installed and reachable from this extension.
- **B. The host observes the condition.** `setTimeout` plus `existsSync` / `process.kill` inside the
  generated file. *Rejected*: it puts an observation rule in the one file that cannot be tested in
  memory, it needs `node:fs` in `templates/` (which the architecture test forbids and which is the rule
  that keeps `templates/` renderable in a test), and the artifact path would not be confined by the
  project-root rule every other declared path obeys.
- **C. The host holds the clock, the engine holds the judgment.** *(chosen)*

## Decision

1. **L2 is a `setTimeout` in the generated extension plus `pi.sendMessage(…, { triggerTurn: true })`.**
   `triggerTurn` is pi's native way for an extension to start a run while idle, which is exactly what a
   wake has to do, and it needs no second extension to exist.
2. **The host holds the clock and nothing else.** `schedule-wake` publishes an absolute `fireAt` (a
   `time` wait's plan; `null` for a condition that has no plan) and `deadlineAt` (the liveness bound).
   The host arms, and at the right instant asks `engram goal event --type poll`.
3. **A poll is a question; a wake is a claim.** `goal wake` — L3's `ExecStopPost`, and a human typing
   `/goal wake` — says *it is over*; `poll` asks *is it over?*. Both lead to one transition, because
   they differ in who decided and not in what happens next.
4. **The question does not consume its own answer — delivery comes before the claim.** A satisfied
   `poll` answers `wake-ready` (the message to deliver, and no state change) and the release happens on
   a separate `wake` claim. Two transports had this backwards, and the cost was measured live: a
   delivery that failed after the wake had been consumed left a `running` goal that nothing was
   watching, and the 24h liveness deadline does not look at a goal that is no longer `waiting`. The
   same reversal is in `runGoalWake`, where the record used to be written before herdr was asked to
   prompt the pane. See `.ai/pitfalls/cases/a-wake-consumed-before-it-was-delivered.md`.
5. **A host call made after the handler returned must be guarded, and must not be retried.**
   `pi.sendMessage` throws when the extension runtime is stale (a reload, a session replacement, a
   shutdown), and a throw from a `setTimeout` callback is an uncaught exception in the pi process. It is
   caught, the wait is left latched, and the timer **stops**: a stale runtime never becomes live again,
   and a pending timer would hold a shutting-down process open until the deadline.
6. **"Still waiting" is an answer, not silence.** An unsatisfied poll answers `silent('waiting')`; that
   is the host's cue to ask again. Anything else — released, blocked, closed, or refused — ends the
   timer, so an empty effect list never has to mean two different things.
7. **The observation lives in `commands/`, and the artifact path is confined by `staysInsideRoot`.**
   The same rule `done_when.file` and checklist evidence use. A path outside the project is "not
   observed", not an `fs.existsSync` of whatever it resolves to.
8. **`fireAt` is absolute and derived from `requestedAt`, so a restart waits the remainder.** A re-arm
   computed from the new `now` turns a 6-hour wait that survived a restart into twelve; with the
   absolute instant, a restart *after* the plan asks immediately.
9. **Every path that clears `wake` emits `clear-wake`, and the host cancels by token.** Token matching
   is what lets `[clear-wake old, schedule-wake new]` arrive in either order.
10. **`wake` and `poll` are baton-checked only when the emitter identifies itself.** An unidentified
    emitter is legitimate (a unit, herdr's delivery, a human). An identified non-holder is not: a wait
    survives a handoff, so the predecessor's timer is still armed in the pane that gave the baton away,
    and an accepted poll there would consume the token and leave a `running` goal that nothing was
    watching.
11. **A refusal is visible.** `responseFromEffects` reads an `ignore` effect's reason into
    `GoalResponse.reason`, so `/goal wake` in the wrong pane says "not the baton holder for this goal"
    instead of printing "goal woken".

## Consequences

- A `time` wait of minutes is one `goal_report(status="wait", wakeOnType="time", wakeOnSeconds=…)` and
  nothing to install. L3 keeps its job: the 16-hour job that must outlive the pane — and it now shares
  the delivery-then-claim ordering, so a herdr failure leaves the wait latched for the next attempt
  instead of ending it.
- **Verified live**, not only in tests: in RPC mode (a pi process that stays alive across runs) a
  12-second wait produced `agent_start #2` two seconds after its plan with `wake: null` — the timer
  started a real run in a live session. In `--print` mode the runtime is already stale when the timer
  fires, which is where the unguarded delivery used to kill the process; it now leaves the latch and
  the process exits cleanly.
- `node:fs` stays out of `templates/`; the only machine-reading code added is in `commands/goal.ts`,
  next to every other declared path.
- The generated extension is the only place a timer can live, so a wake is re-armed by
  `session_start` → `reconcile` and by nothing else. That is what makes a wait survive a handoff made
  mid-wait, and it is why `reconcile` re-arms instead of only escalating.
- A `process`/`artifact` wait costs one CLI call per `WAKE_POLL_MS` (15 s) plus a first look at 1 s.
  The first look is a hop rather than an immediate question so a `triggerTurn` can never fire from
  inside the tool call that asked for the wait — the agent is mid-turn there, not idle.
- The reducer gained a fourth event (`poll`) and the host gained one verb. `wake` did not lose its
  users: the unit's `ExecStopPost` and a human both still claim.

## Open questions

- `WAKE_POLL_MS` / `WAKE_FIRST_LOOK_MS` are unexplained constants of the transport; a long observed
  wait spends ~4 spawns a minute on questions.
- The tests prove one process's timer, and RPC mode proves the last hop in a live process. A handoff
  *during* a wait is correct in principle (successor re-arms, predecessor is refused) and has never run
  in two real panes.
- An explicit `wake` may release a `time` wait early. That is the escape hatch working as intended,
  and it does mean the engine trusts a claim over its own clock by design.

## Revisit when

- A real multi-hour wait shows the poll rate or the in-process lifetime is the wrong trade.
- pi grows a native "wake me in N" or session-resume surface, which would make the timer redundant.
- A wait ever has to survive a machine reboot rather than a pi restart — that is L3's property.
