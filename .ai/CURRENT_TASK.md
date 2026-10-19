# Current task

**Status:** 🟡 Pi-only (0.5.0, unpublished) · goal engine M1–M4 done; L1+L2+L3 wake transports live; **handoff opens a window in this space** · **Updated:** 2026-10-18

> **目标与 CURRENT_TASK 的边界**：一个 goal 是**带机器判据的目标**（大小任意——「把 mAP 训练到 ≥0.85」就是
> 一等公民）；本文是**这场追求的处境**，没有判据、永不「完成」。目标只声明一次（由 goal 声明）；计划在任何
> 时刻只存在一个地方（有 goal 时是它的 `TASKS.md`，没有时是本文的 `Next action`）。`dump` 里分别渲染为
> `project:` 与 `GOAL / run:`。见
> `.ai/decisions/2026-10-18-a-goal-is-a-judged-objective-current-task-is-the-projects-position.md`。

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

Branch `main`. `src/` is 33 TypeScript modules, `test/` 15 suites, 304 tests, zero runtime deps.
Build: `npm run build` → `build/`; tests run against compiled output on purpose. `engram dump`
renders ≥1247 B here (budget 1500) with the active goal, so the elastic content still fits — close a
goal before measuring. **One tool adapter: `pi`.** The config is v2 (`goal` opt-in only, now `on` in
this repo) and `core/config.ts` no longer imports `adapters/`, so the layering allowlist is down to a
single entry. 2026-10-18 added two leaf modules: `src/templates/systemd.ts`
(the unit, a pure string) and `src/core/herdr.ts` (the delivery hop, all I/O injectable). `core/` now
spawns a process from two modules — `goal-eval.ts` for a `cmd:` gate and `herdr.ts` for a delivery —
and both keep every failure mode distinguishable rather than collapsing to `null`. Reading the machine
is `commands/`' job: the wake-condition observation (`fs` + `process.kill`, artifact paths confined by
`staysInsideRoot`) lives in `commands/goal.ts`, which is why `templates/` still never imports `node:fs`.

The L2 transport is one host-side operation and no rules: the engine publishes an absolute `fireAt`,
the extension arms a timer, and at that instant it *asks* `engram goal event --type poll`. Whether the
condition holds is decided in `core/goal.ts` (`time` from the wait's own `requestedAt`, the other two
from the observation the CLI passes in), which is what keeps the generated file a marshaller — and what
keeps an artifact path on the same confinement rule as `done_when.file`. A satisfied poll only *peeks*
(`wake-ready`); the release is a separate `wake` claim that the host sends **after** the message has
been delivered, in both transports. That ordering is the difference between a failed delivery and a
parked goal nobody is watching — see
`.ai/pitfalls/cases/a-wake-consumed-before-it-was-delivered.md`.

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
- `.ai/pitfalls/cases/a-long-run-cannot-be-produced-by-making-the-work-bigger.md` — three real probes
  proved the loop end to end (incl. a real L2 timer). The model finishes in one turn, so a long run needs
  a gate that cannot be satisfied until something outside the session changes. Also: `rounds: 0` is not
  "did nothing" (rounds are *progress* reports), and `herdr agent start` needs `-- --approve` or a fresh
  directory stops at "Trust project folder?".
- `.ai/pitfalls/cases/terminal-id-looks-like-an-id-and-is-not.md` — label / 结构 ID / 进程句柄有三种不同的
  生存期。实测（hpstation，herdr 0.8.2）：server 重启后 `workspace_id`/`tab_id`/`pane_id` 全部恢复，而
  `terminal_id` 每次都变；pane 回来了，里面的进程没有。凡是要到达「agent」的寻址都需要第二个身份
  （session 文件路径）。
- `.ai/pitfalls/cases/a-handoff-landed-in-the-focused-space.md` — anything that opens a window and depends
  on where the human's focus is will eventually act in the wrong project. The successor's space has three
  sources and a refusal, never a default.
