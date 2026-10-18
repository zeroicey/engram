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

## Guard / how to do it again

- A real long-run test is a repo whose `npm test` gate is only satisfiable after a wait plus a second
  turn — probe C's `duration-relay` skill is the smallest working example (35 lines).
- Never launch the successor with `herdr agent start` without `--approve` for a directory pi has not seen.
- Close every probe window and delete every probe repo; a probe that leaves state behind costs the next
  person an hour of "which of these is real".
