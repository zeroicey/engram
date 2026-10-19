# Review round 2 on the 25 fixes, then a local trial in a chosen repo, then push (no publish, no tag)

**Status:** 🎯 ACTIVE · **Created:** 2026-10-19

## Goal

Review round 2 on the 25 fixes, then a local trial in a chosen repo, then push (no publish, no tag)

## Done when

The engine owns this verdict. It runs it; the agent never reports its own success.


The verdict was declared when this goal was created:

```json
{
  "kind": "cmd",
  "commands": [
    "npm test"
  ]
}
```

### The three shapes, strongest first

```json
{ "kind": "cmd", "commands": ["npm test", "npm run typecheck"] }
```

```json
{ "kind": "metric", "file": "out/eval.json", "path": "eval.mAP", "op": ">=", "value": 0.85 }
```

```json
{ "kind": "checklist", "file": "TASKS.md" }
```

- **`cmd`** — every command must exit 0. The project's own gate belongs here.
- **`metric`** — the engine reads a machine-written artifact (JSON, JSONL/NDJSON, CSV/TSV) and does
  the comparison itself, so no shell quoting is involved. A bare `mAP` against a JSONL log means
  *the latest record*; `[0].mAP` and `[-1].mAP` address a specific one.
- **`checklist`** — every item must be checked **and** carry evidence that the engine can verify:
  a backticked path (`docs/goal.md`), a backticked command (`npm test`), or an explicit
  `evidence: path:<file>` / `evidence: cmd:<command>`. A path must exist; a command must exit 0.

## Not the goal

- Work that only *looks* finished. "Tests pass" is a verdict; "the code looks right" is not.
- A route. How the goal is reached is the agent's choice; this file only says how it is judged.

## Notes

<!-- Anything the agent needs that is not a step-by-step plan. Delete this comment when you add text. -->
