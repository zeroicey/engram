# Open the successor pane when the model asks for a handoff

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey · **Supersedes:** none

## Context

M4 of the long-running-agent line. `goal_report(status=handoff)` already set `pendingHandoff`, and the
effect carried the instruction *"open the successor pane and transfer the baton"* — with nothing able
to open one. The engine could therefore notice that a handoff was owed and, after the liveness window,
escalate; it could never deliver the goal to anyone.

The constraint that shaped the whole design was already decided
(`2026-10-18-split-long-running-agent-work-three-ways-herdr-runtime-pi-ex.md` rule 5): **handoff is
agent-triggered, never code-triggered.** `ctx.newSession()` is command-only and unreachable from a
tool (upstream #2488), so the successor pane has to come from herdr, and only because the model asked
for a handoff in that call. No lifecycle hook may decide to spawn an agent.

Two hard questions remained:

- **Which pane inherits the goal?** `pane split` with no target splits whatever pane the client last
  focused — a probe put the successor in a *different workspace* than the goal.
- **How does the successor become the holder?** The baton is only claimed by `goal new` / `goal baton`.
  A placeholder identity would make the transfer a lie, and prompting before the transfer gets the
  successor's first `run-started` refused as an intruder's, after which it settles in silence.

## Options

| Option | Upside | Downside | Reversibility |
| --- | --- | --- | --- |
| A. The extension spawns pi itself with `child_process` | No herdr dependency | Invents a second runtime next to herdr, and the pane is not herdr's, so the human cannot see or focus it | hard |
| B. A human runs `engram goal handoff` after the model reports | No new spawn path | The whole value is an *unattended* handoff at 3am; requiring a human defeats M4 | easy |
| C. `engram goal handoff` drives herdr: split → start → baton → prompt *(chosen)* | One runtime, one order, testable without herdr (all I/O injectable); the successor's identity is real, taken from `agent start`'s own answer | engram now depends on herdr's CLI shape, so a herdr change can break it | easy |
| D. Prompt first, then transfer | Simpler success path | A successor whose first turn was refused settles silently — the failure is invisible | easy |

## Decision

1. **The model asks, engram spawns.** `goal_report(status=handoff)` records the request through the
   reducer; the generated extension reacts to `reason === "handoff requested"` by calling
   `engram goal handoff --json`. No lifecycle event opens a pane.
2. **Five steps, in this order: record → split (beside the holder's pane) → start → transfer the baton
   → prompt.** Each prefix is a state the next step depends on; reordering them is a defect, not a
   preference.
3. **The successor's identity comes from herdr's answer**, never invented: `agent start` reports
   `result.agent.agent_session.value`. A baton transfer with an unknown session path would be a claim
   the record cannot support.
4. **A failed prompt rolls the baton back and leaves `pendingHandoff` set.** An orphaned goal is worse
   than a failed handoff; an erased request would hide a handoff that never landed.
5. **Taking the baton clears `pendingHandoff`.** The continuation guard is silent while a handoff is
   pending — correct while one is *owed*, a silent stall once it has been taken.
6. **Outside herdr, refuse before touching the record.** `HERDR_ENV !== '1'` means there is no runtime
   to open a pane with; recording an untakeable request would only produce a false escalation. The
   failure names the alternative: report blocked and let a human open a pane.
7. **`--no-focus`.** The successor is created beside the predecessor without stealing the human's
   keyboard.
8. **The handoff prompt names files instead of summarising them** (`.ai/CURRENT_TASK.md`, the newest
   handoff, `.ai/goal/<id>/BRIEF.md`). A summary would be a second, staler copy of the bank.

## Consequences

- The baton is now the stop signal: after the transfer the predecessor fails `holdsBaton`, so its
  `settled` events are ignored and it cannot keep driving. "Stop after handing off" is enforced by the
  engine, not by the model's discipline.
- A handoff is observable while it happens — pane id, successor session path, and each step's outcome
  are printed (and returned as one JSON document for the extension).
- engram now calls two herdr verbs whose response *shapes* it reads (`pane split`, `agent start`). A
  shape change surfaces as an explicit failure (`answered without a pane id`), never as a wrong pane.
- L1/L2 transports are unaffected: a wake still reaches whichever pane holds the baton, including one
  created this way.
- Nothing yet *decides* to hand off except the model's own judgement (prompted by the 85% reminder),
  which the split decision requires and which remains the honest place for that call.

## Revisit when

- The first real handoff happens on a long goal and the successor turns out to need more than the
  bank (a summary of uncommitted intent, say).
- herdr grows a direct "resume this session in a new pane" verb, which would replace split + start.
- Two goals in one project are allowed, at which point "beside the holder's pane" needs to become a
  per-goal layout rule.
