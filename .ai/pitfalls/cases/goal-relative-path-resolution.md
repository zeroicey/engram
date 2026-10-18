# A declaration's relative path resolves against its owner, not the project root

**Severity:** 🟠 medium · **Date:** 2026-10-18

## Symptom

`engram goal new "write docs" --checklist` created `.ai/goal/<id>/TASKS.md` and printed success.
Immediately afterwards, `engram goal check` reported:

```
❌ 2026-10-18-write-docs — TASKS.md is missing or unreadable
```

The tool contradicted its own output. Nothing was wrong with the file; it was in the place the
template had just written it to.

## Root cause

`done_when: {"kind":"checklist","file":"TASKS.md"}` is a *bare* filename, and the evaluator resolved
it with `path.join(root, 'TASKS.md')` — the repository root. The declaration lives in
`BRIEF.md` inside `.ai/goal/<id>/`, and `TASKS.md` is a sibling of that file, not of the repo.

The same class of bug applies to `metric.file`: a goal's artifact is usually project-relative
(`out/eval.json`), but a bare `result.json` written next to the goal is not.

## Fix

`resolveDoneWhen()` in `src/commands/goal.ts`: a file with **no directory component** resolves
against the goal directory; anything with a `/` (or an absolute path) stays as written. That keeps
`out/eval.json` project-relative and `TASKS.md` goal-relative without a second config field.

## Guard

`test/goal-cli.test.ts` — "--checklist creates TASKS.md and verifies evidence" runs `new` and then
`check` in the same sandbox. The bug was invisible to `goal-store.test.ts` because those tests pass
absolute paths to `EvalDeps`, which is exactly the blind spot: unit tests on the evaluator cannot see
a caller that resolves the path wrongly.
