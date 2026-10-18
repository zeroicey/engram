# Reduce the supported clients to Pi, Claude Code and Codex

**Status:** 🪦 SUPERSEDED (same day — nine → three → one) · **Date:** 2026-10-18 · **Deciders:** zeroicey
**Superseded by:** `2026-10-18-serve-pi-only.md`

> The reasoning about *how* to subtract (delete the unreachable code, prune carrier dirs, report rule
> files, never delete a file without a marker) all carried forward and is still how the code works.
> What changed is the endpoint: three clients still needed the registry indirection, the tool-scope
> resolution and the config tool list, and the user cut that to one.

## Context

engram shipped nine tool adapters. Each one is not a config entry: it is a vendor's conventions
encoded by hand — a rule-file path, a skill-carrier syntax, a frontmatter dialect, a style guide for
the bootstrap meta-prompt — and every one of them has to be re-verified when the vendor changes
anything. `.ai/ARCHITECTURE.md` §6 already recorded the consequence: "a review already found six
stale or invented claims".

The user's instruction:

> 把支持的客户端先减到只有 PI Claude Code 和 Codex。

Three clients, chosen because they are the ones actually in use on this fleet and the ones whose
authoring conventions are stable enough to keep honest.

## Options

- **A. Keep all nine, mark the rest "community-supported".** Cheapest, but a vendor label is a
  maintenance promise whether or not it is labelled as one. Six unmaintained adapters is six claims
  rotting silently.
- **B. Remove the entries, keep the rendering code.** Looks smaller in `engram tools`, changes
  nothing real: the frontmatter machinery, the TOML carrier and the Copilot dialect stay as
  unreachable branches that still need to compile and still imply support.
- **C. Remove the clients *and* everything only they could reach.** *(chosen)*
- **D. Rewrite the adapter layer as a plugin system first.** The right shape for nine+ clients, and
  premature for three. Revisit if the count grows again.

## Decision

1. **Three adapters: `claude`, `codex`, `pi`.** `DEFAULT_TOOL_IDS` is exactly those three.
2. **The generic `agents` entry is removed too.** It was not a client — it was the AGENTS.md carrier,
   and its label enumerated six tools of which one survives. `AGENTS.md` is still written: `codex`
   and `pi` both claim it, and both now say so in their own notes. Its generic authoring advice
   ("keep it under ~200 lines", "scope down with subdirectory files") moved into `codex`'s style
   guide rather than being deleted with the entry.
3. **The subtraction goes to the bottom.** `RuleFileKind` is `'agents' | 'claude'`; the
   `cursor`/`windsurf`/`copilot` frontmatter machinery (`NEEDS_FRONTMATTER`, `FRONTMATTER_RE`,
   `hasUnterminatedFrontmatter`, `defaultFrontmatter`, `mergeFrontmatter`) is deleted; the
   `prompt-toml` carrier and the `copilot` frontmatter dialect are deleted; `prompt-md-args` loses
   its `prefix`/`suffix`/`frontmatter` options. Two carrier shapes remain.
4. **`pi` gains the `.agents/skills` sink.** It previously relied on another adapter to write the
   skills it reads, so `init --tools pi` produced AGENTS.md and four prompt templates but **no
   `SKILL.md` at all** — the skills it advertised were not loadable. The dir is now claimed by both
   `codex` and `pi`; `materializeSkillSinks` de-duplicates by path so it is written once.
5. **Removed carrier dirs are pruned; removed rule files are only reported.** `.cursor/skills`,
   `.github/prompts` and `.gemini/commands` join `.pi/skills` in `RETIRED_SINK_DIRS`, so `sync`
   deletes the generated files inside them. The five rule files land in `RETIRED_RULE_FILES`, and
   `sync` **warns without deleting**: a rule file may contain a human-authored body, `init` preserves
   it on purpose, and there is no marker that would make deletion safe.
6. **`sync` repairs a config that still names a removed tool.** Reads already filter through
   `getTool`, so a stale id was harmless to *use* — but `engram config` printed the filtered set
   while the file said something else, and the file is the record of what the project chose.
7. **Re-adding a client is a decision, not an edit.** `test/adapters.test.ts` asserts the registry is
   exactly `['claude', 'codex', 'pi']`, so a new adapter cannot arrive without this file changing.

## Consequences

- 68 source lines and 6 test cases deleted; `dump` unchanged; carrier writes in a three-tool project
  drop from 32 files to 12 (one shared `.agents/skills` instead of two copies).
- Knowledge that lived only in the deleted style guides is gone. It is recoverable from this
  repository's history, and the two decisions that introduced those adapters are still on disk.
- A project that installed the removed carriers gets a warning naming each stale rule file, and its
  carrier dirs are cleaned automatically. Nothing is lost silently and nothing is deleted without a
  marker.
- The rule-file frontmatter code was *entirely* unreachable after the removal. Keeping it would have
  been the same mistake as trusting an untested adapter: code that cannot run cannot be verified
  either.

## Revisit when

- A fourth client is genuinely in use on this fleet. The cost of an adapter is the *conventions*,
  not the registry entry — a shared-carrier client (something else that reads `AGENTS.md`) is nearly
  free, and a tool with its own frontmatter dialect is a day.
- The three remaining vendors change their formats, which would argue for the plugin shape (option
  D) rather than three hand-encoded adapters.
