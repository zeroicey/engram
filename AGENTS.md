# engram — agent instructions

Portable project memory + scaffolder for Pi. Node ≥ 20, ESM-only TypeScript, **zero
runtime dependencies**, built by `tsc` alone.

## Commands

```bash
npm install                 # devDependencies only: typescript, @types/node
npm run typecheck           # tsc --noEmit
npm run build               # tsc -> build/  (bin lives at build/src/cli.js)
npm test                    # build + node --test build/test/*.test.js

node --test build/test/fingerprint.test.js      # one suite
node --test --test-name-pattern 'fingerprint' build/test/*.test.js
node build/src/cli.js init --dry-run
node build/src/cli.js sync
node build/src/cli.js dump --json
node build/src/cli.js goal status          # the active goal, or why there is none
node build/src/cli.js config --goal on     # opt into the goal engine (writes a pi carrier on sync)
```

`tsconfig.json` `outDir` and `package.json` `bin` must name the same directory. A green `tsc` exit
code does **not** prove output landed where `bin` expects (see `.ai/pitfalls/cases/tsc-wrong-outdir.md`).

## Layout

| Path | Owns |
| --- | --- |
| `src/cli.ts` | argv parsing, dispatch, human output |
| `src/core/` | leaf layer: fs helpers, project detection, `.ai/` parsing, declared sections, skill sources, fingerprint budgeting, and the **host-free goal engine** (`goal.ts` state machine, `goal-store.ts`, `goal-eval.ts`, `goal-host.ts`) |
| `src/templates/` | contract block and its row tables, `.ai/` skeleton, built-in skill specs, bootstrap meta-prompt. No fs access |
| `src/adapters/` | the one-entry registry (Pi) and renderers for AGENTS.md and the skill carriers |
| `src/commands/` | `init`, `dump`, `new`, `sync`, `goal` orchestration (`sync` dispatch lives in `cli.ts`); `goal-carrier.ts` writes the opt-in `.pi/extensions/engram-goal.ts` |
| `test/` | 13 `node:test` suites, incl. `architecture.test.ts` which enforces the layering |
| `.ai/` | this project's own memory bank (dogfooded) |

Dependency rule: `core/` imports nothing from `commands/`, `adapters/` or `templates/meta-prompt`.
`templates/` never touches the filesystem. That is what keeps the pipeline testable in memory.

## Conventions

- ESM only, `NodeNext` module resolution: every relative import ends in `.js`.
- `verbatimModuleSyntax` is on: use `import type` for type-only imports.
- `noUncheckedIndexedAccess` is on: `arr[0]` is `T | undefined`; handle it.
- Files are small and single-purpose. When a function needs a second responsibility, extract it
  rather than adding a branch (this is why `fitToBudget` exists outside `buildFingerprint`).
- No runtime dependency, ever — see `.ai/decisions/2026-10-01-zero-runtime-dependencies.md`.
- The contract block between `<!-- engram:contract:start -->` and `<!-- engram:contract:end -->` is
  machine-owned. Never hand-edit it; `engram sync` overwrites it.
- Canonical skills live once in `.ai/skills/*.md`. Tool carriers under `.agents/` and `.pi/`
  (including the goal extension) are generated - edit the canonical file and run `engram sync`.
  Pi reads `.agents/skills/`; do not add a `.pi/skills/` copy (same skill name, two scanned
  dirs, collision warning at every startup).
- `.ai/` is an extension surface, not a fixed schema. A new L2 partition is declared in
  `.ai/sections.json` and reaches every rule file on `engram sync`; a new skill is just
  `.ai/skills/<name>.md` with `name` + `description` frontmatter. Both are project-owned files
  engram reads and never writes — which is why hand-editing the derived contract block is never
  the right move.
- `tsconfig.json` `include` covers `src/` and `test/`; output lands in `build/{src,test}`.

## Definition of done

1. `npm test` passes (256 tests today, `node --test` on compiled output).
2. `npm run typecheck` is clean.
3. `node build/src/cli.js dump` stays inside its byte budget.
4. Behaviour that the memory bank records — an invariant, a decision, a pitfall — is written back
   in the same change, using `/remember-decision`, `/remember-pitfall` or `/handoff`.
5. `engram sync` is clean afterwards: no unexpected `updated` rule files, no `missing canonical skill`.

## Sandboxed agents

- Read-only by default; ask before `git commit`, `git push`, `npm publish`, `git tag`.
- `npm test` writes only inside the repository and `os.tmpdir()` sandboxes.
- Network is not needed for anything except `npm install` / `npm publish`.
- Never rewrite `.ai/` history: decisions are flipped (`💭` → `✅` → `🪦`), not deleted.

## herdr window rules (hard)

