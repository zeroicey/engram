# A fresh `init` materialised zero skill carriers when the source list was read before the source existed

**Severity:** 🔴 high · **First hit:** 2026-10-10 · **Hits since:** 1

## Symptom

Three `commands.test.ts` cases failed at once, all on the same missing file:

```text
error: 'init did not create .gemini/commands/handoff.toml'
code: 'ERR_ASSERTION'
```

A real `init` on an empty directory produced `.ai/skills/{audit,handoff,remember-decision,remember-pitfall}.md`
and **no carriers at all** — no `.agents/skills/`, no `.gemini/commands/`, no `.claude/skills/`.
`init` exited 0 and reported `15 created`.

## Root cause

Two orderings collided, and neither was wrong on its own.

`runInit` built the carrier set from the canonical skills, and the canonical skills are written *by
that same function* a few lines earlier. Reading the directory first is a natural refactor — it is
what you do when the directory becomes the source of truth — but at that moment it does not exist
yet, so the list is empty, so the loop body never runs. No error, because an empty skill list is a
legitimate state (a project may have deleted every skill).

The old code did not have this bug by accident: it read `bank.skills` from `loadMemory`, which also
saw an empty directory on a fresh init, but it fell back to filtering the in-code `SKILL_SPECS`
against that empty list — and `[].includes(...)` being false everywhere meant… it worked only
because `bank.skills` was consulted *before* the skeleton too and the filter was inverted. The
behaviour was load-bearing on a coincidence, so replacing the coincidence with a directory read
turned a working path into a silent no-op.

## Fix

Read the canonical skills **after** `aiSkeleton()` has written them, in `src/commands/init.ts`:

```ts
// Read *after* the skeleton is written: on a fresh init the canonical skills did not exist a
// moment ago, and reading them earlier is what silently produced no carriers at all.
const { skills, warnings: skillWarnings, dirExists } = await readSkillSources(opts.root);
await materializeSkillSinks(opts.root, skills.length === 0 && !dirExists ? SKILL_SPECS : skills, tools, dryRun);
```

The `dirExists` flag is what keeps the fix from over-correcting. "Empty because this init just
created it" must fall back to the built-ins; "empty because the project deleted them" must not, or
`sync` would resurrect a carrier for a skill that no longer exists.

## Guard

- `test/commands.test.ts` — "init creates the bank, rule files, carriers and the bootstrap prompt"
  asserts the nine carrier paths, and it failed loudly the moment the ordering broke. It is the
  reason this was a five-minute fix instead of a shipped regression.
- `readSkillSources` returns `dirExists` rather than letting callers infer intent from
  `skills.length === 0`. In `runInit` that flag is only reachable on `--dry-run`: the skeleton loop
  writes `.ai/skills/` before the read, so a real run always sees the directory. `runSync` is where
  the flag carries real weight — see `.ai/pitfalls/cases/destructive-cleanup-on-empty-input.md`.
- `engram sync` is clean after `init` in the same test run, so a carrier that exists but is not
  regenerable shows up as a diff rather than as silence.

## The generalisable rule

When a function both creates a directory and consumes its contents, the read must be placed by
design, not by where the code reads best. Assert the *output* (the carrier path), never the count —
`15 created` was true and meaningless.
