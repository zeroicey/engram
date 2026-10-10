# A guarded cleanup plus an unguarded writer is only half a fix

**Severity:** 🔴 high · **First hit:** 2026-10-10 · **Hits since:** 2

## Symptom

Two halves of the same mistake, found a day apart by two different reviewers:

**The writer.** `engram sync` overwrote a file **outside the repository**:

```bash
printf 'MY OWN NOTES — do not touch\n' > /tmp/qa-target.md
mkdir -p $P/.agents/skills/foo && ln -s /tmp/qa-target.md $P/.agents/skills/foo/SKILL.md
printf -- '---\nname: foo\ndescription: canonical\n---\n' > $P/.ai/skills/foo.md
node build/src/cli.js sync --root $P     # /tmp/qa-target.md now starts with '---'
```

A symlinked *directory* did the same at scale: `ln -s /tmp/outside $P/.agents/skills` made `sync`
create every carrier under `/tmp/outside`. Redirecting a generated directory is a real, deliberate
setup, not an exotic one.

**The deleter.** The pruner had already been hardened with a `realpath` check in the same change —
and the writer, two files away, still called plain `fs.writeFile`.

## Root cause

`fs.writeFile` and `fs.mkdir` follow symlinks. Nothing in the write path asked whether the resolved
path was still inside `--root`, because the path is *constructed* from `root` and a relative carrier
path, and a constructed path looks safe. It is not: the filesystem is what decides, not the string.

The deeper cause is that the safety property was applied **per call site** instead of per operation.
Once the pruner needed `resolvesInside`, every other function that mutates a path derived from
`root` needed it too, and the fix was recorded as "prune is safe now" rather than "writes are safe
now". A reviewer reading the diff would see a `realpath` guard and reasonably assume the class was
handled.

## Fix

`src/core/project.ts` gains two helpers, and the write path goes through them:

- `resolvesInsideRoot(root, file)` — resolves the **nearest existing ancestor**, not the parent,
  because the parent may not exist yet and creating it is the operation that escapes.
- `writeFileGuarded(root, file, content)` — refuses when the resolved path is outside; replaces a
  symlinked *leaf* with a real file (the link was a stale indirection at a path engram owns, and
  unlinking is far less destructive than writing through it); refuses a symlinked *directory*
  outright, since there is nowhere safe to put the file.

`materializeSkillSinks` returns `{ written, refused }` so a refusal is announced rather than silent.

## Guard

- `test/sections.test.ts` — "sync refuses to write a carrier through a symlink out of the project":
  asserts the outside file is byte-identical afterwards, that the leaf link became a real file, that
  a symlinked directory produces a warning, and that the outside directory stays empty.
- `test/sections.test.ts` — "pruning will not follow a symlink out of the repository" (the deleter).
- The layering test in `test/architecture.test.ts` is **not** a guard for this; it checks imports.

## The generalisable rule

When you harden one operation against a filesystem property, enumerate every other function that
mutates a path built from the same root and harden those in the same change. Grep for the *sink*
(`fs.writeFile`, `fs.rm`, `fs.mkdir`), not for the call site that prompted the fix. A guard that
exists in the file next door reads like coverage and is not.
