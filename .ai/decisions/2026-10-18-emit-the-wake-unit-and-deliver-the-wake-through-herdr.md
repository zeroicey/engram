# Emit the wake unit and deliver the wake through herdr

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey · **Supersedes:** none

## Context

M1 and M2 built the goal engine and the pi carrier, and `engram goal wake --reason` was proven
against a latched goal. Nothing **emitted** a wake, so a `waiting` goal was releasable only by a new
run or by the 24h `reconcile` escalation. The motivating case — a 7–16 hour training run — was
therefore still unsolved, because the run either lived in the agent's process tree (the
ghost-background-process failure the `waiting` state exists to fix) or had no way to report back.

`.ai/decisions/2026-10-18-treat-waiting-as-a-first-class-goal-state-with-a-self-wake-c.md` had already
fixed the *shape*: L1 in-process (no code), L2 an in-process timer, L3 out-of-process via a systemd
unit whose exit path emits the wake through herdr (rules 4, 6, 7). Two questions were still open:

- **Who writes the unit, and who runs it?** A self-written scheduler is forbidden (rule 10);
  scheduling belongs to the job runner.
- **What address does the wake go to?** A wake is addressed to the goal, not a pane (rule 6), which
  means the *delivery* command must resolve the current holder — and `goal.json` only names a pane if
  something put one there. Nothing did.

## Options

| Option | Upside | Downside | Reversibility |
| --- | --- | --- | --- |
| A. A runbook with an example unit, hand-written per project | Zero code | Every project re-derives the quoting, the `PATH`, and the `$SERVICE_RESULT` handling; the emitter stays missing | easy |
| B. `engram goal unit` emits the unit; `--deliver` posts through herdr | Testable without a scheduler; the contract lives in one place; the exit outcome is folded in by the code that also owns the wake | engram grows one leaf module that spawns a process | easy |
| C. The unit calls a shell one-liner that runs both engram and herdr | No new engram code | Hardcodes herdr's dialect into a unit file, has to survive systemd's own expansion *and* the shell's quoting, and the pane is frozen at generation time | medium |
| D. engram runs the long job itself | No systemd needed | Reintroduces exactly the process-tree coupling that made 16-hour runs unreachable | hard |

## Decision

1. **`engram goal unit <id> --job "<command>"` emits the unit; systemd runs the job.** engram never
   starts a long process. `--write` puts it in `.ai/goal/<id>/`; printing is the default, because a
   scaffolder that writes unasked is the side effect the goal carrier already had to be taught not to
   have.
2. **`ExecStopPost`, never `OnSuccess`.** A crash, an OOM kill and a `systemctl stop` must all reach
   the goal. systemd exports `$SERVICE_RESULT` / `$EXIT_CODE` / `$EXIT_STATUS` to `ExecStopPost`, and
   `engram goal wake` reads them from its own environment and folds them into the reason — on the
   command line they would have to survive systemd's `$VAR` expansion first.
3. **No shell, no expansion, absolute paths.** Every argument to the wake is its own word; the unit
   bakes in `WorkingDirectory=` (so `.ai/` resolves) and `Environment=PATH=` (a user unit does not
   inherit a login `PATH`), and names engram absolutely — through `node` when the CLI is not
   executable, because `tsc` output may be `0644`.
4. **Delivery is opt-in and resolves the holder at wake time.** `goal wake` records the token either
   way; `--deliver` additionally submits the engine's own nudge text to the pane that holds the baton
   *now*, falling back to herdr's own session table when the baton carries only a session file. A wake
   arriving after a handoff therefore reaches the successor.
5. **A failed delivery is loud, and is not a lost wake.** The token stays latched and the liveness
   deadline still recovers the goal, so the command exits 0 with an explicit `NOT DELIVERED` line
   rather than failing a unit's stop path.
6. **The baton identity is taken from the runtime environment.** `PI_SESSION_FILE` and
   `HERDR_PANE_ID` are already set for every command an agent runs (and a goal created without them
   stays unclaimed). Without this, `goal.json` never names a pane and delivery has nowhere to go.
   Explicit flags win.
7. **`waiting` remains visible only in the bank.** No daemon, no scheduler, no herdr plugin: engram
   owns the record and the delivery command, systemd and herdr own the runtime.

## Consequences

- The 16-hour shape is now buildable: the job is its own unit, the goal is parked, and the pane is
  woken on exit with the outcome attached — verified live on 2026-10-18 (`result=success code=exited
  status=0` reached `goal.json`, and the wake arrived in the holder's pane as a real turn).
- `engram` now spawns one external process (`herdr`), so `core/herdr.ts` is the second leaf module
  that touches the machine after `core/goal-eval.ts`. All of its I/O is injectable, and every failure
  mode has a distinct message.
- Env-derived identity changes *who holds a goal*: a suite that drives the CLI in-process must delete
  those variables, or its baton assertions depend on the machine and on whether it was started from a
  pane. `test/helpers.ts::runCli` does that once, for every suite.
- The `cmd:` gate runs inside the unit's `ExecStopPost` only if the user puts it there; the wake
  itself never claims success.
- L2 (an in-process timer) still has no emitter, and nothing yet schedules a unit automatically —
  `goal unit` emits a file, a human or a later milestone installs it.

## Revisit when

- The first real multi-hour goal has run with this unit (the traceability/commit rule and the 24h
  deadline are still unexercised).
- A supervisor other than systemd is needed (a container, a remote host, herdr itself) — the unit
  template is where that becomes a second emitter rather than a rewrite.
- herdr's `agent prompt` refuses a delivery often enough that a retry or a queue is warranted.
