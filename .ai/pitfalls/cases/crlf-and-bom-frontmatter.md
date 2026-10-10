# CRLF frontmatter parses to nothing because `.` does not match `\r`

**Severity:** 🟠 medium · **First hit:** 2026-10-10 · **Hits since:** 1

## Symptom

A `.ai/skills/<name>.md` with CRLF line endings was reported as broken and got no carrier:

```text
warn: .ai/skills/crlf.md: "description" is required — it is the routing signal the model sees
```

The file was correct. It opened fine in every editor; only the parser disagreed. A UTF-8 BOM
produced a different, equally wrong message:

```text
warn: .ai/skills/bom.md: no YAML frontmatter — add `---\nname: bom\ndescription: …\n---`
```

## Root cause

Two independent parser assumptions, both false:

1. **`\r`.** Frontmatter was split with `frontmatter.split('\n')`, leaving a trailing `\r` on every
   line, and fields were matched with `/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/`. JavaScript's `.` matches
   every character **except** line terminators — and `\r` is one of them. So `(.*)$` could not reach
   the end of a CRLF line and **every field failed to match**. The regex was not "mostly right with
   trailing whitespace"; it matched nothing at all, which is why the error was the misleading
   "description is required" rather than a parse error.
2. **BOM.** `readFile(..., 'utf8')` keeps a leading `\uFEFF`, which is not whitespace, so
   `^---` did not match at position 0. A file that is byte-for-byte valid frontmatter plus a
   three-byte prefix was reported as having no frontmatter.

Both are produced routinely: any Windows editor, and any checkout with `core.autocrlf=true` or a
PowerShell `>` redirect. This was found by feeding the parser CRLF and BOM'd input directly, not by
reading the code — the code looks correct at a glance.

## Fix

`src/core/skill-source.ts`:

```ts
const stripBom = (raw: string): string => (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
for (const line of frontmatter.split(/\r?\n/)) { … }
```

And the body slice must use the **stripped** string — `text.slice(fm.index + fm[0].length)`, not
`raw.slice(...)` — or a BOM'd file is off by one and loses its first body character. That
off-by-one is invisible in the frontmatter and only shows up in the carrier's text.

## Guard

- `test/sections.test.ts` — "CRLF and BOM frontmatter parse the same as LF": asserts `name`,
  `description` **and** `body` for LF / CRLF / BOM / BOM+CRLF, all four against the same expected
  values. Asserting the body is what catches the BOM off-by-one; asserting only the description
  would pass while the carrier was subtly truncated.

## The generalisable rule

When hand-parsing a text format, test the encodings a real checkout produces, not just the one your
editor writes. And prefer asserting the *whole* parsed result over the field you happen to be
thinking about — the BOM bug and the CRLF bug lived in the same function and needed different
assertions to see.