One herdr **space is one project** here. Never put several projects in one space, and never place a
window in another project's space.

- A handoff opens the successor with `herdr tab create --workspace <this space> --no-focus --label …`.
  **Never `pane split`** — it narrows the human's window on every handoff.
- The space is resolved by `successorWorkspace` (`src/commands/goal.ts`): `HERDR_WORKSPACE_ID`, then
  `herdr pane get <pane> → result.pane.workspace_id`, then **refuse**. Never rely on herdr's implicit
  "focused workspace" — focus is a human's click, not a property of the goal.
- Do not open a probe window in a space you do not own; close every window you open while testing.

## Address herdr by ID, never by name (hard)

Labels are for humans and change at any time — an auto-updating tab renames itself, a space gets
renamed, a pane's title follows whatever runs in it. Address everything by the identifier herdr
issues, and treat every label as display-only:

| Use this | Never this |
| --- | --- |
| `workspace_id` (`w13`) | workspace `label` / `number` |
| `tab_id` (`w13:t1`) | tab `label` / `number` |
| `pane_id` (`w13:p2`) | pane `label` / `terminal_title` |
| `agent_session.value` (the session file path) | the agent `name` |

What survives a herdr **server restart** was measured on hpstation with herdr 0.8.2 — server stopped,
started again as a headless process, `persist.restore outcome="ok"` in the log:

| Field | Before → after | |
| --- | --- | --- |
| `workspace_id` | `w4` → `w4` | stable |
| `tab_id` | `w4:t1` → `w4:t1` | stable |
| `pane_id` | `w4:p1` → `w4:p1` | stable |
| `terminal_id` | `term_65e1f20c…` → `term_65e1f2cb…` | **changes on every spawn** |
| `revision` | `0` → `1` | a counter, not an identity |

The structure survives; **the process inside the pane does not** — the restored pane held a fresh shell,
and the agent that had been running was gone. So `pane_id` is a durable address for a *container*, and
`agent_session.value` is the address for an *agent*. Anything that must reach an agent needs both, tried
in that order; anything that must reach a *place* may use the pane id alone. Renames are safe either way
(`tab rename` / `workspace rename` change only the label and the ids keep resolving), and a closed pane
answers `pane_not_found`, so an id is a real handle rather than a name lookup. Tab *numbers* are the least
stable of all — they shift when another tab closes.

<!-- engram:managed -->

<!-- engram:contract:start v1 -->
## Project memory bank (`.ai/`) — required contract

This repository keeps a portable, tool-independent memory bank in `.ai/`. It outranks chat
history and your own recollection. Read it on demand with file tools; never paste it wholesale.

### Read before you act

1. `.ai/CURRENT_TASK.md` — the current goal, in-progress state and blockers. Read this first.
2. Newest-first scan of `.ai/decisions/` for `💭 PROPOSAL` / `✅ ACCEPTED` entries that touch
   your task. An accepted decision is binding; a proposal needs a verdict, not silent adoption.

### Read on demand (trigger → file, not a bulk preload)

| Trigger | Read |
| --- | --- |
| changing architecture, stack, module boundaries | `.ai/ARCHITECTURE.md` |
| deploy, env vars, CI, incidents, ops | `.ai/runbooks/<topic>.md` |
| a bug that feels familiar / "we fixed this before" | `.ai/pitfalls/cases/<case>.md` |
| resuming after context loss, compaction or a long session | newest `.ai/sessions/*-handoff.md` |
| brainstorming a direction, before writing code | `.ai/decisions/` (write a `💭 PROPOSAL`) |

### Write back (not optional)

| Event | Write |
| --- | --- |
| a choice that is expensive to reverse | `.ai/decisions/YYYY-MM-DD-<topic>.md` via `/remember-decision` |
| a pitfall you hit, or a silent failure mode you decoded | `.ai/pitfalls/cases/<case>.md` via `/remember-pitfall` |
| ending a session with unfinished or fragile work | `.ai/sessions/YYYY-MM-DD-<topic>-handoff.md` via `/handoff` |
| any change to goal, state or blockers | `.ai/CURRENT_TASK.md` (same edit turn, never "later") |

Rules of the bank:

- One file per topic, `YYYY-MM-DD-<kebab-topic>.md`, status header on line 1 of the body:
  `💭 PROPOSAL` → `✅ ACCEPTED` → `🪦 REJECTED`. Flip the status, never rewrite history.
- Keep entries short and factual. The bank is an index of decisions, not a diary.
- Canonical skill specs live in `.ai/skills/*.md`. If your tool can load them, load them; if
  it cannot, this table is the fallback contract — follow it literally.
- If the bank and the code disagree, the bank is stale: fix the bank in the same change.
<!-- engram:contract:end -->
