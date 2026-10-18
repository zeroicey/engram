# Treat waiting as a first-class goal state with a self-wake channel

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey

## Context

The goal loop ("do not stop until the goal is done") only covers one failure mode. Real work also
**waits**: a model trains for 7–16 hours, a subagent or a research sweep runs long, an external
system has to produce something first. During a legitimate wait, auto-nudging is actively harmful —
it burns tokens, re-reads a full context, and can preempt work that was already correctly parked.

The requirement is therefore not "never stop" but "**may stop, must be able to come back on its
own**". The agent sets its own wake condition instead of being polled.

Two things already exist and must not be rebuilt:

- `pi-background-tasks` (installed) delivers a completed task as a notification that starts a
  follow-up turn. Its limits are structural: the task runtime lives under
  `.pi/tasks/<session-id>-<pid>/`, so the job is tied to the session and process — **this is the
  "ghost background process" the user hit in practice**: start a training run, fill the context,
  switch to a new conversation, and the job is no longer reachable from the new session.
- `herdr agent prompt <agent> "..."` wakes any recognized agent pane from outside, which is the
  exact mirror of the agreed handoff path.

## Options

- **A. No waiting state.** The goal loop always nudges. *Rejected*: wastes tokens and fights
  legitimate long work.
- **B. Duration only.** `goal_wait(seconds)` with an in-process timer. Simple, but it makes the
  agent poll for something that has a real completion event, and it does not survive a handoff.
- **C. Event only.** Wait on an external condition with no fallback. Correct when the event is
  reliable, but a lost notification strands the goal.
- **D. `waiting` state, pluggable wake channels, and a liveness deadline.** *(chosen)*

## Decision

1. **`waiting` is a fourth goal state** alongside `running` / `blocked` / `done`. It is reached only
   through the explicit `goal_report(status=wait, wake_on=...)` call, never by the engine inferring
   it from a quiet turn.
2. **A wait names its wake condition, not its mechanism**: time elapsed, process exit, artifact or
   metric appearing, or human (which is `blocked`). Which transport is used is the engine's
   decision; the model never chooses a channel.
3. **Silence latches, and any event releases it.** While waiting the continuation guard is silent.
   Any new agent run — a background-task completion, a `herdr agent prompt`, a human typing, a
   subagent returning — releases the latch and normal nudge behaviour resumes on the next
   settlement. The engine does **not** identify which channel woke it; "something happened" is the
   entire test. This is what keeps the mute from becoming a dead end.
3a. **A liveness deadline bounds every wait** (default 24h configurable). If nothing arrives, the
   goal wakes itself and escalates to the human. This is a stuck detector, not a budget.
3b. **A restart must not swallow a wait.** On `session_start` the engine reads `goal.json`; if a
   wait is still latched and past its deadline, it escalates instead of staying silent.
4. **Wake transport is reused, never invented**, in three layers by expected duration:
   - **L1 in-process** — the existing background-task completion notification (no integration code
     needed: the goal only has to be silent, not to know the caller).
   - **L2 in-process timer** — a background task whose only job is to wait, so its completion *is*
     the timer.
   - **L3 out-of-process** — the job runs as its own **systemd unit**, and the wake is emitted from
     the unit's exit path (`ExecStopPost` / `OnSuccess`) via a small `goal wake <id> --reason ...`
     command that delivers through herdr.
5. **Long jobs never live inside the agent's process tree.** A multi-hour job is its own unit; the
   agent is woken, not held. This is the direct fix for the ghost-background-process failure.
6. **A wake is addressed to the goal, not to a pane.** The delivery command resolves the current
   baton holder from `goal.json` (see
   `2026-10-18-scope-the-goal-to-the-project-with-a-single-baton-and-no-wor.md`). This is what lets
   a wait survive a handoff.
7. **A wake message carries its own check.** The process exiting is not the same as the training run
   succeeding — OOM also exits. The wake states what ended and asks the agent to judge against
   `done_when`, so failure is handled by the same path as success.
8. **Wakes must be idempotent and lossy-safe**: `goal.json` records a wake token and a handled
   flag; a duplicated wake must not double-charge, and a missing one must not strand the goal
   (rule 3a covers the missing case).
9. **`waiting` is visible without spending tokens**: it is reported to the herdr sidebar as pane
   metadata, so a parked goal is distinguishable from an abandoned one at a glance.
10. **No self-written scheduler or daemon.** Scheduling belongs to the job runner (systemd / herdr);
    the goal extension is a state machine plus a wake registry. Background tasks are **not** forked,
    patched, or absorbed into the goal extension.
11. **No token, round or duration budget** on the wait or the goal. Only liveness guards
    (rule 3a and the no-progress escalations) are enforced.

## Consequences

- The goal extension stops being "a loop" and becomes "a state machine with a wake registry", which
  is a smaller and more testable thing.
- Multi-hour jobs live outside the agent process tree; the agent is woken rather than held, so a pi
  restart or a handoff no longer kills the wait.
- Rule 6 couples the wake path to herdr's agent addressing, but only for L3; L1/L2 stay free of it,
  so short waits do not need herdr at all.
- The background-task extension keeps its role (in-session parallelism) and needs no modification;
  its known cross-session limitation becomes a routing rule instead of a patch.
- Human notification of a wake or an escalation uses herdr's built-in needs-attention path first;
  anything more authoritative (e.g. the existing WeChat gateway) is a later, optional decision.

## Open questions

- Default policy when a wake fires outside working hours — fire immediately (current assumption), or
  hold until a window?
- Which layer should be the default when a wait has no explicit condition?
- Should a wake that arrives while the goal is `blocked` re-raise, or stay queued behind the human?

## Revisit when

- A real long job shows L1/L2 are sufficient in practice, making L3 unnecessary.
- herdr's notification or session-resume surface changes.
- A wait ever has to survive a machine reboot rather than a pi restart.
