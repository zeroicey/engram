# Goal engine M1 → M2: the core, the CLI, and a live pi run

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Follows:** `2026-10-18-long-running-agent-goal-design-handoff.md`

## Where we ended

The design round closed last session with six accepted decisions and no code. This session shipped
**M1 and M2** and exercised the loop against a real pi process. 236 tests, `tsc` clean,
`dump` 1080 B / 1500.

## What was built

| Layer | File | What it holds |
| --- | --- | --- |
| state machine | `src/core/goal.ts` | pure reducer, 4 states, 5 report verbs, wait latch, 3 stuck detectors |
| persistence | `src/core/goal-store.ts` | `.ai/goal/<id>/goal.json` + `BRIEF.md` `done_when` parsing, symlink-guarded writes |
| verdicts | `src/core/goal-eval.ts` | `cmd` exit codes, `metric` (JSON/JSONL/CSV/TSV, engine owns the comparison), `checklist` (evidence **verified**) |
| wire format | `src/core/goal-host.ts` | report args → `GoalReport`, effects → `GoalResponse` |
| CLI | `src/commands/goal.ts` | new / status / list / check / wake / baton / close / **event** |
| carrier | `src/commands/goal-carrier.ts` | opt-in `.pi/extensions/engram-goal.ts`, generated-only writes |
| templates | `src/templates/goal-files.ts`, `goal-extension.ts` | `BRIEF.md` / `TASKS.md`; the generated pi extension |

Tests: `test/goal.test.ts` (27), `test/goal-store.test.ts` (22), `test/goal-cli.test.ts` (14),
`test/goal-extension.test.ts` (15).

## Live verification (this machine, pi 1.2.0)

A scratch repo (`/tmp/m2`) with the carrier materialised, a goal in `waiting`, and
`ENGRAM_BIN=<build>/cli.js pi --approve --print "say PONG"`:

1. `agent_start` fired → `run-started` → the latch released (`status: waiting` → `running`, `wake: null`).
2. The model called `goal_report(progress)` → a round was counted.
3. The model called `goal_report(done)` → the CLI ran `true`, recorded the verdict, wrote
   `status: done`, `closeReason: completed`, and returned a `notify`.
4. A later `settled` reported "no active goal".

Two blockers had to be removed first, and both are recorded as pitfalls:

- `.pi/extensions` is **project-trust gated**; without `--approve` the extension loads and is never
  called, which looks exactly like a broken extension.
- `build/src/cli.js` ships `0644` from `tsc`; `spawnSync` returns `EACCES` and the first version
  swallowed it into `null`.

## Rules discovered while building (not in the design round)

- **A bare metric against a JSONL log means the latest record.** The metric shape was unusable for
  the work it exists for until this landed.
- **Checklist evidence must verify.** `- [x] done — \`echo hi\`` passed before; a signature is not a gate.
- **The loop needs a silent-settle floor.** Measured: 50 settlements, 50 nudges, 0 rounds, status
  still `running`. Both existing detectors are driven by reports that never arrived. `silentSettles: 8`
  now escalates to `blocked`.
- **A pending verdict must not go quiet.** It is the one in-flight question nothing else resolves;
  `silent` there was a permanent mute with the goal still running. It re-evaluates instead.
- **A reported `progress` must not be answered with "no report was filed".** That was a false
  statement that made the model report twice per turn.
- **`evaluate` is resolved inside the CLI**, so the host never runs a gate and never decides `done`.

## Open

- **Nothing schedules a wake.** `engram goal wake --reason` exists and works; L1/L2/L3 transports do
  not. A `wait` is currently releasable only by a new run or by the 24h `reconcile` escalation.
- **No multi-hour run.** The live probe was minutes long. The commit-at-settlement rule, the
  traceability promise and the liveness deadline have been reasoned about, not exercised.
- **Two provisional answers still need a verdict**: a wake arriving while `blocked` re-raises, and a
  `time` wait longer than 24h gets its own deadline.
- **0.4.0 is unpublished** (2FA), so the goal engine exists only in this working tree.
- `.engram/config.json` gained `goal: { enabled }`; an older engram reading a newer config drops the
  field rather than failing, which was checked.

## Do not repeat

- **Do not bundle the engine into the generated extension.** It is a fork; see
  `.ai/decisions/2026-10-18-the-pi-adapter-is-a-marshaller-not-a-fork.md`.
- **Do not probe the extension without `pi --approve`.** A trust refusal is indistinguishable from a
  broken extension in every signal available.
- **Do not treat `spawnSync` `error` as "no answer".** That is how a missing install looks like a
  closed goal.

## Next step

M3, the wake transports: a systemd unit (or a background task) that calls
`engram goal wake --reason "…"` on exit, delivered through herdr to the baton holder. Then one real
multi-hour goal before anything else is designed.
