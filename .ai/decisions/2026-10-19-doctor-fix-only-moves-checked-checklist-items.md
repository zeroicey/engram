# `doctor --fix` only moves checked checklist items — it never rewrites prose

**Status:** ✅ ACCEPTED · **Date:** 2026-10-19 · **Deciders:** zeroicey

## Context

`engram doctor` reported the size problem in every repository that used the bank — 144, 253, 301, 474 and
537 lines against a ~60-line guidance — and the contract's remedy is "move history to `.ai/sessions/`".
Nothing could do that, so the remedy was advice, and advice lost to the fact that appending a `- [x]` is
free while deleting one feels like losing history.

That is a real asymmetry, not a discipline problem: the file is read on **every** session start, so its
growth is a per-session cost, while the entry that grows it was paid for once, by whoever finished the work.

## Decision

1. **`--fix` does exactly one thing**: move `- [x]` entries (with their indented continuation lines) out of
   `CURRENT_TASK.md` into `.ai/sessions/_milestone-log-archive.md`, verbatim, and leave a one-line pointer
   where they were. `doctor` is otherwise read-only and stays that way.
2. **Nothing is deleted.** A completed milestone's reasoning is the answer to a later reader's "did we
   already try that?", so it changes file, not existence. The archive is **appended** to, never rewritten:
   a second run must not lose the first run's entries, and a human may have added notes under the heading.
3. **Only checked items move.** Prose, open items, tables and headings are untouched. A machine cannot tell
   which parts of a project's own summary are still load-bearing, and a tool that guessed would be a second
   writer of the file the human already owns. Every other finding `doctor` prints stays a human's call.
4. **The archive is inert by naming.** `.ai/sessions/_milestone-log-archive.md` — the `_` prefix keeps it out
   of the fingerprint's RECENT block. Measured before the rename: the archive was a 122-byte line in a
   1500-byte digest, competing with real handoffs.
5. **`- [x] …` is not a milestone.** The scaffold ships it as an example of the shape; moving it put an
   ellipsis in the archive and told the next reader a milestone had been completed. Found by running
   `--fix` on a fresh `init`.
6. **Idempotent, and the pointer is updated rather than duplicated.** A second run finds nothing to move and
   reports "nothing to compact"; a later run rewrites the count on the existing pointer line.

## Consequences

- This repository: 301 lines → 107, with 44 milestones archived and nothing lost. `engram doctor` reports
  healthy, and the pointer tells the next reader where the history went.
- Three adopting repositories now have a supported way to act on the `error` that `doctor` reports about
  them, without engram touching their prose.
- The remaining `doctor` findings still have no automatic fix, which is intentional: "which of these two
  `## Goal` paragraphs is still true" is not a question a regex can answer.

## Revisit when

- A project asks `--fix` to do more. The honest next candidate is the same move applied to *other*
  mechanically-identifiable history (a `## 上一轮` section, say), but each one needs its own evidence that
  the section is historical rather than load-bearing.
