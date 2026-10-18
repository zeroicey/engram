# Pi-only + goal engine M1–M2: handoff

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Follows:** `2026-10-18-goal-engine-m1-m2-handoff.md`

## Where we ended

Two things landed this session, in this order:

1. **The goal engine, M1 and M2** — core state machine, evaluator, store, CLI verbs, and a **live,
   verified** pi extension. M3 (wake transports) and M4 (herdr handoff) are not started.
2. **Pi only.** engram went from nine clients to three to **one**, as a deliberate break change. The
   subtraction went to the bottom of the stack, not just the registry.

`257` tests, `tsc` clean, `engram sync` clean, `dump` 1496 B / 1500.

---

## Part 1 — how much of the goal engine is done

The honest answer to "不知道目标搞定了多少":

| Milestone | State | What exists |
| --- | --- | --- |
| **M1** core | ✅ done | `core/goal.ts` (828 lines) — 4 states, 5 report verbs, wait latch, **3** stuck detectors. Pure reducer, no clock/file/host access, enforced by `test/architecture.test.ts`. |
| **M1** verdicts | ✅ done | `core/goal-eval.ts` (581) — `cmd` exit codes, `metric` (JSON/JSONL/CSV/TSV, engine owns the comparison), `checklist` (evidence **verified**, not asserted). |
| **M1** storage | ✅ done | `core/goal-store.ts` (309) — `.ai/goal/<id>/`, `BRIEF.md` `done_when` parsing, symlink-guarded writes. |
| **M1** CLI | ✅ done | `commands/goal.ts` (570) — `new/status/list/check/wake/baton/close/event`. `event --json` is the host wire surface. |
| **M2** pi adapter | ✅ done **and verified live** | `templates/goal-extension.ts` (251) generates `.pi/extensions/engram-goal.ts`. It holds **no rules** — it marshals pi events onto `engram goal event --json`, so there is exactly one implementation. Opt-in via `engram config --goal on`. |
| **M3** wake transports | ❌ not started | `engram goal wake --reason` exists and is proven. **Nothing emits it.** A wait is releasable only by a new run or by the 24h `reconcile` escalation. |
| **M4** handoff | ❌ not started | `goal_report(status="handoff")` sets `pendingHandoff` and escalates if it goes stale. No tool opens a successor pane through herdr, and no baton transfer is wired to it. |

The live proof from last session still holds: a real `pi --approve` run released a latched wait,
recorded a `progress`, and **closed a goal on an observed `done_when` verdict** the engine ran itself.
`reports: 2 / rounds: 1` in `goal.json` is the evidence the continuation fired — a `--print` session
gets one model request unless `agent_before_settle` returned `{ continue: true }`.

### What M3 actually needs

`engram goal wake --reason "…"` is addressed to the **goal**, not a pane: it matches the latched token
in `goal.json`, so a wake that arrives after a handoff still reaches whoever holds the baton. The
missing piece is the emitter, in three layers by expected duration
(`.ai/decisions/2026-10-18-treat-waiting-as-a-first-class-goal-state-with-a-self-wake-c.md`):

- **L1** — a background-task completion. **Needs no code**: the goal is silent while waiting and any
  new run releases the latch.
- **L2** — an in-process timer. `schedule-wake` already carries a token, a condition and a deadline.
- **L3** — a systemd unit whose `ExecStopPost` calls `engram goal wake`, delivered through herdr.

A long job must **never** live in the agent's process tree — that is the ghost-background-process
failure the whole `waiting` state exists to fix.

---

## Part 2 — the Pi-only break

Nine clients → three → one, all on 2026-10-18. Decisions:
`.ai/decisions/2026-10-18-serve-pi-only.md` (and the superseded
`2026-10-18-reduce-supported-clients-to-pi-claude-code-and-codex.md`, kept for the reasoning about
*how* to subtract).

