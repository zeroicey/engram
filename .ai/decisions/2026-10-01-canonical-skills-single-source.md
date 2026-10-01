# Canonical skills in `.ai/skills/`, materialised per tool

**Status:** ✅ ACCEPTED · **Date:** 2026-10-01 · **Deciders:** lead architect

## Context

Layer 3 has four actions (`/handoff`, `/remember-pitfall`, `/remember-decision`, `/audit`) that must
be reachable from Claude Code, Pi, Cursor, Windsurf, Copilot and Gemini CLI. Each tool has a
different native mechanism: directory-of-directories (`SKILL.md`), flat `.md` with `$ARGUMENTS`,
`.mdc` rules, `.toml` commands, prompt files. Tools with no mechanism at all still have to follow
the behaviour, via the Layer 1 contract.

Writing each skill four to eight times guarantees the copies drift. Writing it once leaves the
question: where does the one copy live, and how do the tools find it?

## Options

| Option | Upside | Downside | Reversibility |
| --- | --- | --- | --- |
| A. Author per tool (`.claude/skills/…`, `.pi/skills/…`, …) | each is idiomatic | 6 copies drift within a week; fixes must be replayed by hand | easy per file, painful in aggregate |
| B. One canonical file per skill in `.ai/skills/`, CLI copies into every sink | one source of truth, `engram sync` re-materialises, drift is impossible | sinks are generated files a human might edit (solved with a generated marker) | easy |
| C. Symlinks | no duplication | breaks on Windows, and trust prompts on some tools | medium |
| D. Only Layer 1 prose, no per-tool carriers | zero files | no `/handoff` anywhere; prose compliance is unreliable | easy |

## Decision

Option B. `.ai/skills/<name>.md` holds one canonical spec per skill, with Agent-Skills-compatible
frontmatter (`name`, `description`) so it is loadable as-is where that spec is honoured.

`src/adapters/index.ts` declares, per tool, its `skillSinks`: `agent-skills` (one `<name>/SKILL.md`
per skill), `prompt-md-args` (slash command with `$ARGUMENTS`) or `prompt-toml` (Gemini `{{args}}`).
`engram sync` regenerates every carrier from the canonical file, stamping
`<!-- engram:generated -->` plus the source path.

Tools with no native skill mechanism get nothing but the Layer 1 contract, which names
`.ai/skills/*.md` as the passive fallback. That is deliberate: a text description of the trigger
plus "read `.ai/skills/<name>.md`" is enough for a competent model.

## Consequences

- The skill body must stay tool-neutral: no tool-specific syntax, only a literal `ARGUMENTS` token
  that each carrier rewrites. Enforced by convention, reviewable in one diff.
- `SKILL_SPECS` in `src/templates/skills.ts` is the single authoring surface.
- Adding a tool means adding a registry entry, not writing skills again.
- `runSync` warns when a canonical skill file is missing from `.ai/skills/`.

## Revisit when

Agent Skills becomes the universally-supported format (then `agent-skills` sinks for every tool and
the carriers disappear), or a tool offers a programmatic skill API worth generating code for.