# Serve Pi only

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey
**Supersedes:** `2026-10-18-reduce-supported-clients-to-pi-claude-code-and-codex.md` (same day: nine → three → one)
**Breaking:** yes, deliberately.

## Context

The previous change in this session cut nine clients to three (`claude`, `codex`, `pi`) and the user's
verdict on reading it back was immediate:

> 算了算了算了 全删了吧 只服务 PI 了 Break change

The reason it landed that way is worth recording, because it is the argument against the *shape* of
the previous decision rather than against its direction. Three clients still requires:

- a rule-file *kind* union and the frontmatter dialect that came with it,
- a registry indirection (`ruleFilesFor`, "also read by", shared-carrier de-duplication),
- a per-project tool set in `.engram/config.json`, `--tools`/`--all`, a four-way `scope`
  resolution (`config` / `inferred` / `flags` / `all-tools`) and `inferToolsFromDisk` to guess the
  scope for repositories that predate the config,
- three style guides, three sets of vendor claims, three things to re-verify.

All of that machinery exists to answer "which of N clients is this project using". With one client the
question has one answer, so every piece of the machinery is a branch with a single legal value.

## Options

- **A. Keep three.** Already reviewed and shipped in this session. Rejected by the user.
- **B. Pi only, registry entry left in place with the multi-tool plumbing intact.** Smallest diff,
  and it leaves `--tools`, the scope resolution and the config's `tools` array describing a choice
  nobody can make. That is the "unreachable code cannot be verified either" problem the previous
  decision identified, kept one level up.
- **C. Pi only, plumbing deleted.** *(chosen)*
- **D. Inline Pi into `init` with no registry at all.** Fewest lines, but then nothing records *why*
  there is one client, and the next adapter arrives as a scattered edit rather than a decision.

## Decision

1. **`TOOLS` has exactly one entry: `pi`.** `test/adapters.test.ts` asserts the count and the id, so a
   second client cannot appear without a new decision file. That review step is what the original nine
   adapters never had, and it is why six of them shipped stale claims.
2. **`RuleFileKind` is gone; `RuleFileDef` is `{ path, note }`.** One rule file, `AGENTS.md`,
   plain Markdown. The `cursor`/`windsurf`/`copilot` frontmatter machinery was already deleted in the
   previous step; the `kind` field was what was left of it.
3. **`SkillSink.invoke` is gone.** It existed to say `/skill:<name>` (Pi) versus `/<name>` (Claude
   Code, Codex). Pi uses `/skill:` for an Agent Skill and `/` for a prompt template, so the carrier
   kind already determines it.
4. **`.engram/config.json` is v2 and holds no tool list.** A `tools: ["pi"]` array is a list with one
   legal value — an extensibility story the product no longer tells. A v1 file still parses (its
   `tools` key is ignored, which is the whole migration) so an existing `goal.enabled` survives; `sync`
   rewrites it to v2.
5. **`--tools` and `--all` are removed, and passing them warns.** The argv parser ignores unknown flags
   by design, so `engram init --tools claude` would otherwise *succeed* while doing something different
   from what the caller asked. A break change must be loud.
6. **`inferToolsFromDisk`, `knownTools`, `staleToolIds`, `resolveSyncTools` and the `scope` field are
   deleted.** With one client the sync scope is a constant.
7. **`alsoReadBy` and the `_Read by: …_` note are gone.** They listed the sibling tools sharing
   AGENTS.md. A re-render strips a stale note from an upgraded repository rather than refreshing it.
8. **`CLAUDE.md` joins `RETIRED_RULE_FILES`.** Pi reads `AGENTS.md` *and* `CLAUDE.md` as context
   files, so a leftover `CLAUDE.md` from the removed Claude Code adapter does not merely go stale — it
   puts a second copy of the contract into every Pi session. `sync` reports it; it does not delete it,
   because the file may contain a human-authored body.

## Consequences

- `src/adapters/` is 3 files and ~200 lines, down from ~330 at nine clients. `core/config.ts` lost its
  only reason to import `adapters/`, so the layering allowlist in `test/architecture.test.ts` shrank
  from two exceptions to one — the suite failed until the stale entry was deleted, which is what that
  test exists for.
- A repository upgrading from an older engram gets: its removed carrier dirs pruned, each stale rule
  file named in a warning, and a v2 config. Nothing is deleted without a generated marker.
- **The break is real and stated**: `--tools`/`--all` no longer exist; a `tools` key in the config is
  ignored; `CLAUDE.md`, `GEMINI.md` and the Cursor/Windsurf/Copilot rule files stop being refreshed.
- Knowledge that lived only in the Claude Code and Codex style guides is gone with them. It is in this
  repository's history, and the two decisions that introduced those adapters are still on disk.
- The `.ai/` bank itself was never tool-specific, so a project migrating away from Pi keeps its memory
  intact — that was the point of the layering, and this is the first time it has been cashed in.

## Revisit when

- A second client is genuinely in use on this fleet. The cost is the *conventions*, not the registry
  entry, which is exactly why this decision makes the registry entry the cheap part and the decision
  file the required part.
- Pi's own conventions change (its skill dirs, its context-file cascade, its extension API). With one
  adapter there is one vendor claim left to re-verify, and `test/adapters.test.ts` names it.
