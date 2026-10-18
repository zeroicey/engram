# Current task

**Status:** 🟡 Pi-only (0.5.0, unpublished) · goal engine M1+M2 done; **M3 next** · **Updated:** 2026-10-18

## Goal

Make an agent able to run for hours or days without a human present: a **goal** lives in the
project (`.ai/goal/<id>/`), is judged by a machine-checkable `done_when`, may **wait** without
burning tokens, and is never ended by the model's own claim of success. Memory and mechanics live
here; the runtime belongs to herdr. The extension surface (`.ai/sections.json`, `.ai/skills/*.md`)
is what lets a project like `research` own its own partitions while this is built.

## Checklist

- [x] Four-layer model frozen (`.ai/` = 3 root files + 4 knowledge dirs + `skills/`)
- [x] Template library: decisions / sessions / pitfalls / runbooks + contract block
- [x] Four canonical skills: `/handoff`, `/remember-pitfall`, `/remember-decision`, `/audit`
- [x] CLI `init` with tool adapters, meta-prompt bootstrap, idempotent rules
- [x] CLI `dump` with a hard byte budget, plus `new` and `sync`
- [x] Self-hosted `.ai/` in this repo (this file is the proof)
- [x] Published `@zeroicey/engram@0.2.0`; `0.2.1` fixes unquoted YAML frontmatter
- [x] v0.3.0: one carrier dir (`.agents/skills`), `.pi/skills` retired; tool set recorded in
      `.engram/config.json` (since 2026-10-18 this is a three-client registry; see the entry below)
- [x] **v0.4.0: `.ai/sections.json`** — project-declared partitions rendered by `sync` into every
      rule file's contract, into `dump` POINTERS, and into `engram new <section>`
- [x] **v0.4.0: `.ai/skills/*.md` is the real source of truth** — any valid file materialises into
      every carrier, not just the four built-ins; invalid frontmatter warns instead of vanishing
- [x] **v0.4.0: carrier pruning by canonical-skill-absence**, still gated on `GENERATED_MARKER`
- [x] **v0.4.0: backwards compatibility as a test** — `aiContract()` is byte-identical to the v1
      block; `sync` on `research` reports `unchanged AGENTS.md`
- [x] 147 tests green, `npm run typecheck` clean, `dump` inside budget
- [x] **2026-10-18: `init` refuses outside a git repository** — entry precondition, exit 1, no
      partial writes, `--dry-run` included, `.git` files (worktrees) accepted; 7 new tests, 154 green
- [x] **2026-10-18: six decisions recorded** for the long-running-agent line (three-layer split,
      `waiting` + self-wake, `done_when` shapes, project-scoped goal with one baton, git
      prerequisite, goal engine folded into engram)
- [x] **2026-10-18: nine clients → three** (`claude`, `codex`, `pi`). `pi` gained the `.agents/skills`
      sink it needed to be self-sufficient; `RETIRED_SINK_DIRS` prunes removed carriers,
      `RETIRED_RULE_FILES` only warns; `sync` repairs a config naming a removed tool. Now superseded.
- [x] **2026-10-18: three clients → one. `engram` serves Pi only — break change.** `TOOLS` holds one
      entry and a test enforces it. `RuleFileKind`, `SkillSink.invoke`, `alsoReadBy`/`_Read by:_`,
      `--tools`/`--all`, the `scope` field, `resolveSyncTools`, `inferToolsFromDisk`, `knownTools`,
      `staleToolIds` and the config `tools` array are all **deleted** rather than left as branches with
      one legal value. Config is v2 (`goal` opt-in only); v1 still parses and `sync` upgrades it.
      Removed flags warn instead of being silently ignored. `CLAUDE.md` joins the retirement list
      because Pi reads it *too*, so a leftover one doubles the contract in every session
- [ ] Publish `@zeroicey/engram@0.4.0` (the human runs `npm publish`: 2FA)
- [ ] `research` has not declared `.ai/sections.json` yet — the mechanism is ready, they decide
- [x] **2026-10-18 M1 of the goal engine**: host-free state machine (`running` / `waiting` /
      `blocked` / `done`) + the singleton `goal_report` surface + the wait latch + the two stuck
      detectors — `src/core/goal.ts`, `test/goal.test.ts` (34 cases)
- [x] **2026-10-18 M1**: `done_when` evaluator for all three shapes — `src/core/goal-eval.ts`
- [x] **2026-10-18 M1**: `.ai/goal/<id>/` store, `BRIEF.md` `done_when` parsing, symlink-guarded
      writes — `src/core/goal-store.ts`
- [x] **2026-10-18 P0, before M2**: `metric` reads JSONL/NDJSON and detects the delimiter; an
      ambiguous column is a failed verdict instead of a silent wrong answer
