# M3 L3: the wake transport — handoff

**Date:** 2026-10-18 · **Branch/Commit:** `main` @ `de1546f` (this session's work is uncommitted at
write time; the commit that carries it follows immediately) · **Duration:** one session

## Where we ended

The goal engine can now **come back on its own**. `engram goal unit <id> --job "…"` emits a systemd
unit that runs a long job outside the agent's process tree, and the unit's `ExecStopPost` calls
`engram goal wake --deliver`, which folds the unit's own exit outcome into the reason and submits the
engine's nudge to the pane that holds the baton *now*, through herdr.

This was verified live, end to end, on `hpcore` — not in a test harness:

```
ExecStopPost → engram goal wake --deliver
  wake wake-1 accepted: goal unit 2026-10-18-m3-l3-wake-… exited (unit result=success code=exited status=0)
    status: running
    deliver: delivered to w13:p1
```

The wake arrived in the holder's pane as a real turn, and reporting `done` then closed the goal on an
`done_when` verdict **the engine ran itself** (`npm test`, `1 command(s) exited 0`). The closed record
is committed under `.ai/goal/2026-10-18-m3-l3-wake-transport-…/`.

Before that, the round started by committing the two prior session's work, which had been sitting
uncommitted: `d62ed87` (Pi-only + goal engine M1–M2) and `de1546f` (the memory bank).

## What changed

| File / area | Change | Why |
| --- | --- | --- |
| `src/templates/systemd.ts` | new: `goalUnitSource`, `goalUnitName`, `systemdWord`, `unitOutcome`, `engramCommand` | the unit is a pure string; `ExecStopPost` not `OnSuccess`; no `$`, no shell, `%` escaped |
| `src/core/herdr.ts` | new: `herdrPromptArgs`, `paneForSession`, `paneForSessionPath`, `promptPane` | the last hop. Sessions resolve to panes via herdr's own agent table; every failure mode a distinct message |
| `src/commands/goal.ts` | `runGoalUnit`, `resolveEngramCommand`, `identityFromEnv`, `deliverNudge`; `runGoalWake` gained `--deliver` + unit-outcome folding | the emitter and the delivery policy |
| `src/cli.ts` | `goal unit`, `wake --deliver`; identity defaults on `new`, `baton`, **and `event`** | the runtime is where the identity already is |
| `test/helpers.ts` | `runCli(args, identity)` scrubs the identity variables | see the pitfall below |
| `test/goal-unit.test.ts` | new suite (25 cases) | template, herdr, emitter, delivery, identity |
| `.engram/config.json`, `.pi/extensions/engram-goal.ts` | goal enabled; carrier written | dogfooding: this repo now runs the loop it builds |

## Verified / unverified

- [x] tested: 281 tests green, `tsc` clean, `dump` 1434/1500, `engram sync` reports `unchanged AGENTS.md`
- [x] tested live: systemd unit parses (`systemd-analyze --user verify`, exit 0), the job ran, the
      wake fired from the exit path with `result=success code=exited status=0` folded in, herdr
      delivered to `w13:p1`, the goal left `waiting`, and a `done` report closed it on `npm test`
- [ ] assumed, NOT tested: the `node <script>` branch of `resolveEngramCommand`. On this machine
      `build/src/cli.js` is `0755` (npm chmods a `bin` target), so the live unit called it directly.
      The non-executable branch has unit tests only — the `.ai/pitfalls/` claim that `tsc` emits
      `0644` is true of a fresh checkout, not of this working copy
- [ ] assumed, NOT tested: a multi-hour job, and therefore the 24h liveness deadline and the
      commit-at-settlement rule. The live job was `sleep 25`
- [ ] assumed, NOT tested: `--deliver` against a **parked** session (a pane with no live turn). The
      live delivery went to a working pane; herdr's `agent_blocked` refusal path is unit-tested only

## Loose ends

- [ ] L1 and L2 have no emitter: L1 needs none by design (a new run releases the latch), L2 (an
      in-process timer) is still only a `schedule-wake` effect with no transport
- [ ] Nothing *schedules* a unit. `goal unit` emits a file; installing it is manual. That is
      deliberate, but it is the remaining gap between "the shape works" and "it runs unattended"
- [ ] M4: `goal_handoff` still only sets `pendingHandoff`; nothing opens a successor pane
- [ ] An ignored event is invisible to the model. `responseFromEffects` maps only `nudge` →
      `message` and `escalate` → `notify`, so a refused report returns `ok: true` with `message:
      null` and the extension settles silently. Found while testing the baton refusal; **not fixed**
      — out of scope for L3, and it deserves its own decision because the wording is the model's
      entire feedback channel
- [ ] Publish 0.5.0 (human, 2FA)

## Do not repeat

- **Do not call `herdr agent prompt` from a test.** `test/goal-unit.test.ts` injects `HerdrDeps` for
  exactly this reason: an uninjected call would submit text into a real pane of the developer's
  desktop.
- **Do not test the CLI in-process without scrubbing `PI_SESSION_FILE` / `HERDR_PANE_ID`** — use
  `runCli` from `test/helpers.ts`. See `.ai/pitfalls/cases/ambient-identity-silently-re-owns-the-goal.md`.
- **Do not read a baton refusal from `ok` or the exit code.** `ok: true` means "well formed"; the
  refusal is `effects[0].reason`.
- **Do not put the long job in the unit's `ExecStart` and then poll for it.** The unit *is* the
  notification; polling re-creates the token burn the `waiting` state removed.
- **Do not fold a `%` or a `$` into a unit file unescaped.** `%` is a systemd specifier; `$` is
  expanded before engram sees it. Both are covered by tests in `test/goal-unit.test.ts`.

## Next step

**M4: `goal_handoff` opens a successor pane through herdr and transfers the baton.** The pieces now
exist — `herdr agent prompt` is proven, `identityFromEnv` records a pane, `goal baton --pane` already
transfers — so M4 is mostly the missing spawn (`herdr agent start` / `workspace` creation) plus the
baton handover wired to the `handoff` effect. Read
`.ai/decisions/2026-10-18-split-long-running-agent-work-three-ways-herdr-runtime-pi-ex.md` rule 5
first: **handoff is agent-triggered, never code-triggered**, and `ctx.newSession()` is unreachable
from a tool.

Then run **one real multi-hour goal** — that is still the largest untested assumption in the design,
and it is now cheap to attempt: the unit emitter and the delivery path are both proven at this scale.
