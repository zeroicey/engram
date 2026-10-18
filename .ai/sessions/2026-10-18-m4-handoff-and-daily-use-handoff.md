# M4 handoff: the successor pane, and can this be used day to day

**Date:** 2026-10-18 · **Branch/Commit:** `main` @ `3a61fed` · **Duration:** one session (the third
in this line today)

## Where we ended

M4 landed: a handoff now **opens a successor pane through herdr, hands it the baton, and prompts it
with a brief that names the bank files**. The predecessor stops driving for free — after the transfer
its events fail `holdsBaton`, so the engine ignores them. See
`.ai/decisions/2026-10-18-open-the-successor-pane-when-the-model-asks-for-a-handoff.md`.

Before that, this session committed the two prior sessions' uncommitted work (`d62ed87`, `de1546f`)
and delivered M3/L3 (`009cacc`, `628e6da`): the systemd unit emitter and the wake delivery through
herdr, verified live end to end on hpcore.

The goal engine is now **enabled in this repository** (`.engram/config.json`, carrier committed), so
this project runs the loop it builds.

## Can this be used while developing? (the user's question, answered with evidence)

**Yes, for the goal loop; with two gaps that are a human's job, not a bug.**

What works today, all exercised live in the last two sessions:

- `engram goal new "…" --cmd "npm test"` → the goal lives in `.ai/goal/<id>/` and `dump` shows it
  above `BINDING`, so a fresh session sees the goal before it sees what binds it.
- `goal_report(status=progress)` per turn, `wait` for a long job, `blocked` for a human, `done` for a
  claim the **engine** verifies against `done_when` (never the model's word).
- A `wait` is releasable three ways: any new run in that project (L1, no code needed), and now a
  systemd unit's `ExecStopPost` → `engram goal wake --deliver` → herdr → the pane holding the baton
  (L3, verified live).
- A handoff opens the successor pane and moves the baton (M4, this session).

The two gaps, both deliberate and both structural:

1. **`engram goal unit` emits a unit; a human installs it.** Nothing schedules the long job
   automatically yet (L2 has no transport). For a real training run this is one `ln -sf` plus
   `systemctl --user start`.
2. **One goal per project, one baton.** Enabling the engine in a repo means its loop runs at every
   settlement in that repo. That is the intended contract (the agent commits at each settlement), but
   it is a real behaviour change per project: turn it off with `engram config --goal off && engram sync`.

Practical recipe for a project: `engram init` → add `--cmd "<project gate>"` to `goal new` → work →
report. The gate is what ends the run, so a goal whose gate is weak (or absent — `done_when` not
declared) is a goal that cannot finish: the engine says so with `verdict: not declared` instead of
pretending.

## What changed

| File / area | Change | Why |
| --- | --- | --- |
| `src/commands/goal.ts` | `runGoalHandoff` (5 ordered steps), `handoffPrompt`; `runGoalBaton` clears `pendingHandoff` | M4; and the silent-successor defect below |
| `src/core/herdr.ts` | `herdrJson`, `herdrPaneSplitArgs`, `herdrAgentStartArgs`, `createdPaneId`, `startedSessionPath`, `stringAt` | the spawn path, all I/O injectable |
| `src/templates/goal-extension.ts` | acts on `reason === "handoff requested"` by calling `engram goal handoff --json` | the M3 "nothing emits it" gap, in a different costume |
| `src/cli.ts` | `goal handoff [--json]` | a host must not parse prose |
| `test/goal-handoff.test.ts` | new (10 cases), fixtures from real herdr responses | ordering and failure edges are the risk, not the happy path |

## Verified / unverified

- [x] tested: 291 tests green, `tsc` clean, `engram sync` clean, `dump` 1408/1500
- [x] tested live (M3/L3, `009cacc`): `systemd-analyze --user verify` exit 0 → unit ran → ExecStopPost
      reported `result=success code=exited status=0` → `delivered to w13:p1` → the wake arrived as a
      real turn → `done` closed the goal on a verdict the engine ran itself
- [x] probed live (M4): herdr's real response shapes (`result.pane.pane_id`,
      `result.agent.agent_session.value`) and the caught trap that `pane split` without an explicit
      target lands in whatever workspace was last focused
- [ ] **assumed, NOT tested: the handoff spawn itself.** A probe pane was split, started and closed,
      but the full command (transfer + brief + successor actually working from the bank) has never run
      end to end. This session hands off to test exactly that — the successor inherits the verification
- [ ] assumed, NOT tested: a multi-hour goal, the 24h liveness deadline, and the commit-at-settlement
      rule. Still the largest untested assumption in the design
- [ ] assumed, NOT tested: the `node <script>` branch of `resolveEngramCommand` (this machine's
      `build/src/cli.js` is `0755` because npm chmods a `bin` target)

## Loose ends

- [ ] **L2**: the in-process timer transport. `schedule-wake` emits an effect with a token, a condition
      and a deadline, and nothing consumes it. This is the successor's goal.
- [ ] An **ignored event is invisible to the model**: `responseFromEffects` maps only `nudge` →
      `message` and `escalate` → `notify`, so a refused report returns `ok: true, message: null` and
      the extension settles silently. Needs its own decision — the wording is the model's only
      feedback channel.
- [ ] Publish 0.5.0 (human, 2FA). Still never installed by anyone.
- [ ] `research` has not declared `.ai/sections.json`; the extension surface is unproven by a second
      project.

## Do not repeat

- **Do not reorder the five handoff steps.** Baton before prompt, or the successor's first turn is
  refused as an intruder's and it settles in silence; prompt before baton, and a crash in between
  orphans the goal. `test/goal-handoff.test.ts` asserts the call order.
- **Do not call `herdr` from a test without injecting `HerdrDeps`.** An uninjected call submits text
  into a real pane of the developer's desktop.
- **Do not move the baton without retiring `pendingHandoff`** — see
  `.ai/pitfalls/cases/a-taken-handoff-left-the-goal-silent.md`. The continuation guard is silent while
  a handoff is pending, so the successor is never nudged and the human is paged about a handoff that
  landed.
- **Do not split a pane without naming the target.** herdr splits the last-focused pane otherwise.
- **Do not test the CLI in-process without `runCli`** from `test/helpers.ts`: it scrubs
  `PI_SESSION_FILE` / `HERDR_PANE_ID`, which now decide who holds the goal.

## Next step

**L2: the in-process timer wake transport** (`engram goal wake` is proven; `schedule-wake` has no
consumer). Read
`.ai/decisions/2026-10-18-treat-waiting-as-a-first-class-goal-state-with-a-self-wake-c.md` rule 4 (L2 is
"a background task whose only job is to wait, so its completion *is* the timer") and rule 5 (the timer
is not a long job, so a detached short-lived process is legitimate — a 16-hour job is not). Then run
**one real multi-hour goal**, which remains the largest untested assumption in the design.
