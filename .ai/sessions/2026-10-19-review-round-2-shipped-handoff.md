# Handoff: review round 2 shipped and pushed — 13 defects, two dead review rounds

**Date:** 2026-10-19 · **Branch:** `main` @ `8503c9f` · **origin/main matches, no tag, no publish.**

## Where we ended

The stage the user asked for is **done**: review → fix → push. `origin/main` is `8503c9f`, the tree is
clean, 367 tests pass, `tsc` is clean, `engram sync` is clean, `engram doctor` reports healthy, `engram
dump` is 1461/1500 B.

The user explicitly **waived the local trial** ("skip the trial, just push"), so the trial is the one
step of the original plan that was never executed.

## The P0 of this session was in the review process, not the code

`HERDR_PANE_ID` is an **inherited environment variable**. Every subagent a session spawns reports the
holder's pane while carrying its own `PI_SESSION_FILE`, and `onReconcile` adopted on `samePane` — the
rule that exists so a killed pi can take back its own goal. So launching six review children handed the
goal's baton to a reviewer 330 ms after it started, and the holder's own `goal_report` was then refused
by the goal it was driving. Fixed in `f25fe1d` via `isNestedSession`: a restart is a **sibling** session
file, a child is **nested** beneath the holder. `.ai/pitfalls/cases/a-subagent-inherits-the-pane-and-steals-the-baton.md`.

## Two review rounds produced zero findings — and that is a prompt defect

- Round 2 (predecessor's): 4 children, all timed out at 30 min, outputs were 46–92 byte unfinished
  sentences. 186–231 records and 0.8–1.1 MB each — they were reading the whole time.
- Round 2b (mine, before I understood): 6 children, zero output files at 8 minutes. Same cause.
- **Root cause, and the part the predecessor's advice missed:** the `reviewer` agent's tools are
  `read, grep, find, ls, watchdog_diff`. It has **no write tool**, so "write findings incrementally to
  the output file" is a no-op. A read-only reviewer plus an incremental-output instruction is a plan
  that reads well and can never work.
- **What worked (round 3, all six delivered):** `scout` (`read, grep, find, ls, bash, write`), **one file
  per child**, incremental `printf >> file` after each finding, **no file:line citations** (function name
  + trigger), hard budget of 20 tool calls, "report by your 40th call".
- Full pitfall: `.ai/pitfalls/cases/a-review-that-never-writes-until-the-end-loses-everything.md`.

**Salvage beat relaunching.** The dead children's `thinking` blocks held 5.6 MB of finished analysis.
Reading them for `P0|P1|P2|BUG|DEFECT` and verifying by hand produced two of the fixes below *before*
spending another 30 minutes on a new round.

## The 13 defects fixed (each with a regression test that reproduces the measured failure)

| Commit | Severity | Defect |
| --- | --- | --- |
| `f25fe1d` | P0 | A subagent inherits the pane and took the baton (`samePane` adoption) |
| `5c3f4e9` | P1 | `onSettled`'s `new Date(claimedMs + limits.livenessMs).toISOString()` threw `RangeError` out of a *total* reducer, from a hand-editable config value |
| `9446776` | **P0** | `verdict` and `close` had **no baton guard** — `engram goal check` from any shell closed anyone's goal as *verified complete* |
| `9446776` | P1 | The silent-settle floor measured stale bookkeeping (`onWait`/`onWake`/`onRunStarted` never reset `unreportedSettles`) |
| `9446776` | P1/P2 | Emitted extension called `clearWake()` while declaring `clearWake(token)`; `/goal wake` reported "goal woken" on a failed delivery |
| `8e9f26a` | P1 | `goal_report` treated an engine `ignore` refusal as success (`ok: true` always) |
| `8e9f26a` | P1 | `warnUnreachable` called unguarded `sendMessage` from a timer callback |
| `8e9f26a` | P1 | A fence quoting `<!--` made every later line inert — `doctor` reported present headings MISSING |
| `4ba2a22` | P1 | A corrupted config silently **deleted the goal carrier** (round 1's P0 by another route) |
| `4ba2a22` | P1 | Every `.ai/`/`.engram/` write used raw `fs.writeFile` → wrote **through a dangling symlink** outside `--root` |
| `23e677c` | P1 | A handoff never taken nudged forever (12 settles, ceiling 3, never escalated) |
| `23e677c` | P2 | The `(hard cut)` record was pushed after the notice was rendered, so budgets 1..419 never named the cut; notice could disagree on exhaustion |
| `d6cff5e` | P1 | The stuck detector was defeated by `touch` (mtime), and **could never fire at all** where no digest is computable |

Three "fixes" I wrote were wrong and were caught: an unsolicited-verdict guard that broke the documented
`goal check` escape hatch; a strict typecheck test on a file that must stay valid JavaScript; and a
first cut of the `livenessMs` bound that treated "never expire" as staleness, inverting the setting.

## Verified, not assumed

- `origin/main` == local `8503c9f`; 0 ahead, 0 behind; clean tree; **no tag created, no publish**. The
  four remote tags are pre-existing `v0.2.0`/`v0.2.1`.
- A budget sweep over **every** `maxBytes` 1..1800 with two independent scripts: 0 over-budget, 0 unnamed
  drops, 0 phantom notices, 0 artefact-vs-`--json` disagreements.
- A live reproduction of each of: baton theft, stranger-closes-goal, `touch` evasion, dangling-symlink
  escape, corrupted-config disarm, fence-swallows-file, 12-settle nudge-forever.
- 4,000 random state-machine walks: `wake`/`status` invariants hold, `reduce` never throws.

## Do not repeat

- **Do not review with an agent that cannot write.** Check the tool list first.
- **Do not launch long work from a session that is about to hand off.** Its completion notification goes
  to the old pane. (The predecessor warned about this; it is correct.)
- **Do not relaunch before salvaging.** A timed-out child is not an empty one.
- **Backticks are forbidden in the emitted extension** — `src/templates/goal-extension.ts` is one template
  literal. I hit TS1443 **three times** in this session, always in a new comment. Use `'quotes'`.
- **Do not put backticks in a `git commit -m` string** — the shell expands them and silently truncates
  the message. Use `git commit -F file`.
- **`--strict` cannot be used on the emitted extension.** It must stay valid JavaScript (pi loads it with
  no transpile step), so `noImplicitAny`/`strictNullChecks` are inherent. Guard arity (`TS2554`) instead.
- **`doctor` exits 1 on errors** — but `doctor | tail` reports `tail`'s status. Check the exit code directly.

## Still untried

- **A local trial on a real adopter** — waived by the user this stage. `research` has still not declared
  `.ai/sections.json`.
- **A real multi-hour unattended run**, a handoff *during* a wait, `/verify`.
- **`npm publish`** (human, 2FA). The Pi-only break has never been installed by anyone.
- The 24 h liveness deadline has never been waited out — use a short `livenessMs` instead.