- [x] **2026-10-18 P0, before M2**: checklist evidence is **verified** (a path must exist, a command
      must exit 0); `path:` / `cmd:` prefixes; a one-line failure message
- [x] **2026-10-18 P0, before M2**: `engram goal new|status|list|check|wake|baton|close`, the
      `BRIEF.md` / `TASKS.md` scaffolds, and `dump` rendering an active goal above `BINDING`
- [x] **2026-10-18 P0**: `workingTreeDigest` in `core/git.ts` — the stuck detector's input is no
      longer dead code; it hashes `HEAD` + tracked-file stat data, with no git binary
- [x] **2026-10-18 M2: the pi adapter** — the generated marshaller `.pi/extensions/engram-goal.ts`
      (no rules), `engram goal event --json` as the wire surface, the 85% reminder, `/goal wake`,
      `engram config --goal on|off`, and a session-local `unreportedSettles` floor for the loop
- [x] **2026-10-18 M2 verified live** — a real `pi --approve` run released a latched wait, recorded
      a `progress`, and closed a goal on an observed `done_when` verdict. `reports: 2 / rounds: 1`
      in `goal.json` is the proof the continuation fired: a `--print` session gets one model request
      unless `agent_before_settle` returned `{ continue: true }`
- [x] **2026-10-18 self-found defects** (probe scripts, not tests): a whitespace-only `cmd` passed
      vacuously; `done_when.file` and checklist evidence could point outside the project; `close`
      left `status: running` so `dump`/`list` showed cancelled goals as live; `--dry-run` reported
      `removed` and had not removed anything; a silent loop had no floor (50 settlements → 50 nudges)
- [x] **2026-10-18 review round: 3 passes, 2 × BLOCK, 7 × P1, all fixed.** See
      `.ai/pitfalls/cases/asymmetric-guards-and-leaked-effects.md`. The shape of every P1: an
      **asymmetric guard** (a rule enforced on one side of a transition and not the other), a **cleared
      state with a leaked effect**, or a **detector defeated by input the model controls**. Tightening
      the baton rule then broke the shipped adapter — a correct rule with an unwired host makes a goal
      undrivable by its own holder — so `identity(ctx)` now supplies `--session` on every call
- [x] **2026-10-18 Pi-only.** Nine clients → three → one, as a break change; the subtraction went to
      the bottom (registry, config v2, `--tools`/`--all`, the scope machinery, the frontmatter
      machinery). Version **0.5.0**, `CHANGELOG.md` documents the migration, `test/adapters.test.ts`
      asserts the registry is exactly `['pi']` so a second client needs a decision file
- [x] **2026-10-18 migration bug found by running one**: a retired carrier dir was pruned only for
      three hard-coded filename shapes, so `.github/prompts/*.prompt.md` survived every `sync` in
      every repo that ever used that adapter. Now it enumerates the directory
- [ ] **M3**: the L1/L2/L3 wake transports — `goal wake` already exists and is proven; **nothing
      emits it**, so a wait is releasable only by a new run or the 24h escalation. Start with L3 (a
      systemd unit whose `ExecStopPost` calls `engram goal wake`)
- [ ] **M4**: `goal_handoff` opening a successor pane through herdr and transferring the baton
- [ ] **Run one real multi-hour goal.** The commit-at-settlement rule, the traceability promise and
      the 24h liveness deadline have only been reasoned about — the biggest untested assumption left
- [ ] **Publish 0.5.0** (human, 2FA). The Pi-only break has never been installed by anyone

## Code state

Branch `main`. `src/` is 31 TypeScript modules, `test/` 13 suites, 257 tests, zero runtime deps.
Build: `npm run build` → `build/`; tests run against compiled output on purpose. `engram dump`
renders 1496 B here (budget 1500 — at the ceiling, so `PITFALLS` is already dropped and a new
accepted decision rotates one out of `BINDING`). **One tool adapter: `pi`.** Nine → three → one on
2026-10-18, and each step deleted the code the remaining clients could not reach. The config is v2
(`goal` opt-in only) and `core/config.ts` no longer imports `adapters/`, so the layering allowlist is
down to a single entry. Two new leaf modules: `src/core/sections.ts`, `src/core/skill-source.ts`.
2026-10-18 added `src/core/git.ts` (upward `.git` lookup, no subprocess) and `test/git.test.ts`.

The `init` precondition is a **command-level** check in `cmdInit`, not inside `runInit`: a refused
init must not have touched the filesystem at all, and keeping it in the command handler makes that
visible in one place. `test/helpers.ts` now creates a `.git` marker by default so every suite runs
under the real precondition; `sandboxWithoutGit()` is the escape hatch for the refusal test.

