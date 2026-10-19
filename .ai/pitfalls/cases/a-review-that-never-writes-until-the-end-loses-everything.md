# A review that never writes until the end loses everything it found

**Severity:** 🔴 high · **Date:** 2026-10-19

## Symptom

Three rounds of adversarial review, **two of them produced zero findings**. Round 1: 1 of 1 children
timed out. Round 2: 4 of 4 timed out at 30 minutes, each leaving a 46–92 byte `_reviewer_output.md`
consisting of one unfinished sentence ("Let me pin down exact line numbers for the findings"). The
transcripts in the same directories held 186–231 records and 0.8–1.1 MB each — they were reading
steadily and were *about* to write when the wall clock killed them. Round 2b repeated it: six children,
zero output files at eight minutes.

The findings **existed**. Recovering them out of the dead childrens' `thinking` blocks (5.6 MB across
four transcripts) and verifying them by hand immediately produced two real defects, one of which
(`onSettled`'s unbounded `new Date(claimedMs + limits.livenessMs).toISOString()`) is a `RangeError`
escaping `reduce()`. So the cost of this pitfall is not "we learned nothing" — it is "we paid for the
findings and then threw them away".

## Root cause

Three independent causes, and all three had to be fixed:

1. **The brief was unbounded.** Round 2's briefs each named 5–9 large files (2,400+ lines), 6–8
   invariants to restate, 6 named constructions to attempt, *and* file:line citations for every finding.
   That is hours of reading before one line of output is justifiable.
2. **Output was written once, at the end.** The result of a child run is materialised from its **final
   message**. Nothing incremental reaches disk, so a timeout loses 100 % of the work. This is fatal by
   construction, not by bad luck.
3. **The `reviewer` agent cannot write at all.** Its tool list is `read, grep, find, ls, watchdog_diff,
   contact_supervisor` — there is no `write`. So the obvious remedy ("write findings incrementally to a
   scratch file") is **not available to that agent**. Any review plan that depends on it will silently
   do nothing. An agent that *can* write is `scout` (`read, grep, find, ls, bash, write`).

Line numbers were what every child was stuck on at the moment it died: they had the finding and were
hunting for the citation.

## Fix

- **One file, or one file pair, per child.** Not one concern spanning six files.
- Check the agent's tool list before designing the workflow. If it has no `write`, either use `scout`, or
  make the deliverable small enough to fit in one final message.
- Ask for **function name + trigger**, not `file:line`. Line numbers are a citation chore; the function
  name is enough to find it.
- State a **hard budget**: "stop reading after N tool calls and report what you have."
- Launch long work **in the session that will consume it**. The predecessor launched round 2 and then
  handed off, so the completion notification went to a session that was no longer reading that pane.

## Guard

- **Salvage before relaunching.** A "failed" child is not an empty one: read its `thinking` blocks for
  finding-shaped text (`P0|P1|P2|BUG|DEFECT`) before spending another 30 minutes. Two of the three
  defects fixed after round 2 came from exactly this.
- **Ask of any long-running child:** where does its work land *before* it finishes? If the answer is
  "in its final message", a timeout is a total loss, and the brief must be shrunk instead.
- **Ask of any delegated review:** can the agent even write? A read-only reviewer plus an
  "incremental output" instruction is a no-op that reads like a plan.
