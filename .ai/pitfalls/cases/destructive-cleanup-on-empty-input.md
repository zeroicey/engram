# A destructive cleanup keyed on an empty list deletes everything when the input cannot be read

**Severity:** 🔴 high · **First hit:** 2026-10-10 · **Hits since:** 1

## Symptom

`engram sync` in a repository whose `.ai/` was missing — a wrong `--root`, a bank being moved, a
checkout that never ran `init` — deleted **every generated skill carrier** and exited 1:

```text
unchanged AGENTS.md
0 skill files materialised (recorded tool set)
pruned     .pi/prompts/audit.md
pruned     .pi/prompts/handoff.md
pruned     .pi/prompts/remember-decision.md
pruned     .pi/prompts/remember-pitfall.md
warn: No .ai/ memory bank here — run `engram init` first.
```

The command warned correctly and still destroyed the carriers. Reproduce:

```bash
P=$(mktemp -d); node build/src/cli.js init --root $P --tools pi
rm -rf $P/.ai
node build/src/cli.js sync --root $P     # .pi/prompts/ is now empty
```

## Root cause

Orphan pruning asks one question: "does this carrier have a canonical skill behind it?" It answered
it with `canonicalNames`, which came from reading `.ai/skills/*.md`. An unreadable bank and an empty
bank both produce an empty list, and the code could not tell them apart — so "no skills exist" and
"I could not find out" collapsed into the same decision, and the destructive branch took the
stronger reading.

This is the same conflation as `.ai/pitfalls/cases/read-source-after-write.md`, on the destructive
side: a sentinel value (`[]`) carrying two different meanings, where one of them is dangerous.

## Fix

`pruneStaleCarriers` no longer infers intent from a count. It takes an explicit `bankExists`, and
`runSync` passes `!needsInit`:

```ts
const pruned = (
  await pruneStaleCarriers(root, tools, skills.map((s) => s.name), { dryRun, bankExists: !needsInit })
).removed;
```

Without a readable bank there is no authority to call a carrier an orphan, so only the
retired-sink-dir branch (`.pi/skills`, a fixed historical list) still runs. `engram init`'s
`dirExists` flag is the same idea for the non-destructive path.

## Guard

- `test/sections.test.ts` — "sync with no readable bank must not delete carriers": deletes `.ai/`
  after `init` and asserts `pruned` is empty and every carrier still exists.
- `test/sections.test.ts` — "a retired sink dir is pruned, but only its generated files": the
  safety fix must not disable pruning wholesale.

## The generalisable rule

Any code that deletes on the strength of an empty collection must distinguish **"the collection is
legitimately empty"** from **"I could not read the collection"**. A default parameter of `[]` is
exactly the wrong signature: it makes the dangerous case the convenient one. Make the caller state
the precondition explicitly.
