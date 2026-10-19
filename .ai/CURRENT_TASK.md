# Current task

**Status:** 🟡 Pi-only (0.5.0, unpublished) · goal engine M1–M4 done; L1+L2+L3 wake transports live; **handoff opens a window in this space** · **Updated:** 2026-10-18

## Goal

Let an agent run a long task for hours or days unattended: a goal lives in `.ai/goal/<id>/`, is judged by a
machine-checkable `done_when`, may wait without burning tokens, and is never ended by the model's own
claim of success.

## Checklist

- [ ] `research` has not declared `.ai/sections.json` yet — the mechanism is ready, they decide

- [ ] **The user's question — "can I use this while developing?" — answered as far as it can be
      today**: the goal loop is usable now (create → work → report; a `wait` is releasable by a new
      run or an installed unit; a handoff opens a pane). The two gaps are structural and named in the
      handoff: `goal unit` needs a human to install the unit, and one goal per project means enabling
      the engine changes every settlement in that repo (`engram config --goal off && engram sync`
      reverses it). What has *not* been tested is a day of ordinary development under a live goal

- [ ] **Run one real multi-hour goal.** The commit-at-settlement rule, the traceability promise and
      the 24h liveness deadline have only been reasoned about — the biggest untested assumption left

- [x] **2026-10-19 three adversarial reviews (goal engine / host boundary / memory bank), all three
      BLOCK, all findings fixed.** The shape they found, again and again: *a guard enforced on one side of
      a transition and not the other*, and *a report that disagrees with the artefact it describes*. The
      worst was **`engram init` overwriting `.engram/config.json`** — a re-run wrote `{"version": 2}`, and
      the next `sync` then **deleted `.pi/extensions/engram-goal.ts`**, silently disarming the goal engine.
      Also: the no-progress detector was dead in production (the digest included the engine's own
      `goal.json`, so two consecutive digests could never be equal); two model-triggerable `RangeError`s
      escaped `reduce`; `pendingHandoff` could mute the loop forever; `severityOf` labelled a real pitfall
      `unknown`; and `doctor` reported a healthy bank over an unreadable one. See
      `.ai/pitfalls/cases/the-reviews-fixed-the-same-shape-three-times.md`.
- [ ] **Publish 0.5.0** (human, 2FA). The Pi-only break has never been installed by anyone

_Completed milestones: 44 archived in `.ai/sessions/_milestone-log-archive.md` — read it before asking "did we already try that?"._

## Code state

Branch `main`. 33 modules, 19 suites, 360 tests, zero runtime deps. One adapter (`pi`), config v2 with
`goal` on. Module map and layering: `.ai/ARCHITECTURE.md`.

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

**This stage: review round 2 → fix → push. No publish, no tag** (the user's machine is being reinstalled;
the code only has to reach the remote). Full brief, including the review prompt shape that worked:
[`.ai/sessions/2026-10-19-review-round-2-handoff.md`](sessions/2026-10-19-review-round-2-handoff.md).

1. **Review round 2, on the 25 fixes** (`0799b8f`) — three parallel reviewers, goal engine / host boundary /
   memory bank. A review of the original code would find what the first round found; the fixes are the thing
   under suspicion, and this session already shipped a broken convergence loop inside the fix for "the report
   disagrees with the artefact".
2. **Fix what it finds**, P0/P1 first, one regression test per finding (the two probes worth keeping: a
   budget sweep over `1..1800` bytes, and a `loadMemory` severity assertion).
3. **A local trial in a repository the user picks** — `init`/`sync` → `doctor` → `config --goal on` → one
   real goal. Expect `doctor` to report errors on the existing adopters; `engram` reports and does not
   rewrite another project's bank.
4. **Push `origin main`.** No tag, no publish.
5. After that: a real multi-hour unattended run, a handoff *during* a wait, `/verify`, and `research`
   declaring `.ai/sections.json` themselves.
