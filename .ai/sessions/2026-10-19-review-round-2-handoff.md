# Handoff: review round 2 on the 25 fixes, then a local trial, then push

**Date:** 2026-10-19 · **Branch:** `main` @ `0799b8f` (8 commits ahead of `origin/main`) · **Session:**
the one that took the baton for L2, then audited all 7 adopters, then built `engram doctor`, then fixed
25 findings from three adversarial reviews.

## Where we ended

Working tree clean. `351` tests green, `tsc` clean, `engram sync` clean, `engram doctor` reports
**healthy** on this repository, `engram dump` 1468/1500 B.

**Three adversarial reviews ran in parallel and all three returned BLOCK.** All 25 findings (P0 → P2) are
fixed in `0799b8f`; the two shapes they reduce to are recorded in
`.ai/pitfalls/cases/the-reviews-fixed-the-same-shape-three-times.md`. Read that file first — it is the
cheapest way to understand what this change set is.

The worst one is worth knowing by heart, because **nothing in this repository's own 351 tests or six live
probes had touched it**: `engram init` wrote `.engram/config.json` through `writeGenerated` (which replaces
content) under a comment claiming the opposite, so re-running `init` wrote `{"version": 2}` — and the next
`sync` then **deleted `.pi/extensions/engram-goal.ts`**. Running `init` twice silently disarmed the goal
engine.

## The user's constraints for this stage (verbatim intent)

1. **Do not publish the package.** Their machine is going to be reinstalled, so the code just has to reach
   the remote. `npm publish` is out of scope, and so is `npm login`/2FA.
2. **No push of a tag.** Without a publish there is nothing to tag.
3. The order they asked for: **review → fix what it finds → push.**

`git push` is authorised for this stage. `npm publish`, `git tag` and `git push --tags` are not.

## Next action, in order

### 1. Review round 2, on the fixes themselves (not on the original code)

Fixes introduce defects at the same rate as original code — this session proved it by shipping a broken
convergence loop inside the very fix for the "report disagrees with the artefact" bug. So the second round
must read the *current* state, and the brief must name the fixes as the thing under suspicion.

The shape that worked last time (three children, one `subagent` call, `workflow:"parallel"`):

```
subagent({ workflow: "parallel", args: { tasks: [
  { agent: "reviewer", task: "<goal engine, src/core/goal*.ts + tests>" },
  { agent: "reviewer", task: "<host boundary: src/templates/goal-extension.ts, src/core/herdr.ts,
                              src/commands/goal.ts, src/templates/systemd.ts>" },
  { agent: "reviewer", task: "<memory bank reader/writer: src/core/memory.ts, fingerprint.ts,
                              doctor.ts, src/commands/doctor.ts, dump.ts, config.ts, sections.ts>" },
] } })
```

Each brief must contain, and this is what made the last round worth its cost:

- **Read the files; do not modify anything. Break it, do not summarise it.**
- The **invariants as a numbered list** (the specific ones below), because a reviewer with no stated
  invariant writes a style review.
- **"Report ONLY concrete defects: file:line, the exact trigger, which invariant it breaks, the smallest
  fix. Rank by severity. One line per empty category. Quote code."** The "one line per empty category"
  clause is what makes the coverage auditable instead of a list of whatever it happened to look at.
- **Named constructions to attempt**, which is what produced the P0s: *(a) a state nothing can leave;
  (b) a guard enforced on one side of a transition and not the other; (c) a state cleared in the record
  but an effect leaked to the host; (d) a detector defeated by input the model controls; (e) an effect no
  host can act on; (f) a numeric/timestamp edge that flips a decision.*
- **Point (d) at the two detectors explicitly** and say the tests inject literal digests, so a detector
  whose input includes the engine's own writes will look green. That is exactly how the last round's
  biggest find was reached.

Invariants worth restating to the reviewers:

1. A transition that sets `wake: null` must emit `clear-wake`; the same question applies to every
   `pending*` field — name the transition that retires it, on every path.
