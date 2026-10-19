# .ai/ — project memory bank

Portable, tool-independent memory for AI coding tools. Pi reads and writes **this directory**, and
the `.ai/` contract is tool-agnostic: any agent that can read files can follow it, so switching
tools never resets context.

## Layer model (how context is loaded)

| Layer | What | Size rule | Loaded when |
| --- | --- | --- | --- |
| L0 dynamic injection | `engram dump` fingerprint | ≤ 1.5 KB / 300–500 tokens | every new session, pasted or injected |
| L1 behaviour contract | `AGENTS.md` | < 2 KB | always, by Pi |
| L2 knowledge bank | this `.ai/` tree | unbounded | on demand, via file reads |
| L3 action specs | `.ai/skills/*.md` | ~1 KB each | on trigger, via `/handoff`, `/audit`, … |

## Map

| Path | Responsibility | Never store |
| --- | --- | --- |
| `.ai/CURRENT_TASK.md` | what is being done right now: goal, checklist, state, blockers | long history |
| `.ai/ARCHITECTURE.md` | stack, directory boundaries, core call topology, invariants | step-by-step plans |
| `.ai/decisions/` | proposals and decisions with a status machine | casual chat |
| `.ai/sessions/` | condensed handoff snapshots for a fresh session to resume | full transcripts |
| `.ai/runbooks/` | deploy / env / CI / incident SOPs | one-off trivia |
| `.ai/pitfalls/cases/` | decoded failure modes, each with cause → fix → guard | duplicate bugs |
| `.ai/skills/` | canonical, portable skill specs (`/handoff`, …) | tool-specific config |

## Operating contract (read before acting)

1. Read `.ai/CURRENT_TASK.md` first, then newest `.ai/decisions/`.
2. Pull `.ai/ARCHITECTURE.md` / `runbooks/` / `pitfalls/cases/` only when the trigger matches.
3. Write back in the same turn: decisions → `decisions/`, pitfalls → `pitfalls/cases/`, session
   ends → `sessions/`, state changes → `CURRENT_TASK.md`.
4. Status machine: `💭 PROPOSAL` → `✅ ACCEPTED` → `🪦 REJECTED`. Flip the line, keep the reasoning.
5. Never invent context you did not read. If the bank does not cover it, say so and ask.

## Naming

- `decisions/YYYY-MM-DD-<topic>.md`
- `sessions/YYYY-MM-DD-<topic>-handoff.md`
- `runbooks/<topic>.md`
- `pitfalls/cases/<case>.md`
- `_TEMPLATE.md` in each directory is the canonical shape — copy it, never edit in place.
- Skills: `.ai/skills/<name>.md`, `name` in `kebab-case` matching the command.

## Fresh-session bootstrap

```bash
engram dump            # ≤1.5 KB fingerprint → paste as the first user message
engram dump --json     # same content, machine-readable
engram doctor          # read-only health check: contract, size, drift, carriers
engram doctor --json   # same findings, one `rule` id each, for CI or /audit
engram doctor --fix    # the one mechanical fix: archive completed milestones out of CURRENT_TASK.md
```

`doctor` exits 1 only on an `error` finding, so it can gate a build. Every hint it prints is a suggestion
for the project.

`--fix` is the single exception to "read-only", and it is deliberately the narrowest rewrite engram
performs on a project's own prose: `- [x]` entries leave `CURRENT_TASK.md` and arrive **verbatim** in
`.ai/sessions/_milestone-log-archive.md`, whose `_` prefix keeps it out of the fingerprint. Nothing is
deleted, and only checked items move — a machine cannot tell which parts of a project's summary are still
load-bearing, so every other finding stays a human's call.

Project: **engram** · skeleton created 2026-10-01 by engram.
