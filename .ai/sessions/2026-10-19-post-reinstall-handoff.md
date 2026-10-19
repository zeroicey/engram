# Handoff: the code is shipped — start by re-verifying the machine, then run a real goal

**Date:** 2026-10-19 · **Branch:** `main` @ `79761a3` · **origin/main matches, no tag, no publish.**

This handoff exists because the machine is being **reinstalled**. Everything tracked is in git and in the
remote; everything ignored (`build/`, `node_modules/`, `.pi/tasks/`) is rebuilt by two commands below.

## First five minutes on the new machine

```bash
cd /data/dev/engram
npm install                 # devDependencies only: typescript, @types/node
npm run typecheck           # must be clean
npm test                    # must be 367 passing
node build/src/cli.js doctor    # must say "bank is healthy"
node build/src/cli.js sync      # must print "unchanged AGENTS.md"
node build/src/cli.js dump      # must be <= 1500 bytes (it is 1366 today)
```

If `npm test` is not 367, the checkout is not the one that was pushed — check `git rev-parse HEAD` against
`79761a3` before believing anything else.

**`build/` is gitignored.** `node build/src/cli.js` does not exist until `npm run build` (or `npm test`,
which builds first). A "Cannot find module" here means "you forgot to build", not "the code is broken" —
that is `.ai/pitfalls/cases/tsc-wrong-outdir.md` territory.

## What is actually done

Review round 2 on the 25 fixes, the fixes it found, and the push. 13 defects fixed across 8 commits, each
with a regression test that reproduces the measured failure. The two worst:

- **`verdict` and `close` had no baton guard.** `engram goal check` from any shell could close anyone's
  goal with `status: done` + `closeReason: completed` — a goal reading as *verified complete* to a holder
  who never saw it.
- **A subagent inherited the pane and took the baton.** `HERDR_PANE_ID` is inherited, so `samePane`
  adoption handed the goal to a review child 330 ms after it started.

The full table, the six "do not repeat" rules, and what was verified live rather than assumed:
[`2026-10-19-review-round-2-shipped-handoff.md`](2026-10-19-review-round-2-shipped-handoff.md).

## The user's next instruction, verbatim intent

> 新的对话直接开始监控新的，这就是实际的项目了。

So the next session's first real work is **a long unattended run on an actual project**, not more review of
this one. That is the biggest untested assumption left: the commit-at-settlement rule, the traceability
promise and the 24 h liveness deadline have all been *reasoned about*, and a full `running → done` loop was
probed for minutes, but **nobody has run a goal for hours**.

## What to do first in the new session

1. **Re-verify, do not assume.** Run the five commands above. A reinstalled machine is exactly where a
   silent environment difference hides.
2. **Ask the user for the real project**, if they have not named it. The local trial was explicitly waived
   this stage ("skip the trial, just push"), so `engram` has still never run on an existing adopter's bank.
   Expect `doctor` to report errors on `clip`/`research`/`teleport` — that is intended; engram reports and
   does not rewrite another project's bank.
3. **Then create one real goal and work it**, reporting every turn. Use a **short `limits.livenessMs`**
   rather than waiting out a day.
4. Two things were never exercised and are worth doing during that run: a **handoff during a wait** in two
   real panes, and `/verify`.

## Still blocked on a human

- **`npm publish` 0.5.0** needs 2FA. The Pi-only breaking change has **never been installed by anyone** —
  the `node` branch of `resolveEngramCommand` has still never run in the wild.
- `research` declaring `.ai/sections.json` themselves. The mechanism is ready; the decision is theirs.

## Do not repeat

- **Do not review with an agent that cannot write.** `reviewer` has no `write` tool, so "report
  incrementally" is a no-op — that cost two entire review rounds. Use `scout`, one file per child.
- **Do not relaunch before salvaging** a timed-out child's `thinking` blocks. Two of this stage's fixes came
  from there.
- **Backticks are forbidden in `src/templates/goal-extension.ts`** (one template literal; TS1443 at a line
  that looks fine — hit three times) and **in `git commit -m`** (the shell expands them; use `-F file`).

## Known findings NOT fixed (found by round 3, verified, left open)

These are real and were deliberately deferred — none is a P0. They were originally only in the reviewer
artefacts under `/tmp`, which the reinstall wipes, so they are recorded here.

| File | Finding | Severity |
| --- | --- | --- |
| `core/goal-store.ts` | `parseGoalRecord` rebuilds a whitelist and hardcodes `version: 1`, so any field it does not know is **deleted from disk on the next write**. Tolerance on read becomes destructive on write. | P2 |
| `core/goal-store.ts` | `parseWakeCondition` accepts any finite `seconds >= 0`; the `MAX_DATE_MS` bound lives only in its consumers, and `conditionDue` multiplies raw — so `seconds: Infinity` makes a time condition never due. | P2 |
| `core/goal-store.ts` | `listGoalIds`/`activeGoal` swallow a readdir failure and return `[]`, so an unreadable `.ai/goal/` renders as "no goal yet". | P2 |
| `core/goal-store.ts` | `parseBrief`'s JSON fence regex requires exactly three backticks, so a ```` `````json ```` block (which GitHub accepts) is a silent misparse → the goal is told it has no `done_when`. | P2 |
| `core/config.ts` | `parseLimits` floors *after* the `> 0` check, so `stuckRounds: 0.5` stores `0` — the value the guard exists to reject — and the stuck branch fires on the first settle. Floor first, then reject. | P2 |
| `core/git.ts` | `workingTreeDigest`'s `IGNORED` set (`dist/`, `build/`, …) and the dot-dir skip mean work confined there is invisible → a productive goal can be falsely declared stuck. | P2 |
| `commands/init.ts` | A `.engram/config.json` that is a **directory** is reported `skipped` with no warning, and `sync` then reads ENOENT-ish and disables the goal engine silently. | P2 |
| `commands/init.ts` | `init` and `sync` disagree about who owns a v2 config with a stale `tools` array: `init` says `kept`, `sync` rewrites it. | P2 |
| `templates/goal-extension.ts` | The emitted file still is not `strictNullChecks`-clean (`let timer = null` narrows to literal `null`). This is **inherent**: the file must stay valid JavaScript, so it cannot be annotated. Documented in the test. | note |

