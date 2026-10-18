# Goal record schema and the `goal_report` surface

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey (M1 go-ahead)

## Context

Four decisions are already `✅ ACCEPTED` for long-running agent work (three-layer split, `waiting` as
a
first-class state, `done_when` in three shapes, project-scoped goal with a single baton). They settle
the *semantics*; they do not name a file format. M1 needed those semantics to become concrete, and a
memory format is the most expensive kind of choice to reverse — every future session and every
`.ai/` written on disk depends on it.

So this records the concrete shape the implementation chose, derived from the four decisions, and it
separates what is genuinely settled from what is still a provisional answer to an open question in
the `waiting` decision.

## Decision

### `.ai/goal/<id>/`

| File | Owner | Holds |
| --- | --- | --- |
| `goal.json` | engine | the record: status, baton, counters, wake, blockers, verdict history |
| `BRIEF.md` | human / agent | the goal text and the **single** `done_when` declaration (a fenced JSON block under `## Done when`) |
| `TASKS.md` | agent, engine reads | backs a `checklist`-shaped `done_when` |
| `REPORT.md` | engine + agent | the closing report; re-runnable verdicts |

`done_when` lives **only** in `BRIEF.md`. `goal.json` records what happened, the brief records what
would count as finished — one source of truth, so a re-run of the same gate cannot disagree with the
record.

### The state machine is a pure reducer

`core/goal.ts` exports `reduce(view, event, limits) → { record, effects }`. Time is an ISO string
passed in; nothing in the engine reads the clock, the filesystem or a host API. Effects are
descriptions (`nudge` / `silent` / `escalate` / `evaluate` / `schedule-wake` / `clear-wake` /
`handoff` / `done-observed` / `ignore`) that the pi adapter executes. This is what makes the engine
testable without a pi process and keeps `core/` the leaf layer.

### The report surface: five verbs, one tool

`progress` / `wait` / `blocked` / `done` / `handoff`. Classification is **not** a sixth verb: the
first run writes `done_when` into `BRIEF.md` with an ordinary file write, and every `progress` or
`done` report while `brief.doneWhen === null` is answered with a `classify` nudge and **consumes no
round**. That is the gate that refuses an unverifiable goal before it burns a night of tokens.

### Transitions that carry a rule

- **`waiting` latches; any `run-started` releases it**, whatever woke the goal. Normal nudging then
  resumes on the next `settled`.
- **A `done` claim never closes the goal.** It produces an `evaluate` effect; only a passed verdict
  closes it (`status: done`, `closeReason: completed`).
- **A failed verdict feeds the no-change detector**, because "claim done → gate fails → claim done"
  is a loop the blocked-repeat detector can never see.
- **Closure is `closedAt` + `closeReason`, not a fifth state.** `cancelled` / `abandoned` hang up the
  baton without pretending a verdict was observed.
- **Baton enforcement is in the reducer**, not in the adapter: an event carrying another
  `sessionPath` returns an `ignore` effect rather than driving someone else's goal.
- **Two liveness guards, no budgets**: the same blocked reason N times (`blockedRepeats`, 3) or K
  rounds with an unchanged working-tree digest (`stuckRounds`, 5) escalate to the human. A wait has a
  24h liveness deadline; `reconcile` re-arms a live wait on restart and escalates an expired one.
- **A missing digest is not an unchanged digest.** A non-git host reports `null`, which must not
  read as "no progress".

## Alternatives considered

- **`done_when` inside `goal.json`** (one file, no parsing). Rejected: it splits the declaration
  across two files that `sync`-like rewrites can drift, and the brief is the artefact a human also
  edits.
- **A sixth `classify` verb.** Rejected: the surface was frozen at five verbs; a file write already
  expresses "declare this", and the gate belongs on the reports that would otherwise do work.
- **`cancelled` as a fifth status.** Rejected: it would make `done` ambiguous between "verified" and
  "stopped", which is the one distinction `done_when` exists to protect.
- **Enforcing the baton in the adapter only.** Rejected: then the rule is untestable in memory and
  a second session in the same directory is silent instead of ignored-with-a-reason.

## Provisional (needs a verdict, do not treat as settled)

Both answer open questions listed in the `waiting` decision:

1. **A wake arriving while `blocked` re-raises** (escalates again) and is recorded in `pendingWakes`
   — rather than queueing silently until the human returns.
2. **A `time` wait longer than 24h gets a deadline of its own planned time + 60s**, instead of the
   flat 24h default, on the grounds that a scheduled timer is a plan and not a lost notification.

## Consequences

- A goal's record is readable and diffable, and the engine's behaviour is reproducible in tests
  (`test/goal.test.ts`) without a pi process.
- `core/goal.ts` is now the largest rule surface in the repository; every future rule must arrive as
  an event/effect pair rather than as adapter-side logic, or the layering promise is quietly lost.
- `goal.json` is written on every transition, through `writeFileGuarded` — the symlink lesson from
  `sync` applies to the busiest write in the tool.

## Revisit when

- A second host needs the engine (then the effects become the porting interface).
- A goal needs a composite verdict (`cmd` **and** `metric`), which the three-shape rule forbids.
- The `wake` transport (L1/L2/L3) is wired, at which point `schedule-wake`'s payload may need to
  name a layer.
