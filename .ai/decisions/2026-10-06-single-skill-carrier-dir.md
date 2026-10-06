# One Agent Skills carrier dir: drop `.pi/skills`, record the tool set at init

**Status:** ✅ ACCEPTED · **Date:** 2026-10-06

## Symptom

Every Pi session in `engram` and `skybrain` printed four `Skill conflicts` blocks at startup:

```text
"audit" collision:
  ✓ auto (project)  /data/dev/engram/.pi/skills/audit/SKILL.md
  ✗ /data/dev/engram/.agents/skills/audit/SKILL.md (skipped)
```

## Cause

Two independent faults, both invisible in a single repo:

1. **Duplicate carrier for one agent.** Pi scans `.pi/skills` *and* `.agents/skills` (pi docs,
   "Add it to Pi": "Pi also supports the Agent Skills locations `~/.agents/skills/` and
   `.agents/skills/`"), and "Name collisions keep the first discovered skill and produce a
   warning." engram materialised the same four skills into both, because the `pi` tool declared a
   `.pi/skills` sink while the `agents`/`codex` tools declared `.agents/skills`.
2. **`sync` had no memory of the user's tool choice.** `runSync(root, [])` fell back to *every*
   tool in the registry, so one `sync` wrote 32 carrier files and created `.gemini/commands`,
   `.windsurf/rules` and a second `.pi/skills` set for a repo that asked for one agent. The
   collision was therefore guaranteed by the ordinary workflow, not a corner case.

## Options

| | Option | Verdict |
| --- | --- | --- |
| A | Drop the `.pi/skills` sink; Pi reads `.agents/skills` natively | ✅ chosen |
| B | Keep `.pi/skills`, suppress `.agents/skills` when pi is selected | rejected — conditional, and Codex loses its portable carrier |
| C | Generic scanning-equivalence dedupe across sink dirs | rejected — a table Pi's own docs would contradict |
| D | Rename skills per dir (`pi-audit`) | rejected — destroys portability, the whole point of the dir |

Sync scope: record the tool set in `.engram/config.json` at `init`; `sync` inherits it, `--all`
overrides. Repos predating the file get an inference pass over existing rule files and carrier
dirs, then the result is persisted — so an old repo is scoped to what it actually uses instead of
re-deriving "all eight tools".

## Consequences

- `.pi/prompts/` stays (prompt templates have no portable equivalent); `.pi/skills/` is gone.
- One carrier per skill per repo, so 32 generated files drop to 4 for a single-tool repo.
- Pruning is restricted to *retired* sink dirs (`RETIRED_SINK_DIRS`), never to "dirs the current
  flags did not pick": `sync --tools agents` narrows writes, it must not delete working Claude
  carriers. Deletion additionally requires `GENERATED_MARKER` in the file, so
  `research/.pi/skills/net-access/SKILL.md` survives untouched.
- `engram 0.3.0`.