# Unquoted YAML frontmatter made every skill unloadable

**Status:** 🔴 high · **First hit:** 2026-10-02 · **Hits since:** 0

## Symptom

A project that had run `engram init` could not load any skill:

```
/data/dev/skybrain/.pi/skills/audit/SKILL.md
  Nested mappings are not allowed in compact mappings at line 2, column 14:
  description: Check consistency between the code and the memory bank: architectu…
```

Same error for `remember-pitfall`, and for `.pi/prompts/`. The files looked correct; they simply
did not parse, so Pi reported a skill conflict instead of a skill.

## Root cause

engram emitted frontmatter as an unquoted plain scalar:

```yaml
description: Check consistency between the code and the memory bank: architecture drift, …
```

A YAML plain scalar cannot contain `": "` — the parser reads the part after the colon as a nested
mapping and rejects the file. Two of the four canonical skill descriptions contain a colon-space
("…memory bank: architecture drift…" and "…`/remember-pitfall`… symptom, root cause…"), so every
carrier generated for those two skills was unloadable: 8 files across 4 sinks, plus 4 in the
consumer project that reported it.

The bug shipped because the test asserted **shape, not meaning**:

```ts
assert.match(file.content, /^description: \S/);   // passes on exactly the broken output
```

A regex cannot tell valid YAML from invalid. This is the second time in this project that a test
verified a representation rather than the thing it represents — the first was an architecture test
that read a scaffolded `ARCHITECTURE.md` and asserted nothing about this codebase.

## Fix

Every value written into frontmatter now goes through `yamlScalar()` in `src/core/yaml.ts`, which
wraps in single quotes and escapes `'` by doubling. That also makes `remember-pitfall`'s
description survive: it contains `don't`.

## Guard

- `test/frontmatter.test.ts` **parses** every generated carrier and the canonical specs with a real
  YAML parser (`js-yaml`, a devDependency — it never reaches the published tarball, and a
  hand-rolled regex would re-introduce the proxy this file exists to remove).
- Two tests target the exact shapes that broke: a description containing `": "`, and one
  containing an apostrophe.
- `validateFrontmatter()` in `src/core/yaml.ts` is the dependency-free approximation, exported so
  non-test callers can check too.

**Broader lesson:** any test asserting a *serialised* format must parse it with the real parser.
Regex on a format is a proxy, and this project has now been bitten by that twice.