**Deleted rather than left unreachable:** `RuleFileKind`, `RuleFileDef.kind`, `SkillSink.invoke`, the
rule-file frontmatter machinery, the `prompt-toml` carrier, the `copilot` frontmatter dialect,
`alsoReadBy`/`_Read by:_`, `--tools`/`--all`, the `scope` field, `resolveSyncTools`,
`inferToolsFromDisk`, `knownTools`, `staleToolIds`, and the `tools` array in `.engram/config.json`
(v2 now holds only the goal opt-in; v1 still parses and `sync` upgrades it).

`core/config.ts` no longer imports `adapters/`, so the layering allowlist in
`test/architecture.test.ts` shrank from two entries to one — the stale-entry test failed until the
line was deleted, which is what that test exists for.

Version **0.5.0** (unpublished; the human runs `npm publish`). `CHANGELOG.md` documents the migration.

### Verified migration

Run against a synthetic repository that had used the old multi-client engram:

```
v1 config (3 tools + goal.enabled)  → v2, goal.enabled preserved
generated files in .claude/.cursor/.pi/skills/.github/prompts → all pruned
CLAUDE.md, GEMINI.md                → reported, NOT deleted
hand-written files in retired dirs  → untouched
```

`CLAUDE.md` is on the retirement list for a specific reason: **Pi reads it too.** A leftover one does
not merely go stale, it puts a second copy of the contract into every session.

---

## Bug found by the migration, not by a test

`pruneStaleCarriers` enumerated four built-in skill names × **three hard-coded filename shapes**, so
Copilot's `<name>.prompt.md` matched none of them and survived every `sync` in every repository that
had ever used that adapter. Fixed by enumerating the directory: the safety property was never the name
list, it is the `<!-- engram:generated -->` marker plus `resolvesInside`. Regression test added.

Same lesson as the review round: **a migration against a synthetic old repository found what the suite
could not.** Tests ask "did my change do what I expected"; adversarial input asks "what actually
happens".

---

## Open

- **M3, then M4.** Nothing schedules a wake; nothing opens a successor pane.
- **No multi-hour goal has ever run.** The commit-at-settlement rule, the traceability promise and the
  24h liveness deadline are reasoned about, not exercised. This is the biggest untested assumption in
  the design.
- **Two provisional answers still need a verdict** (see `2026-10-18-goal-record-schema-and-report-surface.md`
  §Provisional): a wake arriving while `blocked` re-raises rather than queueing, and a `time` wait
  longer than 24h gets its own deadline.
- **`dump` is at the ceiling** (1496/1500) and the elastic tiers drop in a fixed order, so `PITFALLS`
  is already gone and each new accepted decision rotates one out of `BINDING`. Raise the budget or add
  a pointer naming what was dropped.
- **0.5.0 is unpublished.** The Pi-only break has never been installed by anyone.
- `engram doctor` (machine-checkable bank drift) remains a candidate.

## Do not repeat

- **Do not re-add a client without a decision file.** `test/adapters.test.ts` asserts the registry is
  exactly `['pi']`, and `test/architecture.test.ts` asserts one `id:` in the source. That guard is the
  review step the original nine adapters never had.
- **Do not bundle the goal engine into the generated extension.** It is a fork; see
  `2026-10-18-the-pi-adapter-is-a-marshaller-not-a-fork.md`.
- **Do not delete a rule file.** Prune carriers by generated marker; report rule files and let a human
  decide. A rule file may contain a body `init` deliberately preserves.
- **Do not probe the pi extension without `--approve`.** A project-trust refusal is indistinguishable
  from a broken extension in every available signal.
- **Do not put a long job in the agent's process tree.**

## Next step

**M3: the wake transport.** Start with L3 — a systemd unit whose `ExecStopPost` calls
`engram goal wake --reason "…"` — because that is the shape the motivating 16-hour training run needs,
and `goal wake` is already built and tested against a latched goal. Then run **one real multi-hour
goal** before designing anything else.
