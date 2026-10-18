# Verify checklist evidence, and widen what counts as a metric artifact

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Amends:** `2026-10-18-verify-goal-completion-with-a-command-a-metric-or-an-evidenc.md`

## Context

M1 shipped the three `done_when` shapes and then was measured against the scenarios it exists for.
Two of them did not hold up:

1. **`metric` could not read a training log.** The reader accepted a single JSON document or a
   comma-separated table. A run that appends one JSON object per epoch — the most common long-run
   artifact there is, because a partial log stays readable mid-run — returned `path not found`. So
   the shape that exists for experiment work was unavailable to exactly that work. A CSV with a
   quoted field (`"a,b"`) silently returned the wrong column, which is worse than a failure: it
   produced a number that was not the one asked for.
2. **`checklist` evidence was a signature, not a check.** `- [x] refactor done — \`echo hi\`` passed.
   The evaluator only asked whether a backticked span existed, so any claim with backticks around it
   was accepted. The original decision called checklist "structurally weaker"; in practice it was
   self-certification, which is the failure mode `done_when` exists to prevent.

The user's verdict was explicit: fix both before the pi adapter, because the adapter needs
`engram goal wake` and the experiment scenario needs the metric shape to actually work.

## Decision

1. **A checklist item's evidence must be verifiable.** The evidence string is classified
   deterministically — no guessing at intent:
   - `path:<file>` → the file must exist.
   - `cmd:<command>` → the command must exit 0.
   - a backticked span **with whitespace** is a command (`npm test`, `git diff --quiet`).
   - a backticked span **without whitespace** is a path (`docs/goal.md`).

   An item that is checked but whose evidence cannot be verified is **not done**, and the verdict
   names which item failed and why. Checklist stays the weakest shape, but it is now a real gate.
2. **A metric artifact may be JSON, JSONL/NDJSON, or delimited text.** The delimiter is detected
   (`,` `\t` `;` `|`) rather than assumed.
3. **A bare metric path against a JSONL log means the latest record**, because the log is
   append-only and "the latest epoch" is the only reading a human means. `[0].mAP` and `[-1].mAP`
   address a specific record explicitly.
4. **An ambiguous column is a failed verdict, not a guess.** `epoch,mAP,mAP` reports that the column
   appears more than once instead of silently taking the first.
5. **A verdict message is one readable line.** The old `cmd` failure pasted a command's entire stderr
   — npm's debug-log path and syscall dump included — into both the summary and every per-check
   line. A failing gate must say *why* in one line, or the reader skips it.
6. **Relative paths in a declaration resolve against their owner.** A bare `TASKS.md` is the goal's
   own file (`.ai/goal/<id>/TASKS.md`); anything with a directory component stays project-relative
   (`out/eval.json`). `goal new --checklist` and `goal check` must agree about where the file is.

## Consequences

- Experiment work can declare `{"kind":"metric","file":"logs/train.jsonl","path":"mAP",...}` without
  writing a wrapper script, which was the whole point of the shape.
- Checklist-shaped goals (docs, refactors, research notes) can no longer be satisfied by assertion.
  The cost is one `stat` per path item and one command execution per command item — bounded, and
  paid only at verdict time.
- `evaluateDoneWhen` now has two more `EvalDeps` hooks (`pathExists`, and `run` reused for evidence
  commands), so the whole evaluator still runs in tests without touching the disk.
- A checklist that names a command now executes it. That is a real side effect, and it is the reason
  the `path:` / `cmd:` prefixes exist: a goal author who wants a pure existence check says so.

## Revisit when

- A metric artifact needs a format outside JSON/JSONL/CSV/TSV (Parquet, an MLflow run id, a database
  row). That is a reader, not a shape, and it should arrive as its own decision.
- Checklist evidence commands start having side effects that matter (a deploy, a publish). Evidence
  should stay read-only-ish; if that cannot be honoured, the shape needs a separate `verify:` verb.
