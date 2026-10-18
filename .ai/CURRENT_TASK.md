# Current task

**Status:** 🟡 Pi-only (0.5.0, unpublished) · goal engine M1+M2+M3-L3+M4 done; **L2 next** · **Updated:** 2026-10-18

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
- [ ] **M3 L1/L2**: L1 needs no code (a new run releases the latch); L2 (an in-process timer) is
      still a `schedule-wake` effect with no transport — **the next task**
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
- [x] **2026-10-18 this repo dogfoods the loop it builds**: `.engram/config.json` has
      `goal.enabled`, `.pi/extensions/engram-goal.ts` is committed, and the live run above was driven
      through the real CLI
- [ ] **M4**: `goal_handoff` opening a successor pane through herdr and transferring the baton
- [ ] **The user's question — "can I use this while developing?" — answered as far as it can be
      today**: the goal loop is usable now (create → work → report; a `wait` is releasable by a new
      run or an installed unit; a handoff opens a pane). The two gaps are structural and named in the
      handoff: `goal unit` needs a human to install the unit, and one goal per project means enabling
      the engine changes every settlement in that repo (`engram config --goal off && engram sync`
      reverses it). What has *not* been tested is a day of ordinary development under a live goal
- [ ] **Run one real multi-hour goal.** The commit-at-settlement rule, the traceability promise and
      the 24h liveness deadline have only been reasoned about — the biggest untested assumption left
- [ ] **Publish 0.5.0** (human, 2FA). The Pi-only break has never been installed by anyone

## Code state

Branch `main`. `src/` is 33 TypeScript modules, `test/` 14 suites, 281 tests, zero runtime deps.
Build: `npm run build` → `build/`; tests run against compiled output on purpose. `engram dump`
renders 1415 B here (budget 1500) with no active goal, so a goal is the elastic content that decides
whether the budget holds — close a goal before measuring. **One tool adapter: `pi`.** The config is v2
(`goal` opt-in only, now `on` in this repo) and `core/config.ts` no longer imports `adapters/`, so the
layering allowlist is down to a single entry. 2026-10-18 added two leaf modules: `src/templates/systemd.ts`
(the unit, a pure string) and `src/core/herdr.ts` (the delivery hop, all I/O injectable). `core/` now
spawns a process from two modules — `goal-eval.ts` for a `cmd:` gate and `herdr.ts` for a delivery —
and both keep every failure mode distinguishable rather than collapsing to `null`.

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

- `.ai/pitfalls/cases/a-taken-handoff-left-the-goal-silent.md` — the continuation guard is silent
   while `pendingHandoff` is set, so a baton transfer that does not retire it leaves the successor
   never-nudged and escalates "requested but never taken" about a handoff that landed. Ask of any
   `pending*` field: which transition retires it, on every path?
- `.ai/pitfalls/cases/ambient-identity-silently-re-owns-the-goal.md` — a default that reads
  `process.env` changes who holds the baton; an in-process CLI test must scrub `PI_SESSION_FILE` and
  `HERDR_PANE_ID` (use `runCli` from `test/helpers.ts`), and a refusal is read from
  `effects[0].reason`, never from `ok` or the exit code.
- `.ai/pitfalls/cases/generated-extension-not-executable.md` — `tsc` output may be `0644`; a
  shebang is not an executable bit. `resolveEngramCommand` wraps the CLI in `node` when needed, and
  the emitted unit always names an absolute path with its own `PATH`.
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

1. **L2 — the in-process timer transport.** `engram goal wake` is proven and `schedule-wake` emits a
   token, a condition and a deadline that nothing consumes. Rule 4 of
   `.ai/decisions/2026-10-18-treat-waiting-as-a-first-class-goal-state-with-a-self-wake-c.md`: a
   background task whose only job is to wait, so its completion *is* the timer. Rule 5 still holds — a
   timer is not a long job, a 16-hour job is.
2. **Then run one real multi-hour goal**, still the largest untested assumption: the
   commit-at-settlement rule, the traceability promise and the 24h liveness deadline have been
   reasoned about, never exercised. The live jobs so far were `sleep 25` and one handoff.
3. **Then L2**: an in-process timer transport, so a `time` wait that is hours long does not need a
   unit.
4. Publish 0.5.0 (**human**, 2FA), then let `research` declare `.ai/sections.json` themselves — that
   is the acceptance test for the extension surface, and it must be done by them, not by us.

Two provisional answers from the M1 decision are still waiting for a verdict, and nothing above
depends on them: a wake arriving while `blocked` re-raises (instead of queueing), and a `time` wait
longer than 24h gets its own deadline. See
`.ai/decisions/2026-10-18-goal-record-schema-and-report-surface.md` §Provisional.

**New, found while testing the baton refusal and deliberately not fixed:** an *ignored* event is
invisible to the model. `responseFromEffects` maps only `nudge` → `message` and `escalate` → `notify`,
so a refused report returns `ok: true` with `message: null` and the extension settles in silence. It
deserves its own decision, because the wording is the model's entire feedback channel.

Candidate v0.5 work, in order of leverage:
1. `engram doctor` — machine-checkable bank drift: dangling `.ai/` paths, sections whose `dir` no
   longer exists, carriers that disagree with their canonical skill, a goal whose `done_when` is
   unreadable.
2. The `dump` budget: at 1415/1500 with no active goal, a goal record is what decides whether it
   holds. Emit a pointer naming what was dropped instead of raising the number.
3. `/verify` — run the project's gate and record the result (four write verbs, zero read verbs).
