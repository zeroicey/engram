# The fingerprint strips underscores inside identifiers

**Severity:** 🟡 low · **Date:** 2026-10-18

## Symptom

`CURRENT_TASK.md` said, in prose:

```
Wire `agent_settled` → the continuation guard
```

`engram dump` rendered:

```
next: … Wire agentsettled → the continuation guard, …
```

The host hook name lost its underscore, and the same happened to `session_before_compact`. Nothing
failed; the fingerprint simply carried an identifier that does not exist.

## Root cause

Two steps compound in `src/core/memory.ts`:

1. `cleanInline()` does `.replace(/[*_`]/g, '')` — it strips **every** `*`, `_` and backtick, on the
   assumption that they are Markdown decoration.
2. `paragraph()` applies it to the section's prose, so the mangled text is what the fingerprint
   renders.

For emphasis (`_word_`) that is correct. For a `snake_case` identifier it is destructive: the
backticks that would have marked it as code are removed by the same call, so there is no way to
write the name safely in a memory section.

## Fix

In the document that feeds the fingerprint, write the identifier with the spelling the fingerprint
survives — `agent settled`, `run started`, or a dashed slug — and keep the exact name in
`.ai/ARCHITECTURE.md` and code comments, which are not parsed.

For the code: strip only *paired* emphasis markers, or leave inline code spans intact, and add a
test that `dump` round-trips a `snake_case` name from `CURRENT_TASK.md`.

## Guard

`test/fingerprint.test.ts` has no case for an identifier with an underscore in `CURRENT_TASK.md`,
which is why this shipped. The test to add mirrors the "deliberately broken `CURRENT_TASK.md`"
cases: seed a `## Next action` line containing `agent_settled`, then assert `dump` still contains it.
