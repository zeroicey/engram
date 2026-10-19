# An agent's own runtime does not belong in the project's repo

**Severity:** 🟠 medium · **Date:** 2026-10-20

## Symptom

Working a long-running goal on another project, an agent needed a watcher: poll the remote a training
phase every few minutes, exit only when a human is needed. It wrote `watch_goal.sh` and a probe
helper straight into that project's `deploy/hpou/` and committed them.

The project already had **five** per-phase watchers of its own (`watch_big.sh`, `watch_fin.sh`,
`watch_div3.sh`, `watch_queue.sh`, `watch_relay.sh`) plus `probe.py`. `watch_big.sh` was *already*
watching the exact phase in question, and its behaviour was already what the agent wanted.

## Root cause

Two categories were treated as one:

| Thing | Whose is it | Where it belongs |
| --- | --- | --- |
| the polling cadence, the exit policy, "when should I be woken" | the **agent's** | the agent's own home, or nowhere on disk |
| "what state is this phase in, on this machine" | the **project's** | the project's deploy directory |

`watch_goal.sh` is entirely the first category — it has no meaning after the session ends, and it is
not knowledge about the project. Committing it writes "an agent used this poller on 2026-10-20"
into the project's permanent history, which is noise, not a record.

The second category was also duplicated rather than reused: `probe.py` and `watch_big.sh` existed,
so the helper was a second implementation of an answer the project already knew how to give.

## Fix

- Both files removed from the project (`git rm`), committed as a revert that states why.
- The watcher now lives at `~/.pi/watchers/watch_phase.sh` — the agent's own home, disposable.
- The probe helper is delivered to the remote with `scp` and is an **untracked local file** on the
  target machine. Verified safe: `push.sh` unpacks a tarball with `tar -xzf` and never deletes, so a
  file that is not in the payload survives.

## Guard

Before adding a script to a project's repository, ask: **"would this file still be useful to a human
who cloned this repo next month, with this agent gone?"** If no, it is runtime, and it goes home.

Also: look for what already exists. A directory with five `watch_*.sh` is telling you the convention
and, more often than not, that your sixth is redundant.

## The generalisable rule

> A repository records the project, not the agent's session. Runtime that exists to serve one
> conversation must not be committed into someone else's permanent history.
