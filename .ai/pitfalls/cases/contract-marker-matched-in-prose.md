# Structural markers matched inside prose deleted the contract block

**Status:** 🔴 high · **First hit:** 2026-10-01 · **Hits since:** 0

## Symptom

After regenerating this repository's own rule files with the newly hardened code, `engram sync`
reported every rule file as `skipped`, and `AGENTS.md` had lost its contract block entirely:

```
$ node build/src/cli.js sync
skipped   AGENTS.md
skipped   CLAUDE.md
$ grep -c 'engram:contract:start v' AGENTS.md
0
```

Exit code 0. Nothing in the output said "content deleted".

## Root cause

Two failures compounded.

1. **`withContract` refuses to write when markers look unbalanced.** That guard is correct in
   principle — it exists because an unpaired marker used to make the splicer cut a fixed 29 bytes
   out of the file. But `inspectMarkers` counted *any* occurrence of the marker text, including
   occurrences inside prose. `AGENTS.md` documents the contract like this:

   ```
   - The contract block between `<!-- engram:contract:start -->` and
     `<!-- engram:contract:end -->` is machine-owned. Never hand-edit it.
   ```

   The inline `<!-- engram:contract:end -->` was read as a closing marker with no opener, so the
   file looked damaged, `withContract` returned the input untouched, and the contract block was
   dropped from all seven rule files.

2. **The damaged file then stayed damaged.** The conservative guard is also the recovery path's
   blind spot: once the contract was gone, `inspectMarkers` still saw the stray inline end marker
   and reported `unbalanced`, so no later `init` or `sync` could restore it. One bad run needed a
   manual deletion to escape.

## Fix

A marker is structural only when it *is* the line:

```ts
function ownsMarker(text: string, marker: string): boolean {
  return text.trim() === marker;
}
```

Both `findContractSpan` and `inspectMarkers` now use it. Inline prose mentions are invisible to
them, the file is correctly reported as `absent`, and the contract is written normally.

The same regeneration also surfaced a second accumulation bug: `mergeFrontmatter` returned the
**whole file** when a rule kind had no frontmatter defaults (`.github/copilot-instructions.md`),
splicing a copy of the body in front of the body on every render — the managed marker went
1 → 3 across three runs. It now returns an empty string.

## Guard

- `REGRESSION a rule file documenting the markers in prose keeps its contract`: builds a file whose
  body mentions both markers inline, asserts the contract is still written, the prose survives,
  and a re-render is a no-op.
- `every rule kind is stable across three render passes`: a blunt net for the whole bug class —
  seven rule kinds, each asserted byte-identical after three renders with exactly one marker and
  exactly one contract.
- `REGRESSION a rule file kind with no frontmatter does not accumulate duplicates` for the
  `mergeFrontmatter` case specifically.
- Marker *count* is the observable that caught this. `grep -c 'engram:managed' <file>` after each
  regeneration is a two-second check worth repeating whenever templates change.

**Why this is worth recording:** the guard that fixed one data-loss bug created another, and no
unit test failed — the first two regenerations looked fine. The loss only became visible because
someone ran the tool on the repository that documents the tool.