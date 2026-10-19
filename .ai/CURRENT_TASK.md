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

- [ ] Publish `@zeroicey/engram@0.4.0` (the human runs `npm publish`: 2FA)

- [ ] `research` has not declared `.ai/sections.json` yet — the mechanism is ready, they decide

- [ ] **The user's question — "can I use this while developing?" — answered as far as it can be
      today**: the goal loop is usable now (create → work → report; a `wait` is releasable by a new
      run or an installed unit; a handoff opens a pane). The two gaps are structural and named in the
      handoff: `goal unit` needs a human to install the unit, and one goal per project means enabling
      the engine changes every settlement in that repo (`engram config --goal off && engram sync`
      reverses it). What has *not* been tested is a day of ordinary development under a live goal

- [ ] **Run one real multi-hour goal.** The commit-at-settlement rule, the traceability promise and
      the 24h liveness deadline have only been reasoned about — the biggest untested assumption left

- [x] **2026-10-19 `engram doctor` exists.** The same checks had been run by hand as shell loops against
      all seven adopters, and everything they found was invisible to `engram` itself: three repositories
      had lost their `CURRENT_TASK` headings, two held byte-identical untouched templates, one had orphan
      carriers, and `sync` reported "clean" for every one of them. `src/core/doctor.ts` (pure checks over
      a loaded bank) + `src/commands/doctor.ts` (the I/O), `--json` for machines, exit 1 on an `error`
      only. It immediately found a real bug in **this** repository: two `🪦 SUPERSEDED` decisions were
      classified `UNKNOWN` and had never reached the fingerprint, because the parser knew only
      `🪦 REJECTED`. It also reported this file at 301 lines, which is now 164.
- [ ] **Publish 0.5.0** (human, 2FA). The Pi-only break has never been installed by anyone

43 completed milestones (four-layer model, the template library, the four skills, `init`/`dump`/`new`/`sync`,
v0.3.0's single carrier dir, v0.4.0's `sections.json` + `.ai/skills` source of truth, the git
precondition, nine clients → three → one, the goal engine M1–M4, the three wake transports, and the
handoff-as-a-window) are logged in
[`.ai/sessions/2026-10-19-milestone-log-archive.md`](sessions/2026-10-19-milestone-log-archive.md) —
**read it before asking "did we already try that?"**. It moved because this file is read on every
session start and had reached 301 lines; `engram doctor` reports the length now.

## Code state

Branch `main`. `src/` is 33 TypeScript modules, `test/` 17 suites, 336 tests, zero runtime deps.
Build: `npm run build` → `build/`; tests run against compiled output on purpose. `engram dump`
renders 1425 B here (budget 1500) with the active goal — only 75 B of headroom, and the same file across
the seven repositories that adopted the bank ran 1308–1488 B, i.e. several are within 12 B of the ceiling.
The budget is the next real constraint, not the code. **One tool adapter: `pi`.** The config is v2 (`goal` opt-in only, now `on` in
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
- `.ai/pitfalls/cases/a-restarted-pi-could-not-adopt-its-own-goal.md` — a baton guard that refuses an
  event also refuses the *recovery* that event carries: a restarted pi is a new session file, so
  `reconcile` was refused, so nothing re-armed the timer, and the liveness deadline could never fire
  either (same handler). `reconcile` now adopts on **the same pane**, never on a different one.
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

1. **A real multi-hour unattended run.** The shape is proven (a 30-minute wait, two waits in one goal,
   and a pi restart mid-wait); what is unmeasured is *duration* — a wait longer than a session's
   patience, and the 24h liveness deadline. Check the deadline with a short `limits.livenessMs` instead
   of waiting a day. See `.ai/pitfalls/cases/a-long-run-cannot-be-produced-by-making-the-work-bigger.md`.
2. **A handoff *during* a wait** — the one composition never run: the successor must re-arm from
   `goal.json` (`session_start` → `reconcile`) while the predecessor's timer is refused by the baton
   guard. The reducer proves both; two real panes have never done it.
3. **`/verify`** — run the project's gate and record the result. Three write verbs, zero read verbs.
4. Publish 0.5.0 (**human**, 2FA), then let `research` declare `.ai/sections.json` themselves — that is
   the acceptance test for the extension surface, and it must be done by them, not by us.

One provisional answer from the M1 decision is still open and nothing above depends on it: a `time` wait
longer than 24h gets its own deadline. See
`.ai/decisions/2026-10-18-goal-record-schema-and-report-surface.md` §Provisional.
