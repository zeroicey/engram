# The first unattended run: three probes, and what "multi-hour" actually needs

**Severity:** 🟠 medium · **Date:** 2026-10-18

## What was tested, and how

The design's largest untested assumption was "a goal can run for hours unattended". Three probes, each a
**real** pi process in a **real** herdr window, working a **real** repo with a real `npm test` gate — no
test doubles anywhere:

| Probe | Project | Gate | Outcome |
| --- | --- | --- | --- |
| A | `/tmp`-fresh repo, `src/duration.js` + 4 tests | `npm test` | `running` → **`done`** in one turn. Engine ran the command, `lastVerdict.passed: true`. One commit (`8a82672`), 8 tests. |
| B | same repo + a `duration-relay` skill requiring `NOTES.md` with `RELAY-OK` | `npm test` | **`done` in one turn.** It read the skill, wrote NOTES, 21 tests, 3 commits. |
| C | same, **relay now requires an explicit `wait` first** | `npm test` | `waiting` on `wake-1` (90 s) → **timer fired** → woken → `NOTES.md` restored → **`done`**, 2 reports, verdict observed. |

Probe C is the one that matters: it is the first time the L2 timer was launched by a **real process**
rather than a test harness, and the first time a whole goal spanned **two agent sessions' worth of turns
with a gap in the middle**. The commit timeline proves the gap is real:
`02:08:42 → 02:10:34`, 112 seconds apart, with the wait latched at `02:08:46`.

## The finding: the model does not produce a long run, so a "long task" test must be designed

All three probes finished in **one turn**, including B, whose skill demanded extra artifacts. A capable
model plans the whole thing and executes it. So:

- **A long run cannot be produced by making the work bigger.** Bigger work still fits one context and one
  turn; it just takes longer *inside* that turn, which exercises nothing about the goal loop.
- **It needs a gate that is unsatisfiable until something outside the session changes.** Probe C's relay
  required an explicit `wait` *before* the token could be restored, which is why it needed the timer.
- **`rounds: 0` in all three.** `rounds` counts only `progress` reports, so a goal that is driven by
  `wait` reports and finishes offline shows `reports: 2, rounds: 0`. That is not a defect — a round is a
  *progress* round — but it means `rounds` is useless as a liveness signal for this shape, and nobody
  should read `rounds: 0` as "never did anything".

## Two real defects the probes found

1. **A handoff into a fresh directory could never start its agent.** `herdr agent start` without
   `--approve` leaves pi at `Trust project folder?`, herdr reports no session, and the handoff fails with
   `timed out waiting for agent startup`. Measured on hpstation and again here. Fixed: the start argv now
   ends `-- --approve`. Justified because engram has *already* written `.pi/extensions/` and
   `.agents/skills/` into that directory — the successor runs engram's own carrier, in the directory the
   human aimed the goal at.
2. **A pane whose agent never started was left open**, adding an empty window to the tab bar for every
   failed handoff. Fixed: the window is closed again and the cause is named.

## A trap a future probe will hit

`baton` is taken from `PI_SESSION_FILE` in the environment, so **creating a goal from inside a pi session
claims that session as the holder** — a goal meant for a successor then refuses the successor's first
turn. Both B and C hit this and needed a corrected baton. That is the baton rule working, not failing;
the probe script has to clear the baton (or pass `--session`) when it creates a goal for another window.

## The enlarged run, and the mistake it caught in my own probe

A fourth probe scaled the shape up: **three legs, two real timed waits of 120 s each, and a gate of
`npm test && node scripts/legs.js --require 3`**, so the goal could not close until every leg had left a
`LEGn-OK` marker. Result: `waiting` (`wake-1`) → timer fired → leg 2 → `waiting` (`wake-2`) → timer fired
→ leg 3 → `done` on **`2 command(s) exited 0`**. Two consecutive real timers in one live session, three
commits separated by two ~2-minute gaps, 15 tests.

The first attempt at that probe was **wrong in an instructive way**: the relay guard lived in the
carrier's `agent_before_settle` hook. **That hook never sees a `done` report.** `goal_report(status=done)`
is a tool call whose verdict the engine runs; `agent_before_settle` fires when a *run settles*, and the
model went from leg 2's wait straight to leg 3 and a `done` claim without ever settling empty. So the goal
closed while the guard's condition was unsatisfiable — and worse, the guard's condition could never be
satisfied because the skill never told the model to write the file the guard read.

Two lessons, and the first is a rule:

- **A project rule binds only in `done_when`.** The carrier is engram's code and `sync` owns it; the gate
  is the project's, and the engine runs it. Anything a project wants enforced goes in the gate (or a
  `checklist` with evidence), never in a hook — a hook can be bypassed by the model simply not settling.
- **A guard whose input the instructions never mention is dead on arrival.** Ask of any check: *is
  producing its input part of the task the model was given?*

## The duration case, which was the last unknown

A fifth probe tested the only dimension the others had not: **a wait longer than the work**. Leg 1, then a
**single 30-minute wait** (`wakeOnSeconds=1800`), then leg 2, with the gate
`npm test && node scripts/legs.js --require 2`.

- Wait latched `02:06:33Z`; `deadlineAt 04:06:33Z` — the configured `livenessMs: 7200000`, **not** the 24h
  default. That is the configurable-liveness change doing its job on a real wait.
- The agent reported `waiting` and then genuinely stopped (`agent_status: done`) — it did not busy-poll, did
  not sleep in a tool call, and held for 30 minutes of wall clock.
- The timer fired at `~02:36:5xZ`; the pane came alive, did leg 2, recorded `LEG2-OK`, committed twice and
  reported `done`. Engine verdict: `2 command(s) exited 0`. Closed `02:37:16Z` — ~33 minutes end to end.
- `wakeSeq: 1`: one wait, one timer, one wake. Nothing re-armed, nothing double-fired.

What that rules out, concretely: a half-hour wait does not survive as a lost timer, an idle agent does not
get nudged while waiting, the deadline does not fire early, and a session that stopped completely comes
back from a `setTimeout` alone.

Still untested: **a wait that spans a pi restart or a herdr restart.** The reducer and `reconcile` handle
it, and the `terminal_id` measurement says the pane ids survive a server restart, but nobody has parked a
goal, restarted the runtime and watched the successor's `session_start` re-arm. That is the next honest
test, not this one.

## Guard / how to do it again

- A real long-run test is a repo whose **gate** is only satisfiable after a wait plus a second turn —
  the three-leg probe is the working example: `npm test && node scripts/legs.js --require 3`, a skill
  that tells the model to append `LEGn-OK` after each leg, and a `wakeOnSeconds` between them. Note the
  gate, not a hook, and note that the skill has to name the marker file or the gate can never pass.
- Never launch the successor with `herdr agent start` without `--approve` for a directory pi has not seen.
- Close every probe window and delete every probe repo; a probe that leaves state behind costs the next
  person an hour of "which of these is real".
