# Scope the goal to the project with a single baton and no worktree yet

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey

## Context

Three questions had to be answered together, because each one changes the other two:

- **What is a goal attached to?** A conversation, or a project? The fleet currently runs six pi
  sessions in `/home/oicey/kb` at once. A conversation-scoped goal would mean six candidates for
  "who is driving", and the moment a handoff creates a seventh, the old one looks abandoned.
- **Can several goals run at once?** The user's model is one big goal per project, where the agent
  is a captain that spawns subagents and accepts their work. Parallel goals in one project would
  mean two writers to one `CURRENT_TASK.md`.
- **How is the working tree protected?** The risk is not deletion (an agent does not usually delete
  code); it is **untraceability** — a goal that rewrites files for 20 rounds with no commits leaves
  one giant diff nobody can bisect, mixed with whatever the human was editing.

herdr can back each goal with its own `git worktree` (`herdr worktree create --branch goal/<id>`,
which also opens a workspace). That solves traceability properly, but it is also a workflow the user
has not used yet, and it only works for git repositories.

## Options

- **A. Conversation-scoped goal, worktree per goal.** Cleanest isolation, but ownership is fragile
  across handoffs and the worktree concept has to be learned first.
- **B. Project-scoped goal, no worktree, no per-round commits.** Simplest to explain; traceability
  depends entirely on the agent's commit discipline.
- **C. Project-scoped goal, single baton, commits in the main checkout; worktree deferred.**
  *(chosen)*
- **D. Project-scoped goal, worktree mandatory.** Would exclude every non-git project, including the
  one live competition project, and adds a concept before its value is felt.

## Decision

1. **The goal belongs to the project**, recorded in `.ai/goal/<id>/goal.json` inside the repository.
   The conversation is only where the goal is currently being worked on.
2. **Exactly one baton per project.** `goal.json` names the current holder (`session_path`,
   `pane_id`, `holder_started_at`). Only the holder nudges, waits, hands off, or gets woken; every
   other session in the same directory is an ordinary conversation. A handoff transfers the baton.
3. **One goal per project at a time.** Starting a new goal requires closing the previous one
   (done, cancelled, or explicitly abandoned), mirroring the single-baton rule.
4. **The agent is the captain**: it may spawn subagents and is responsible for accepting their
   output. The goal engine does not manage subagents, and there is no reviewer agent in this version.
5. **No worktree in round one.** The goal runs in the project's normal checkout. Instead,
   **traceability is mandatory**: the agent commits at every settlement boundary (at minimum one
   commit per N rounds, and always before a handoff), so `git log` remains a bisectable trail.
   A goal whose project is not a git repository is refused — which is consistent with
   `2026-10-18-require-a-git-repository-before-engram-initializes.md`.
6. **Worktree stays a documented option, not a default.** It is revisited when the user has run a
   multi-hour goal at least once and can judge the isolation cost against the traceability benefit.
7. **No token, round or duration budget.** Two liveness guards replace budgets, because they detect
   a stuck goal rather than ration a productive one: the same `blocked` reason repeated N times
   escalates to the human, and K consecutive rounds with no file change escalate too.

## Consequences

- Ownership survives handoffs: the identity is in the project, so a new pane takes the baton rather
  than becoming a second driver, and a closed pane does not orphan the goal.
- Commit discipline becomes a hard part of the contract; an agent that never commits makes the
  traceability guarantee false, so the handoff checklist must verify it.
- Parallelism happens **across projects**, not inside one. Several projects can each run their own
  goal without coordination.
- The known non-git project (`fundus-glaucoma-triage`) cannot host a goal until it gains a
  repository — an accepted limitation, not an oversight.
- Deferring worktrees keeps round one small; the cost is that a failed long run must be recovered
  from commits rather than by deleting a checkout.

## Revisit when

- The first multi-hour goal has run and the traceability/isolation trade-off can be judged from
  experience.
- A project needs two goals at once for a real reason (not convenience).
- Per-round commits turn out to be too noisy for a repository's history.
