# Changelog

## 0.5.0 — Pi only (breaking)

`engram` was an adapter for nine AI coding tools. It is now a tool for **Pi**, and the subtraction went
all the way down rather than stopping at the registry: the code paths only the removed clients could
reach are deleted, not left as branches with a single legal value.

### Removed clients

`claude`, `codex`, `cursor`, `windsurf`, `copilot`, `gemini`, `dsh`, and the generic `agents` entry.
`AGENTS.md` is still written — `pi` reads it — but it is no longer shared with anything.

See `.ai/decisions/2026-10-18-serve-pi-only.md`, and the decision it supersedes
(`2026-10-18-reduce-supported-clients-to-pi-claude-code-and-codex.md`) for the reasoning about *how* a
client is supported.

### Breaking changes

| What | Before | Now |
| --- | --- | --- |
| `engram init --tools a,b,c` | selected the clients to configure | **removed.** Passing it warns and is ignored. |
| `engram sync --tools … \| --all` | limited the sync | **removed.** Passing it warns and is ignored. |
| `.engram/config.json` | `{version: 1, tools: [...], goal}` | `{version: 2, goal?}`. A v1 file still parses — `tools` is ignored, `goal` is preserved — and `sync` rewrites it to v2. |
| Rule files | `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, `.github/copilot-instructions.md`, `.github/instructions/*`, `GEMINI.md` | `AGENTS.md` only |
| Skill carriers | per-tool dirs plus `$ARGUMENTS`/`{{args}}`/`.prompt.md` variants | `.agents/skills/<name>/SKILL.md` and `.pi/prompts/<name>.md` |
| `rules.ts` / `skills.ts` public shapes | `RuleFileKind` union, `SkillSink.invoke`, `prompt-toml`, per-sink `prefix`/`suffix`/`frontmatter` | gone |

### Migrating a repository

`engram sync` does the mechanical part and reports the rest:

1. **Carrier directories are pruned automatically** — `.pi/skills`, `.claude/skills`,
   `.cursor/skills`, `.github/prompts`, `.gemini/commands`. Only files carrying engram's own
   `<!-- engram:generated -->` header are deleted; a hand-written file in one of those dirs survives,
   and a directory emptied by pruning is removed.
2. **Rule files are reported, never deleted.** `sync` warns with the exact path. A rule file may hold a
   human-authored body that `init` deliberately preserves, so there is no marker that would make
   deletion safe. Delete them yourself once you have read them.
   - `CLAUDE.md` deserves a note: **Pi reads it too.** A leftover one does not merely go stale, it puts
     a second copy of the contract into every session.
3. **`.engram/config.json` is upgraded to v2** on the first `sync`, preserving `goal.enabled`.

The `.ai/` bank itself was never tool-specific, so nothing in your memory needs to change.

### Fixed

- **A retired carrier dir is pruned whatever filename shape it holds.** The pruner enumerated four
  built-in skill names × three hard-coded filename shapes, so Copilot's `<name>.prompt.md` matched none
  of them and survived every `sync` in every repository that had ever used that adapter. It now
  enumerates the directory; the safety property was never the name list, it is the generated-marker
  check.

## 0.4.0

Extension surface: `.ai/sections.json` for project-declared partitions, `.ai/skills/*.md` as the real
source of truth for any number of skills, `engram new <declared-section>`, carrier pruning by
canonical-skill absence, and the git precondition on `init`.

## 0.2.1

Fixed unquoted YAML frontmatter in generated skills: two of the four descriptions contain a
colon-space, which a YAML plain scalar cannot hold, so every carrier was rejected by the parser with
"nested mappings are not allowed".

## 0.2.0

First published release.
