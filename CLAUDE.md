# engram — working agreements

> Memory lives in `.ai/`. Read on demand with file tools, **never wholesale** — an `@`-import is
> loaded in full on every session, which is exactly what the contract below forbids:
> `.ai/CURRENT_TASK.md` (state) · `.ai/ARCHITECTURE.md` (boundaries) ·
> `.ai/decisions/` (binding) · `.ai/skills/` (actions)

## Before editing anything

1. `.ai/CURRENT_TASK.md`, then the newest `.ai/decisions/`. An `✅ ACCEPTED` decision binds you.
2. `src/` is the code; `.ai/ARCHITECTURE.md` describes it. If they disagree, one of them is stale.

## Commands

```bash
npm run typecheck && npm test          # the gate; never propose a patch that skips this
node build/src/cli.js dump             # ≤1.5 KB fingerprint
node build/src/cli.js sync             # after editing any rule file
```

Single suite: `node --test build/test/commands.test.js`.

## Non-negotiables

- Zero runtime dependencies. `dependencies` stays absent from `package.json`.
- ESM + `NodeNext`: relative imports end in `.js`; type-only imports use `import type`.
- `core/` never imports from `commands/`, `adapters/` or `templates/meta-prompt.ts`.
- `templates/` performs no filesystem access — it only builds strings.
- Never edit text between `<!-- engram:contract:start -->` and `<!-- engram:contract:end -->`.
- Never edit generated skill carriers (`.claude/`, `.pi/`, `.cursor/`, `.gemini/`, `.github/prompts/`):
  edit `.ai/skills/<name>.md` and run `engram sync`.
- New public behaviour needs a test in `test/`, or a comment saying why not.

## Style

Short imperative bullets over prose. Reference real paths (`src/core/fingerprint.ts`), never
paraphrase code you have not read. When you fix a non-obvious failure, write it to
`.ai/pitfalls/cases/` via `/remember-pitfall` — a pitfall without a guard is unfinished work.

## Definition of done

`npm test` green, `npm run typecheck` clean, `engram dump` within budget, and any decision,
pitfall or state change written back into `.ai/` in the same change.

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
