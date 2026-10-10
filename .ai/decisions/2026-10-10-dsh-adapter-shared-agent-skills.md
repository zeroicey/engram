# Support DeepSeek Harness by reusing AGENTS.md and the shared `.agents/skills`

**Status:** ✅ ACCEPTED · **Date:** 2026-10-10 · **Deciders:** lead · **Supersedes:** none

## Context

`dsh` (`@deepseek-ai/dsh`, deepseek-harness) is now a first-class agent on this machine. Making
engram "support" it needs the two seams engram actually writes to, verified against the installed
package docs rather than guessed:

- `@deepseek-ai/dsh-agent-instructions` loads `AGENTS.md`/`CLAUDE.md` from the project root down to
  the session cwd (candidates `AGENTS.md`, `CLAUDE.md`; root marker `.git`; 65,536-byte budget in
  `dsh-base`). It interprets **no** `@path` imports — a pointer must name a file and a trigger.
- `@deepseek-ai/dsh-skill-filesystem` scans `<project>/.dsh/skills` (**rank 100**) and
  `<project>/.agents/skills` (**rank 200**), one `<name>/SKILL.md` or `<name>.md` per skill,
  one level deep. `@deepseek-ai/dsh-skill` resolves duplicates **within one layer by rank,
  first-wins, with a warning**; `@deepseek-ai/dsh-tool-skill` renders the catalog and loads a body
  via the `skill` tool; a human invokes `/name`.

The honest framing: dsh already reads `AGENTS.md`, so the `agents`/`codex`/`pi` ids already cover
its instruction file, and `.agents/skills` means its skills load too. The adapter's real value is
explicitness — detection, `engram tools`, dsh-specific bootstrap guidance, and a recorded tool set
— not a new file format.

## Options

| Option | Upside | Downside | Reversibility |
| --- | --- | --- | --- |
| **A. New `dsh` tool id sharing `AGENTS.md` + `.agents/skills`** | dsh appears in `engram tools`/detection; bootstrap carries dsh-specific rules (strict skill frontmatter, one-level discovery, no `@path`, instruction budget); no new files invented | a fifth tool shares one carrier dir, so `sync --all` rewrites those 4 files once per sharing tool (identical bytes) | easy — delete the `TOOLS` entry |
| B. Document dsh as an alias of `agents` only | zero duplication, zero code | invisible in `engram tools`, undetected, no dsh-specific meta-prompt guidance, config cannot record intent | easy |
| C. Native `.dsh/skills` sink + "never two dirs one provider scans" exclusivity logic | most literal reading of "native carrier" | reintroduces exactly the Pi collision: dsh scans both roots and warns on the shadowed copy; needs a scanning-equivalence table dsh's own docs would contradict | easy but the bug class returns |
| D. No change — dsh reads `AGENTS.md` anyway | zero work | "support" is then a claim in chat, not in the registry or docs | n/a |

## Decision

Add a `dsh` tool entry to `TOOLS` in `src/adapters/index.ts`:

- **Rule file:** the shared `AGENTS.md` (`kind: 'agents'`), so the `.ai/` contract reaches
  `dsh-agent-instructions` through the file it already loads.
- **Skill carrier:** the shared `.agents/skills`, `invoke: 'plain'`. **No `.dsh/skills` sink** —
  dsh scans it and would shadow the portable carrier with a warning, so engram writes nothing under
  `.dsh/` (pinned by a test).
- **Detection:** `.dsh`, `AGENTS.md`, `CLAUDE.md`; **default tool set** gains `dsh`, so
  `engram init` wires it without flags.

dsh-specific guidance lives in its `styleGuide` and `notes`: one-level skill discovery, strict
kebab-case `name` + required `description`, no `@path` imports, the bounded instruction chain, and
the rank order that makes `.dsh/skills` shadow `.agents/skills`.

## Consequences

- `engram init --tools dsh` (and the flagless default) writes `AGENTS.md` + four
  `.agents/skills/<name>/SKILL.md`, and records `dsh` in `.engram/config.json`; `sync` inherits it.
- User-global `~/.dsh/AGENTS.md` is outside a project and stays the human's file — engram never
  writes it (same rule as `~/.codex`, `~/.claude`).
- A user who authors their own same-named skill under `.dsh/skills` will shadow the engram carrier:
  dsh rank 100 beats rank 200. The note says so instead of hiding it.
- The existing `agent-scans-two-skill-dirs` pitfall gains dsh as its second instance; its guard now
  names dsh alongside Pi.

## Revisit when

`dsh-skill-filesystem` stops scanning `.agents/skills`, or its duplicate resolution stops being
rank-ordered first-wins (either would make `.dsh/skills` the only correct sink).