Layering held: `core/` imports nothing from `commands/` (two allowlisted edges to `adapters/` and `templates/` predate the rule and are listed in `.ai/ARCHITECTURE.md` §6). `templates/contract.ts` declares
`ContractRow` structurally and `core/sections.ts` produces that shape, so neither layer knows the
other's type.

## Blockers

| Blocker | Waiting on | Unblock by |
| --- | --- | --- |
| `npm publish` needs 2FA | user | run it, or hand over a token |

## Pitfall reminders for the current branch

- `.ai/pitfalls/cases/read-source-after-write.md` — a function that creates a directory and then
  reads it must read *after* the write; the empty list looks like a legitimate state.
- `.ai/pitfalls/cases/destructive-cleanup-on-empty-input.md` — never let `[]` mean both "nothing
  exists" and "I could not read it"; `sync` emptied `.pi/prompts/` that way.
- `.ai/pitfalls/cases/crlf-and-bom-frontmatter.md` — `.` does not match `\r`, so CRLF frontmatter
  matched nothing at all; strip a BOM *and* slice the body from the stripped string.
- `.ai/pitfalls/cases/symlink-escapes-the-project-root.md` — a guarded pruner next to an unguarded
  `fs.writeFile` is only half a fix; `sync` overwrote a file outside `--root` through a symlink.
- `.ai/pitfalls/cases/new-line-evicts-elastic-content.md` — appending to the never-dropped section
  silently promotes the newest line above all elastic content; give a budget line its own tier.
- `.ai/pitfalls/cases/tsc-wrong-outdir.md` — `tsc` exits 0 while emitting nowhere. Check `outDir`.
- `.ai/pitfalls/cases/rule-file-rerender-nesting.md` — re-rendering must strip what it regenerates.
- `.ai/pitfalls/cases/fingerprint-table-noise.md` — regex parsing swallows Markdown tables.
- `.ai/pitfalls/cases/contract-marker-matched-in-prose.md` — markers count only on their own line.
- `.ai/pitfalls/cases/agent-scans-two-skill-dirs.md` — one agent can read two carrier dirs; check a
  new sink against that agent's docs before adding it (Pi also reads `.agents/skills`).
- `.ai/pitfalls/cases/priority-is-not-render-order.md` — `sections.push` order decides what the reader
  sees; `priority` only decides what gets dropped. Push in priority order.
- `.ai/pitfalls/cases/goal-relative-path-resolution.md` — a declaration's bare filename resolves
  against its owner (`TASKS.md` → `.ai/goal/<id>/`), not the repo root.
- `.ai/pitfalls/cases/fingerprint-strips-underscores.md` — `cleanInline()` deletes `_`, so an
  identifier written in `CURRENT_TASK.md` loses it. Spell it without underscores.

## Next action

Next action, in order:

Read `.ai/sessions/2026-10-18-pi-only-and-goal-m1-m2-handoff.md` first — it states exactly how much
of the goal engine exists.

1. **M3 — the wake transports.** `engram goal wake --reason` is proven; nothing emits it. L1 (a
   background-task completion) needs no code — the goal is silent and any new run releases the latch.
   L2 is a timer task. L3 is a systemd unit whose `ExecStopPost` calls `engram goal wake`, delivered
   through herdr to whoever holds the baton. A long job must never live in the agent's process tree.
   Read `.ai/decisions/2026-10-18-treat-waiting-as-a-first-class-goal-state-with-a-self-wake-c.md`.
2. **Then M4**: `goal_handoff` opens a successor pane through herdr and transfers the baton.
3. **Then run one real multi-hour goal** before designing anything else.
4. Publish 0.5.0 (**human**, 2FA), then let `research` declare `.ai/journal/` themselves — that is
   the acceptance test for the extension surface, and it must be done by them, not by us.
3. Run one real multi-hour goal. The M2 live probe was minutes long; the traceability/commit rule and
   the 24h liveness deadline have only been reasoned about, never exercised.

Two provisional answers from the M1 decision are waiting for a verdict, and M2 does not depend on
them: a wake arriving while `blocked` re-raises (instead of queueing), and a `time` wait longer than
24h gets its own deadline. See
`.ai/decisions/2026-10-18-goal-record-schema-and-report-surface.md` §Provisional.

Candidate v0.5 work, in order of leverage:
1. `engram doctor` — machine-checkable bank drift: dangling `.ai/` paths, sections whose `dir` no
   longer exists, carriers that disagree with their canonical skill, a goal whose `done_when` is
   unreadable.
2. The `dump` budget: `PITFALLS` is dropped today and a new decision rotates one out of `BINDING`.
   Raise the default, or emit a pointer naming what was dropped.
3. `/verify` — run the project's gate and record the result (four write verbs, zero read verbs).
