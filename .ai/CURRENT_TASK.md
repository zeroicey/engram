# Current task

**Status:** 🟡 v0.4.0 built, not published · **Updated:** 2026-10-18

## Goal

Make `.ai/` an **extension surface** instead of a fixed schema: a project adds a new L2 partition
(`.ai/journal/`) or a new skill without editing anything engram regenerates, and without waiting
for an engram release. Driven by `research`, which needs a night-by-night experiment journal and
cannot hand-edit the machine-owned contract block.

## Checklist

- [x] Four-layer model frozen (`.ai/` = 3 root files + 4 knowledge dirs + `skills/`)
- [x] Template library: decisions / sessions / pitfalls / runbooks + contract block
- [x] Four canonical skills: `/handoff`, `/remember-pitfall`, `/remember-decision`, `/audit`
- [x] CLI `init` with 9 tool adapters, meta-prompt bootstrap, idempotent rules
- [x] CLI `dump` with a hard byte budget, plus `new` and `sync`
- [x] Self-hosted `.ai/` in this repo (this file is the proof)
- [x] Published `@zeroicey/engram@0.2.0`; `0.2.1` fixes unquoted YAML frontmatter
- [x] v0.3.0: one carrier dir (`.agents/skills`), `.pi/skills` retired; tool set recorded in
      `.engram/config.json`; `dsh` (DeepSeek Harness) adapter sharing `AGENTS.md` + `.agents/skills`
- [x] **v0.4.0: `.ai/sections.json`** — project-declared partitions rendered by `sync` into every
      rule file's contract, into `dump` POINTERS, and into `engram new <section>`
- [x] **v0.4.0: `.ai/skills/*.md` is the real source of truth** — any valid file materialises into
      every carrier, not just the four built-ins; invalid frontmatter warns instead of vanishing
- [x] **v0.4.0: carrier pruning by canonical-skill-absence**, still gated on `GENERATED_MARKER`
- [x] **v0.4.0: backwards compatibility as a test** — `aiContract()` is byte-identical to the v1
      block; `sync` on `research` reports `unchanged AGENTS.md`
- [x] 147 tests green, `npm run typecheck` clean, `dump` inside budget
- [x] **2026-10-18: `init` refuses outside a git repository** — entry precondition, exit 1, no
      partial writes, `--dry-run` included, `.git` files (worktrees) accepted; 7 new tests, 154 green
- [x] **2026-10-18: six decisions recorded** for the long-running-agent line (three-layer split,
      `waiting` + self-wake, `done_when` shapes, project-scoped goal with one baton, git
      prerequisite, goal engine folded into engram)
- [ ] Publish `@zeroicey/engram@0.4.0` (the human runs `npm publish`: 2FA)
- [ ] `research` has not declared `.ai/sections.json` yet — the mechanism is ready, they decide
- [ ] **Goal engine (v0.5)**: host-free state machine + `goal_report` + continuation + wait latch,
      pi adapter only, opt-in per project. Not started — the design round is closed, M1 is next.

## Code state

Branch `main`. `src/` is 22 TypeScript modules, `test/` 9 suites, zero runtime deps. Build:
`npm run build` → `build/`; tests run against compiled output on purpose. `engram dump` renders
~1.4 KB. Nine tool adapters: `agents`, `codex`, `claude`, `cursor`, `windsurf`, `copilot`, `gemini`,
`pi`, `dsh`. Two new leaf modules this round: `src/core/sections.ts`, `src/core/skill-source.ts`.
2026-10-18 added `src/core/git.ts` (upward `.git` lookup, no subprocess) and `test/git.test.ts`.

The `init` precondition is a **command-level** check in `cmdInit`, not inside `runInit`: a refused
init must not have touched the filesystem at all, and keeping it in the command handler makes that
visible in one place. `test/helpers.ts` now creates a `.git` marker by default so every suite runs
under the real precondition; `sandboxWithoutGit()` is the escape hatch for the refusal test.

Layering held: `core/` imports nothing from `templates/`. `templates/contract.ts` declares
`ContractRow` structurally and `core/sections.ts` produces that shape, so neither layer knows the
other's type.

## Blockers

| Blocker | Waiting on | Unblock by |
| --- | --- | --- |
| `npm publish` needs 2FA | user | run it, or hand over a token |

## Pitfall reminders for the current branch

- `.ai/pitfalls/cases/read-source-after-write.md` — a function that creates a directory and then
  reads it must read *after* the write; the empty list looks like a legitimate state.
- `.ai/pitfalls/cases/destructive-cleanup-on-empty-input.md` — never let `[]` mean both "nothing
  exists" and "I could not read it"; `sync` emptied `.pi/prompts/` that way.
- `.ai/pitfalls/cases/crlf-and-bom-frontmatter.md` — `.` does not match `\r`, so CRLF frontmatter
  matched nothing at all; strip a BOM *and* slice the body from the stripped string.
- `.ai/pitfalls/cases/symlink-escapes-the-project-root.md` — a guarded pruner next to an unguarded
  `fs.writeFile` is only half a fix; `sync` overwrote a file outside `--root` through a symlink.
- `.ai/pitfalls/cases/new-line-evicts-elastic-content.md` — appending to the never-dropped section
  silently promotes the newest line above all elastic content; give a budget line its own tier.
- `.ai/pitfalls/cases/tsc-wrong-outdir.md` — `tsc` exits 0 while emitting nowhere. Check `outDir`.
- `.ai/pitfalls/cases/rule-file-rerender-nesting.md` — re-rendering must strip what it regenerates.
- `.ai/pitfalls/cases/fingerprint-table-noise.md` — regex parsing swallows Markdown tables.
- `.ai/pitfalls/cases/contract-marker-matched-in-prose.md` — markers count only on their own line.
- `.ai/pitfalls/cases/agent-scans-two-skill-dirs.md` — one agent can read two carrier dirs; check a
  new sink against that agent's docs before adding it (Pi, now also `dsh` root ranks).

## Next action

Next action, in order:

1. **M1 of the goal engine** — a host-free state machine (`running` / `waiting` / `blocked` / `done`),
   the single `goal_report` tool surface, continuation on `agent_settled`, and the wait latch. No
   pi lifecycle code in `core/`; the adapter injects triggers. Read
   `.ai/decisions/2026-10-18-fold-the-goal-engine-into-engram-instead-of-a-separate-packa.md` first.
2. Publish 0.4.0 (**human**, 2FA), then let `research` declare `.ai/journal/` themselves — that is
   the acceptance test for the extension surface, and it must be done by them, not by us.

Candidate v0.5 work, in order of leverage:
1. `engram doctor` — machine-checkable bank drift: dangling `.ai/` paths, sections whose `dir` no
   longer exists, carriers that disagree with their canonical skill.
2. `/verify` — run the project's gate and record the result (four write verbs, zero read verbs).
3. `.ai/sections.json` `file` patterns richer than `<date>`/`<slug>` — only if a real project asks.
