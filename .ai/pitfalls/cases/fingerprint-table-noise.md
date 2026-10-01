# Markdown tables parsed as data by `engram dump`

**Status:** 🟠 medium · **First hit:** 2026-10-01 · **Hits since:** 0

## Symptom

`engram dump` emitted placeholder rows as if they were content:

```
NOW
state: 🟡 active
blocked: | Blocker | Waiting on | Unblock by |
blocked: | --- | --- | --- |
blocked: | | | |
```

The fingerprint was ~150 bytes of table scaffolding instead of the actual blocker.

## Root cause

`parseCurrentTask` reads the text under a heading and treats every non-comment line as a field
value. The `Blockers` template ships a three-column Markdown table (header, separator, empty row),
and `|`-rows are ordinary prose as far as the parser was concerned. The same applies to `- [ ]`
checkbox lines under other headings.

## Fix

In `section()` (`src/core/memory.ts`), skip lines starting with `|`, `- [`, or a `-{3,}` rule before
they reach the field extraction. Table content is either structured elsewhere or genuinely not
fingerprint-worthy — a fingerprint is a pointer, not a data dump.

## Guard

The `parseCurrentTask` test asserts that a `Blockers` section containing a Markdown table yields
`blockers: []`. Any new section parser must be tested against a real template file, not a hand-made
string that happens to be clean — the templates are where the noise comes from.