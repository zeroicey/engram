# Fold the goal engine into engram instead of a separate package

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey

## Context

`2026-10-18-split-long-running-agent-work-three-ways-herdr-runtime-pi-ex.md` put the goal engine in
its own pi extension, on the reasoning that engram is tool-agnostic and pi-specific executable
mechanics would dirty that. The user's verdict overrides the packaging part of that decision:

> 把 goal 做进 engram 里面去，单独分开也不太好。

The reason is practical rather than aesthetic. A goal is **only useful together with its memory**:
the brief, the task list with per-item status, the handoff between batons, `CURRENT_TASK.md`, the
PROPOSAL/ACCEPTED rule for "decide for yourself or ask", and the closing report are all `.ai/`
artifacts. Keeping the engine in a second repository would mean two version lines, two test suites,
and a hand-written "file-name contract" between them that can silently drift — while the engine is
still, in practice, engram-shaped.

The counter-argument must still be honoured: `engram` is published to other people's repositories,
keeps zero runtime dependencies, and must not start executing agent lifecycle code in every project
that installs it.

## Options

- **A. Separate package** (what the earlier decision said). Clean tool boundaries, but the goal
  engine and the memory contract evolve in lockstep and would be split across two repos.
- **B. Everything in engram, no gate.** Simplest to write, but installs pi lifecycle hooks into any
  repository that runs `engram init`, including non-pi projects.
- **C. In engram, opt-in per project, enabled by the pi adapter only.** *(chosen)*
- **D. In engram as a plain CLI subcommand, no pi integration.** Would keep the process clean but
  abandons the three trigger points the engine needs (`agent_settled`, `session_before_compact`,
  `getContextUsage`), without which there is no goal mode at all.

## Decision

1. **The goal engine lives in this repository**, as a first-class part of engram rather than a
   sibling project.
2. **It is inert unless a project opts in.** The pi carrier gains a goal surface
   (`.pi/extensions/` materialised by `engram sync`, plus a goal skill); a project without that opt-in
   gets memory and skills exactly as today, and no lifecycle hooks.
3. **The CLI stays clean.** No `main()` path runs git operations, process supervision, or hooks; the
   goal engine is reachable from the extension entry, not from `engram dump`. It reads registry files
   (bare directories and files, e.g. `.git`) and does not shell out to git inside engram.
4. **Zero runtime dependencies still holds.** The engine is TypeScript compiled by `tsc`, like
   everything else here. Anything that needs a dependency does not go in.
5. **The memory formats are unchanged.** A goal uses the existing `.ai/` contract — a new
   `.ai/goal/<id>/` partition declared through `.ai/sections.json`, the existing session handoff
   template, and the existing decision status machine. No parallel memory system is introduced.
6. **The host (pi) is injected, not imported.** The engine takes its trigger points and its model
   call through an adapter layer, so the logic is testable without a pi process — the same shape
   that made the previous extension cheap to test.
7. **Publishing stays unpressured.** Nothing ships to npm until the flow has been exercised locally
   on real work; the package name and version line are a later decision.
8. **Platform order is pi first.** Other carriers (`claude`, `codex`, `cursor`, …) keep the memory
   contract only; a goal surface for them arrives only if a real need appears.

## Consequences

- One repository, one test suite, one version line for memory and mechanics; a change to the goal
  state machine and a change to the handoff format can land in one commit.
- engram grows a second kind of code (executable lifecycle logic next to a scaffolder). The layering
  rules in `AGENTS.md` and `test/architecture.test.ts` now matter more, and the `core/` leaf must
  stay host-free.
- A project that installs engram but never opts in sees no behavioural change — the opt-in gate is
  what keeps the published surface honest.
- The earlier decision's three-layer split stays true in substance (herdr runtime, engram memory +
  mechanics); only the packaging changed, so its text needs a pointer here rather than a rewrite.

## Revisit when

- A second host needs the goal engine with genuinely different trigger semantics (that would justify
  extracting it back out).
- The published engram package's size or surface becomes a problem for non-pi consumers.
- `engram` starts needing a runtime dependency to support the engine — that would break rule 4 and
  should reopen this decision rather than quietly adding the dependency.
