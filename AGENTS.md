# engram — agent instructions

Portable project memory + scaffolder for AI coding tools. Node ≥ 20, ESM-only TypeScript, **zero
runtime dependencies**, built by `tsc` alone.

## Commands

```bash
npm install                 # devDependencies only: typescript, @types/node
npm run typecheck           # tsc --noEmit
npm run build               # tsc -> build/  (bin lives at build/src/cli.js)
npm test                    # build + node --test build/test/*.test.js

node --test build/test/fingerprint.test.ts.js   # one suite
node --test --test-name-pattern 'fingerprint' build/test/*.test.js
node build/src/cli.js init --tools agents,claude --dry-run
node build/src/cli.js sync
node build/src/cli.js dump --json
```

`tsconfig.json` `outDir` and `package.json` `bin` must name the same directory. A green `tsc` exit
code does **not** prove output landed where `bin` expects (see `.ai/pitfalls/cases/tsc-wrong-outdir.md`).

## Layout

| Path | Owns |
| --- | --- |
| `src/cli.ts` | argv parsing, dispatch, human output |
| `src/core/` | leaf layer: fs helpers, project detection, `.ai/` parsing, fingerprint budgeting |
| `src/templates/` | contract block, `.ai/` skeleton, skill specs, bootstrap meta-prompt. No fs access |
| `src/adapters/` | per-tool registry and renderers for rule files and skill carriers |
| `src/commands/` | `init`, `dump`, `new`, `sync` orchestration |
| `test/` | `node:test` suites run against compiled output in `build/test/` |
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
- Canonical skills live once in `.ai/skills/*.md`. Tool carriers under `.claude/`, `.pi/`, `.cursor/`,
  `.gemini/`, `.github/prompts/` are generated — edit the canonical file and run `engram sync`.
- `tsconfig.json` `include` covers `src/` and `test/`; output lands in `build/{src,test}`.

## Definition of done

1. `npm test` passes (52 tests today, `node --test` on compiled output).
2. `npm run typecheck` is clean.
3. `node build/src/cli.js dump` stays inside its byte budget.
4. Behaviour that the memory bank records — an invariant, a decision, a pitfall — is written back
   in the same change, using `/remember-decision`, `/remember-pitfall` or `/handoff`.
5. `engram sync` is clean afterwards: no unexpected `updated` rule files, no `missing canonical skill`.

## Sandboxed agents (Codex, Pi)

- Read-only by default; ask before `git commit`, `git push`, `npm publish`, `git tag`.
- `npm test` writes only inside the repository and `os.tmpdir()` sandboxes.
- Network is not needed for anything except `npm install` / `npm publish`.
- Never rewrite `.ai/` history: decisions are flipped (`💭` → `✅` → `🪦`), not deleted.

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
