# `engram doctor` is read-only, and `absent` is not `empty` is not `broken`

**Status:** ✅ ACCEPTED · **Date:** 2026-10-19 · **Deciders:** zeroicey

## Context

The seven repositories that adopted the bank were audited by hand, as shell loops, and everything the
loops found was **invisible to `engram` itself**:

- `clip`, `research` and `teleport` had rewritten `CURRENT_TASK.md` into prose and lost the `## Goal` /
  `## Next action` / `## Code state` headings, so their fingerprints silently dropped `project:` /
  `next:` / `branch:`. `research`'s NOW block was **zero bytes** — the file that exists to say what to do
  said nothing, and nothing said so.
- `skybrain` and `skyeye` held byte-identical `init` templates, one untouched for 16 days, and were
  indistinguishable from a project mid-flight (same shape, same 314-byte digest).
- `research` had two carriers (`.agents/skills/net-access`, `paper-corpus`) with no `.ai/skills/*.md`
  source, so `sync` could never regenerate or prune them.
- `sync` reported "clean" and `dump` reported success for **all seven**.

The only drift detection that existed was the `/audit` skill spec — i.e. a model's willingness to look,
which is not a check. `.ai/ARCHITECTURE.md` had listed "no `engram doctor`" as debt since v0.1.

Running it for the first time then found a real bug in *this* repository: two `🪦 SUPERSEDED` decisions
were classified `UNKNOWN` and had never reached the fingerprint, because `decisionStatus` knew only
`🪦 REJECTED`. The vocabulary actually in use across the seven repositories is `✅ ACCEPTED` /
`🪦 REJECTED` / `🪦 SUPERSEDED` / `💭 PROPOSAL`.

## Decision

1. **Read-only, always.** `doctor` writes nothing, and every hint it prints is phrased as advice for the
   project. The bank is the project's; a checker that also repaired would be a second writer of files
   `sync` and the human already own, and the three would disagree.
2. **Three severities with one job each.** `error` (the digest or the goal engine is broken), `warn`
   (real, not blocking), `info` (a valid state worth naming). Only `error` sets exit 1, so `doctor` can
   gate CI without failing on a fresh scaffold.
3. **`absent` ≠ `empty` ≠ `broken`, and each gets its own diagnosis.** A missing heading is an error (the
   project left the contract); a present-but-unwritten heading is `info` (a repository one minute after
   `init` is new, not unhealthy); an unreadable path is a `readError` and never "nothing there". Saying
   otherwise teaches people to ignore the checker, which is worse than not having one.
4. **Machine surface first.** `--json` emits `{summary, findings[]}` with a stable `rule` id per finding,
   and the human text is derived from the same array, so the two cannot disagree.
5. **The thresholds are generous and named.** `CURRENT_TASK` warns at 180 lines and errors at 400 — 3× and
   6.7× the ~60 the template asks for. The point is to catch the 537-line case that costs a project 13k
   tokens per session, not to nag about a 90-line file that reads fine.
6. **`core/doctor.ts` is pure; `commands/doctor.ts` does the I/O.** Carrier enumeration comes from the
   adapter registry (the sink layout is `adapters/`' business) and path probes go through
   `core/project.ts`, so the checks are testable without a filesystem and no layer learns a new dependency.

## Consequences

- `engram doctor` on this repository reports healthy; the same file was 301 lines and is now 172, with the
  43 completed milestones archived to `.ai/sessions/2026-10-19-milestone-log-archive.md` — nothing deleted,
  because a completed milestone's reasoning is what a future reader wants.
- Three of the seven adopters now report an `error` that was previously invisible. That is the intended
  outcome: `doctor` reports, the project decides. **engram does not rewrite another project's bank.**
- The `dump` budget is the next constraint: this repository renders 1425/1500, and the reference set ran
  1308–1488, so several are within 12 bytes of the ceiling.

## Revisit when

- A project asks for `doctor --fix`. The honest version archives its own `CURRENT_TASK` history into
  `.ai/sessions/` and leaves every other finding to a human; a version that rewrites prose is a different
  decision, not an extension of this one.
- A check turns out to be wrong often enough that people ignore it, which is the failure mode every
  checker has and the reason severities exist.