2. Deliver before claiming, in every transport (timer, `/goal wake`, `runGoalWake`).
3. Only the holder drives; `wake`/`poll` refuse only an *identified* non-holder.
4. `reconcile` adopts only on: no holder, same session file, or **same pane**; an identified intruder is
   refused before anything reads the wait.
5. `done` requires an observed verdict; a cancel is `closedAt` + `closeReason`, never a `status`.
6. Every detector is bounded and **measures something other than its own bookkeeping**.
7. `core/` stays a pure reducer — no clock, no fs, no host API inside `reduce()`; and a write must never
   drop a field it does not own (`engram init` was the P0 for this).
8. A report must agree with the artefact it describes: `truncated`/`dropped` vs the `omitted:` line, and
   `doctor`'s verdict vs `dump`'s output.

### 2. Fix what it finds, in one pass

Keep the reviewed scope frozen until the findings are in (repository reads are live). Fix P0/P1 before
P2, and add a regression test per finding — the last round's most valuable artefacts were the two probes a
reviewer asked for: **a budget sweep** (`1..1800` bytes, asserting the ceiling is a ceiling and that
nothing dropped goes unnamed) and **a `loadMemory('.')` severity assertion**.

### 3. Local trial, in a repository the user picks

The user will name the repository. What has **not** been tried is a real project using this day to day, so
the trial is: `engram init` (or `sync` on an existing bank) → `engram doctor` → `engram config --goal on`
→ one real goal → work → `goal_report` per turn. Expect `doctor` to report **errors** on the existing
adopters — that is the intended outcome (`clip`/`research`/`teleport` have no `contract` headings; `research`
has 2 orphan carriers). **`engram` does not rewrite another project's bank**: report and let them decide.
`doctor --fix` is the one exception and it only *moves* checked items.

### 4. Push

`git push origin main`. No tag, no publish. Then confirm `origin/main` matches and the tree is clean.

## Verified / unverified

- [x] tested: 351 tests, `tsc` clean, `sync` clean, `doctor` healthy, `dump` inside budget
- [x] verified live over this session: 6 real unattended probes (a full `running → done` loop; a 90 s wait;
      two 120 s waits with a gate; a single **30-minute** wait; a wait that survived **killing the pi
      process**), a real herdr **server restart** (ids survive, `terminal_id` does not), and the whole
      handoff path including `-- --approve`
- [ ] **assumed, NOT tested: the 24h liveness deadline.** Configurable now (`limits.livenessMs`), and the
      expiry path is covered by reducer + `goal-cli` tests, but nobody has waited one out — use a short
      `livenessMs` instead of a day.
- [ ] assumed, NOT tested: a handoff **during** a wait in two real panes (the reducer proves both halves:
      the successor re-arms at `session_start`, the predecessor's timer is refused)
- [ ] assumed, NOT tested: `engram` installed from npm by anyone other than this checkout. The `node` branch
      of `resolveEngramCommand` has still never run.

## Do not repeat

- **Do not re-run a review without naming the fixes as the suspect.** A brief that says "review this" gets a
  summary; a brief that says "these 25 fixes are one day old, break them" gets findings.
- **Do not trust a green suite for a detector.** Two detectors were dead in production with full coverage,
  because every test injected the value the production path computes. Ask what can change a detector's
  input without anything having happened.
- **Do not write a report next to an artefact and assume they agree.** Write the assertion over the
  *rendered* output (the budget sweep exists for exactly this) — the first version of the `omitted:` notice
  compared a value with itself and stayed green.
- **Do not let a comment state a guarantee.** Three of this session's bugs were comments asserting
  behaviour the code did not have (`writeGenerated` "preserves an existing config"; `deliverNudge` "the
  token stays latched"; the systemd module "`%` is escaped"). Each one was believed.
- **Do not push a tag or publish.** Explicitly out of scope at this stage.
- **Backticks are forbidden in the emitted extension.** `src/templates/goal-extension.ts` is one TS
  template literal; a backtick ends it and `tsc` reports `TS1443` at a line that looks fine. This session
  hit it three times.
