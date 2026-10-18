# Verify goal completion with a command, a metric, or an evidenced checklist

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey

## Context

A goal that cannot be judged cannot be enforced. "The goal must be reasonable" is not a property of
the text the user writes — it is a property of whether **completion is mechanically decidable**. If
a 12-hour run ends with "I believe it is done", the whole run is a token gamble.

Two working shapes already exist in this fleet, and they are different:

- Software work has a gate that already exists: `npm test`, `tsc --noEmit`, a lint pass. Exit code
  is the verdict, and it is not something the agent can argue with.
- Experiment work has a **number**: mAP, AUROC, an eval script's stdout. The training script writes
  it; the verdict is a comparison against a threshold.

Neither of those is "a command the agent should invent", which is what makes the third case — work
with no gate and no number — the dangerous one.

## Options

- **A. Natural-language acceptance criteria.** Flexible, unenforceable; ends in self-assessment.
- **B. A single shell command for everything.** Simple and strict, but forces the user to write shell
  to compare a number, and invites fragile `grep`/`jq` pipelines.
- **C. Three explicit shapes, strongest first** — `cmd`, `metric`, `checklist` — with the goal
  engine owning the comparison and the evidence check. *(chosen)*
- **D. Only `cmd`, no checklist.** Cleanest, but leaves legitimate work (docs, refactors, research
  notes) with no way to declare done other than lying.

## Decision

`done_when` is declared in `.ai/goal/<id>/BRIEF.md` and takes exactly one of three shapes:

1. **`cmd`** — one or more commands whose **exit code 0** is the verdict. The engine runs them; the
   model never reports its own success. Software work lands here because the project already has a
   gate.
2. **`metric`** — `{ file, path, op, value }`: the engine reads a machine-written artifact (JSON /
   CSV field) and compares. The training or eval script owns writing the file; **the engine owns the
   comparison**, so no shell quoting is involved. Experiment work lands here.
3. **`checklist`** — `.ai/goal/<id>/TASKS.md`, where **every item must carry its own evidence**
   (a command, an artifact path, a diff). An item without evidence may not be added, and "done"
   requires the evidence to be present, not asserted.

Rules that make the shape binding rather than decorative:

- **Separate "how it is judged" from "how it is reached".** `done_when` verifies; the route is the
  agent's free choice. The engine never prescribes steps.
- **The first run does not work, it classifies.** A goal starts by translating itself into one of
  the three shapes. If none of them can be produced, the goal is `blocked` immediately — this is the
  gate that stops an unreasonable goal before it burns a night of tokens.
- **A rejected shape is a real answer.** A checklist with no evidence, or a metric pointing at a file
  nobody writes, is rejected the same way an empty goal is.
- **`done` requires the engine to have observed the verdict**, not the model to report it. The
  model's `goal_report(done)` is a claim to be checked against `done_when`.

## Consequences

- "Done" becomes reproducible and re-runnable: anyone can re-execute `done_when` later and get the
  same answer, which is also what `.ai/goal/<id>/REPORT.md` records.
- The engine grows a small, testable evaluator (run command / read JSON field / check evidence)
  instead of a summarizer, which is the smaller of the two.
- Experiment projects must write their result to a stable machine-readable path. This is a
  habit-change requirement, and it is worth it: it also makes results comparable across runs.
- Checklist-style goals are structurally weaker; they are allowed, but they cannot claim the same
  strength as a command, and the brief should say so.

## Revisit when

- A goal genuinely needs a composite verdict (cmd AND metric) beyond what one shape can express.
- Metric artifacts standardise enough across projects that a shared reader is worth adding.