- `.ai/pitfalls/cases/a-wake-consumed-before-it-was-delivered.md` — the consume-then-deliver ordering in
  both transports: a satisfied `poll` peeks, the claim releases, and `runGoalWake` delivers before it
  writes. Ask of any transport: if delivery fails here, what still knows the goal is waiting?
- `.ai/pitfalls/cases/a-cleared-wake-left-its-timer-armed.md` — a transition that sets `wake: null`
  must emit `clear-wake` in the same step, or the record is right and the host is still armed. Ask it of
  every branch that writes the field, and ask it of every `pending*` field too: `pendingWakes` was never
  drained, so `goal status` re-reported wakes the human had already read.
- `.ai/pitfalls/cases/a-refused-event-read-as-success.md` — an `ignore` effect had no reader, so
  `ok: true, reason: null` let `/goal` print "goal woken" for a wake the engine refused. An effect a host
  cannot see is a decision the engine did not make.
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

1. **A real hour-long unattended run is still the untested thing — but the shape is known and both a
   two-wait version and a single 30-minute version have passed.** Probe E: leg 1 → **one 30-minute
   wait** → leg 2 → `done` on `2 command(s) exited 0`, closed in ~33 minutes, `wakeSeq: 1`, the agent
   genuinely idle the whole time. What is left is only *surviving a runtime restart* mid-wait.
   Old note: Probe D: three legs, two real 120 s waits, gate
   `npm test && node scripts/legs.js --require 3` → `wake-1` → woken → `wake-2` → woken → `done` on
   `2 command(s) exited 0`, 15 tests, three commits across two ~2-minute gaps. What is left is *duration*,
   not shape: scale `wakeOnSeconds` up and see whether anything breaks when a wait is longer than a
   session's patience (memory, herdr, a pi restart mid-wait). Three real probes (real pi in a real herdr window, real repo, real `npm test` gate) ran the
   whole loop end to end: A and B finished in one turn, C waited 90 s on a real L2 timer, was woken, and
   closed on an observed verdict. The lesson: **a long run cannot be produced by making the work bigger**
   — it needs a gate that is unsatisfiable until something outside the session changes, and an explicit
   `wait`. So the next step is probe C scaled up: the same relay, `wakeOnSeconds` in the tens of minutes,
   and *nothing* else to do — then check the 24h liveness deadline with a short `GoalLimits` override
   instead of waiting a day. See
   `.ai/pitfalls/cases/a-long-run-cannot-be-produced-by-making-the-work-bigger.md`.
2. **Exercise the handoff *during* a wait** — the one composition never run: the successor must re-arm
   from `goal.json` (`session_start` → `reconcile`) and the predecessor's timer must be refused by the
   baton guard. The reducer proves both; two real panes have never done it.
3. Publish 0.5.0 (**human**, 2FA), then let `research` declare `.ai/sections.json` themselves — that
   is the acceptance test for the extension surface, and it must be done by them, not by us.

One provisional answer from the M1 decision is still waiting for a verdict, and nothing above depends
on it: a `time` wait longer than 24h gets its own deadline. See
`.ai/decisions/2026-10-18-goal-record-schema-and-report-surface.md` §Provisional. (The other one — a
wake arriving while `blocked` — was settled by the L2 work: it re-raises, and the effect is now
visible.)

**Fixed in the L2 change, so no longer a loose end:** an *ignored* event used to be invisible —
`responseFromEffects` read `nudge` → `message` and `escalate` → `notify`, and nothing read `ignore`, so
a refused wake returned `ok: true, reason: null` and `/goal` printed "goal woken" for a refusal. The
refusal is now the `reason`. See `.ai/pitfalls/cases/a-refused-event-read-as-success.md`.

Candidate v0.5 work, in order of leverage:
1. `engram doctor` — machine-checkable bank drift: dangling `.ai/` paths, sections whose `dir` no
   longer exists, carriers that disagree with their canonical skill, a goal whose `done_when` is
   unreadable.
2. The `dump` budget: at 1264/1500 *with* an active goal, the goal record is what decides whether it
   holds. Emit a pointer naming what was dropped instead of raising the number.
3. `/verify` — run the project's gate and record the result (four write verbs, zero read verbs).
