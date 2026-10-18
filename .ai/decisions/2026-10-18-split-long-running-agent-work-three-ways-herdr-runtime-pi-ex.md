# Split long-running agent work three ways: herdr runtime, pi extension mechanics, engram memory

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey

## Context

A pi TUI session degrades as its context fills, and compaction is lossy. Work that spans hours or
days — a feature build from a spec, a training run chasing a metric — therefore needs to survive
two things a single conversation cannot: **context exhaustion** and **human approval latency**
(the agent stops and asks instead of doing the parts it can already decide).

Three capabilities were investigated separately on hpcore (herdr 0.8.2, pi 1.2.0) and each was
verified live, not read from docs:

- **herdr** can create a workspace/tab/pane, start an interactive `pi` in it, and inject the first
  message (`agent start --kind pi` → `agent prompt --wait`). Panes inherit `HERDR_ENV=1`,
  `HERDR_SOCKET_PATH`, `HERDR_PANE_ID`, so a pi extension can drive herdr with plain CLI calls.
  herdr also knows each pi session file, so a kept pane can be resumed later.
- **pi** exposes the trigger points: `ctx.getContextUsage()` (`percent`, 0–100),
  `session_before_compact` (`reason: threshold`), and `agent_before_settle` returning
  `{ continue: true, entries: [custom_message] }`, which forces another model request with no user
  input. A prototype goal loop (explicit report tool + continuation guard + round budget) stopped
  on `blocked`, continued when no report was filed, and stopped at the budget — all three verified.
- **engram** already defines the memory side: `.ai/sessions/*-handoff.md`, `.ai/CURRENT_TASK.md`,
  and a decision status machine (`💭 → ✅ → 🪦`).

The pieces only pay off combined, but they have different lifetimes and different owners.

## Options

- **A. One pi extension does everything.** Simplest artifact, but the handoff document format and
  the cross-tool memory contract would be invented inside pi-specific code.
- **B. One herdr plugin does everything.** No pi-side code, but herdr cannot see pi's context usage,
  and producing a good handoff requires the agent's own context, which a plugin process does not
  have.
- **C. Everything inside engram.** engram's value is being tool-agnostic (one `.ai/` for nine
  tools); pi-specific executable mechanics would trade that away, and engram currently ships zero
  runtime dependencies.
- **D. Split by responsibility** — runtime / mechanics / memory — with the dependency pointing one
  way. *(chosen)*

## Decision

1. **herdr owns the runtime**: windows, panes, process lifetime, crash recovery. We call its CLI and
   do not write a herdr plugin.
2. **A pi extension owns the mechanics**: goal state machine, continuation, threshold detection,
   spawning a successor. It is independent of engram and usable on its own for small tasks.
   ⚠️ **Superseded in packaging only** by
   `2026-10-18-fold-the-goal-engine-into-engram-instead-of-a-separate-packa.md`: the engine now lives
   **inside engram**, opt-in per project through the pi carrier. Rules 1, 3–11 below stand. Nothing
   here should be read as "a separate repository".
3. **engram owns the memory**: handoff documents, `CURRENT_TASK`, goal records, the "propose instead
   of blocking" rule, and the **file-name contract** the extension reads.
4. **Dependency direction is one-way**: the extension reads engram's file contract; engram never
   depends on the extension; the extension never imports engram code.5. **Handoff is agent-triggered, never code-triggered.** The extension may only *ask* ("is this a
   clean delivery point?"); the new pane is opened when the model calls a handoff tool. This is
   forced by the platform, not chosen: `ctx.newSession()` is command-only and unreachable from a
   tool (upstream issue #2488), so spawning through herdr is the only path.
6. **Context threshold defaults to 85% and is a reminder only** — it prompts the agent to judge,
   it does not force a handoff.
7. **Old panes are kept.** The cost of "keeping windows" is the pi process (measured 230–385 MB
   each), not herdr (measured 127 MB for the whole server).
8. **Every goal carries an id**, and batons are chained under `.ai/goal/<goal_id>/` so a fresh
   session knows which link it is.
9. **engram's pi carrier comes first**; other tools later. No npm publishing pressure — iterate
   locally.
10. **herdr is never downgraded**; upgrades happen fleet-wide in one pass.
11. **Not doing**: auto-closing old windows; post-completion review agents; in-process session
    switching.

## Consequences

- Each layer is testable and replaceable on its own; the extension's logic runs without a real pi
  process, and engram keeps zero runtime dependencies.
- A goal works without engram (small tasks), but cross-baton memory requires engram — so the
  handoff contract must stay stable enough to be a public interface.
- Panes become an operational budget: the ceiling is RAM, not herdr.
- The agent, not the code, decides when to hand off, so a forgotten handoff is recoverable by the
  goal loop rather than lost.

## Revisit when

- pi ships a supported agent-initiated session switch — in-process rotation becomes an option and
  rule 5 stops being forced.
- herdr's plugin API gains runtime action registration — a herdr-side implementation becomes viable.
- Kept panes start hitting RAM limits (rule 7 has to become a policy, not a default).
