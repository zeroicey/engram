# Milestone log: everything that shipped before 2026-10-19

**Date:** 2026-10-19 · **Archived from:** `.ai/CURRENT_TASK.md`

## Why this file exists

`CURRENT_TASK.md` is read on **every** session start, and it had grown to 301 lines — 5× the ~60 its own
template asks for. 136 of those lines were a checklist of 43 completed milestones: real history, but
history, and the contract says of that file "只写当下有效的状态，历史搬走" / only what is true *now*.

So this is the log, verbatim and in order, and `CURRENT_TASK.md` keeps the goal, the open items, the code
state, the blockers and the next action. Nothing was deleted — a completed milestone is evidence, and the
reasoning in each line is what a future reader wants when they ask "did we already try that?".

Found by `engram doctor` (`current-task/long`), which is the check that exists because this was previously
invisible: nothing in engram measured the file, so the only thing that ever noticed was a human.

## Completed milestones

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

- [x] **2026-10-18: the two prior sessions' work is committed** — `d62ed87` (Pi-only + goal M1–M2,
      one commit because `src/cli.ts` carries both) and `de1546f` (the memory bank). 77 dirty entries
      had been sitting in the working tree since the break change

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

- [x] **M3 L1/L2/L3**: L1 needs no code (a new run releases the latch); **L2 is an in-process timer**
      (`schedule-wake`'s absolute `fireAt`, the `poll` peek, `wake-ready`, `pi.sendMessage(…,
      {triggerTurn: true})`, deliver-then-claim) — verified live in RPC mode, see
      `.ai/decisions/2026-10-18-l2-is-an-in-process-timer-that-asks-the-engine.md`; L3 is the unit whose
      `ExecStopPost` claims, and it now delivers before it consumes too

- [x] **2026-10-18 M4: the handoff opens the successor pane.** `engram goal handoff` drives herdr in
      five ordered steps — record → split beside the holder's pane → start pi → **transfer the baton**
      → prompt with a brief that names the bank files. The baton is the stop signal: the predecessor's
      events fail `holdsBaton` afterwards, so "stop after handing off" is enforced, not requested

- [x] **2026-10-18 M4: the extension acts on a handoff report** instead of only reporting the request,
      which was the M3 "nothing emits it" gap in a different costume. `--json` is the wire surface

- [x] **2026-10-18 M3 L3: the wake emitter exists.** `engram goal unit <id> --job "…"` emits a
      systemd unit (`src/templates/systemd.ts`) whose `ExecStopPost` calls
      `engram goal wake --deliver`; `--write` puts it in `.ai/goal/<id>/`, printing is the default

- [x] **2026-10-18 M3 L3: the wake is delivered.** `src/core/herdr.ts` + `runGoalWake --deliver`
      submit the engine's own nudge to the pane that holds the baton *now* (pane id, or herdr's own
      session table when the baton has only a session file), so a wake survives a handoff

- [x] **2026-10-18 M3 L3: the identity comes from the runtime.** `PI_SESSION_FILE` / `HERDR_PANE_ID`
      are recorded on `goal new`, `goal baton` and `goal event`; without this `goal.json` never names
      a pane and delivery has no address. Flags win; an absent variable stays absent

- [x] **2026-10-18 M3 L3 verified live on hpcore**, not only in tests: `systemd-analyze --user verify`
      exit 0 → unit ran `sleep 25` → `ExecStopPost` reported `result=success code=exited status=0` →
      `deliver: delivered to w13:p1` → the wake arrived in the holder's pane as a real turn → a `done`
      report closed the goal on a verdict the engine ran itself (`npm test`, 1 command exited 0). The
      closed record is committed under `.ai/goal/2026-10-18-m3-l3-wake-transport-…/`

- [x] **2026-10-18 the liveness deadline is finally configurable.** The waiting decision said "default
      24h **configurable**" and nothing read a number: every `reduce` used `DEFAULT_LIMITS`. `.engram/config.json`
      now carries an optional `limits` block (`livenessMs`, `stuckRounds`, `blockedRepeats`,
      `silentSettles`), validated per field, read once per transition (`limitsFor`), shown by
      `engram config --limits`. `setGoalEnabled` no longer rewrites the whole document, which would have
      deleted a project's tuned deadline on every `--goal on|off`.

- [x] **2026-10-18 this repo dogfoods the loop it builds**: `.engram/config.json` has
      `goal.enabled`, `.pi/extensions/engram-goal.ts` is committed, and the live run above was driven
      through the real CLI

- [x] **M4**: `goal_handoff` opening a successor **window** through herdr and transferring the baton
      (landed 2026-10-18, `3a61fed`; tab-based since `2026-10-18`, and the spawn is now verified live)

- [x] **2026-10-18 the successor opens as a tab, pinned to this project's space.** A `pane split` made the
      human's window narrower on every handoff, and `tab create` without `--workspace` targets the
      *focused* space — which may be another project. `successorWorkspace` resolves
      `HERDR_WORKSPACE_ID` → the baton pane's own `workspace_id` → **refuse**; `--workspace` pins it, a
      window whose agent never started is closed again. See
      `.ai/decisions/2026-10-18-a-successor-window-opens-in-the-current-herdr-space.md`

- [x] **2026-10-19 the bank was audited across all 7 adopters, and `dump` no longer lies.** Four
      defects, one of them mine and universal: a single-line HTML comment made *every* scaffolded
      repo's `## Goal` invisible to the parser. `dump` now distinguishes **absent** headings
      (`missing:` — `clip`/`research`/`teleport` rewrote CURRENT_TASK into prose and lost
      `project:`/`next:`/`branch:`) from **empty** ones (`empty:` — two byte-identical untouched
      templates, one 16 days old, previously indistinguishable from a live project). Resolved blockers
      (`~~…~~` / ✅ / [x]) no longer publish as live ones.
