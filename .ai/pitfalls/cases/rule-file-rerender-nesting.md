# Re-rendering rule files nested frontmatter, markers and shared notes

**Status:** 🟠 medium · **First hit:** 2026-10-01 · **Hits since:** 0

## Symptom

After running `engram init` (then `sync`) several times on the same repository:

```
14:_Read by: pi, codex._
16:_Read by: pi, codex._
18:_Read by: pi, codex._
20:_Read by: pi, codex._
```

Four identical shared-reader notes and four `<!-- engram:managed -->` markers in `AGENTS.md`; the
same duplication in `CLAUDE.md` and the Cursor/Windsurf/Copilot rule files.

## Root cause

`renderRuleFile` treated an existing file as an opaque body: `body = existing`, then appended the
shared-reader note, the marker and the contract. Every re-run treated the *previous generated
output* as human-authored content and added its own annotations again. The one-shot `refreshContract`
in `sync` was idempotent, so the bug was invisible in unit tests and only appeared after real
repeated `init` runs.

Second-order cause: a "second init must be a no-op" test passed because the assertion compared the
files *after* the second run against a snapshot taken *before* it, and the duplication only
accumulated from run 3 onward.

## Fix

`renderRuleFile` now strips everything it regenerates before re-composing:

```ts
const stripped = existing
  .replace(NEEDS_FRONTMATTER.has(def.kind) ? FRONTMATTER_RE : /^$/, '')
  .replace(SHARED_LINE_RE, '')
  .replaceAll(MANAGED_MARKER, '');
body = withoutContract(stripped);
```

`withoutContract` removes the delimited span; the frontmatter regex is applied **only** for the
tool formats that require frontmatter first (`cursor`, `windsurf`, `copilot`) so a horizontal rule
at the top of an authored Markdown file is never eaten.

## Guard

- `renderRuleFile(x) === renderRuleFile(x, previous)` is asserted for `agents` and `cursor` rule
  files, and for the shared-reader note (exactly one occurrence).
- The "second init" test asserts `every(file.action === 'kept')` *and* byte equality, so a third run
  is covered by the same property.
- `detectProject` ignores rule files containing `MANAGED_MARKER` when reporting pre-existing rules,
  which is what makes the generated bootstrap meta-prompt stable across runs.

Heal an already-duplicated file by deleting it and re-running `engram init`, or by hand: keep the
body above the first `<!-- engram:managed -->` and re-run `engram init`.