# Long-running agent work — goal mode and handoff (design round)

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Supersedes:** none · **Follows:** `.ai/sessions/2026-10-16-bank-verification-handoff.md`

## Where we ended

The design round for "let an agent run for hours or days without me babysitting it" is **closed**.
Six decisions are `✅ ACCEPTED`; nothing is implemented yet beyond the git precondition below. The
next session starts at **M1 of the goal engine** — see `## Next step`.

Everything here was verified on `hpcore` (herdr 0.8.2, pi 1.2.0), live, not read from docs.

## What changed

### Code (this round)

- **`init` now refuses to run outside a git repository.** Entry precondition in `cmdInit`, before any
  option side effect and before the first write; exit code 1; `--dry-run` is not a bypass; a `.git`
  **file** (linked worktree / `--separate-git-dir`) counts as a repository.
  - New leaf: `src/core/git.ts` — upward `.git` lookup, `stat` only, **no git binary, no subprocess,
    zero dependencies**.
  - New suite: `test/git.test.ts` (7 tests). `test/helpers.ts` now creates a `.git` marker by default
    (`sandboxWithoutGit()` for the refusal case), so every existing suite runs under the real
    precondition.
  - Three older assertions needed adjusting *because* the sandbox is now a repository
    (`facts.hasGit`, and one "outside directory stayed empty" check that must ignore `.git`).
  - `154 tests pass`, `npm run typecheck` clean, `dump` 1448 B (budget 1500).

### Decisions recorded (`.ai/decisions/`)

| Decision | What it settles |
| --- | --- |
| `…split-long-running-agent-work-three-ways…` | herdr = runtime, engram = memory, mechanics separate; dependency one way; **handoff is agent-triggered** (forced by platform: `ctx.newSession()` is command-only); threshold 85% is a *reminder*; old panes are kept; never downgrade herdr, upgrade fleet-wide |
| `…treat-waiting-as-a-first-class-goal-state…` | **`waiting` is a fourth state**: silence latches, **any new run releases it**; 24h liveness deadline; restart reconciliation; three wake layers (in-process notification / in-process timer / systemd unit → herdr); **wake is addressed to the goal, not the pane**; long jobs never live in the agent's process tree; **`pi-background-tasks` is not forked, patched or absorbed** |
| `…verify-goal-completion-with-a-command-a-metric-or-an-evidenc…` | `done_when` takes exactly one of `cmd` / `metric` / `checklist`; **the first run classifies, it does not work**; an unclassifiable goal is `blocked` immediately; `done` requires the engine to observe the verdict, never the model's claim |
| `…scope-the-goal-to-the-project-with-a-single-baton-and-no-wor…` | Goal belongs to the **project**; **one baton**, transferred on handoff; one goal per project; the agent is the captain (subagents are its business); **no worktree in round one**, traceability comes from commits at settlement boundaries; no token/round budget, only two stuck detectors |
| `…require-a-git-repository-before-engram-initializes…` | `init` refuses outside git, actionable message, no partial writes, not retroactive, no `--force` in v1 |
| `…fold-the-goal-engine-into-engram…` | The engine lives **here**, opt-in per project through the pi carrier; CLI stays free of lifecycle code; zero deps still holds; memory formats unchanged; host injected, not imported |

## Verified / unverified

**Verified (live, this machine):**

- herdr end-to-end: `workspace create` → `pane split` → `agent start --kind pi` → `agent prompt
  --wait` → `agent read` returned `PONG`. Panes inherit `HERDR_ENV`, `HERDR_SOCKET_PATH`,
  `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_BIN_PATH`.
- herdr knows pi's session file (`agent_session.value` = the `.jsonl` path).
- herdr auto-triggering exists without keybindings: `[[events]] on = "pane.agent_status_changed"`.
- pi `agent_before_settle` + `{ continue: true, entries: [custom_message] }` produces repeated runs
  with **zero user input**; a prototype goal loop continued three times, stopped on an explicit
  `blocked` report, and stopped at the round budget.
- `pi.sendUserMessage(..., { expandPromptTemplates: true })` dispatches extension commands from a
  lifecycle handler; `ctx.newSession()` works when reachable.
- `ctx.getContextUsage()` returns `{ tokens, contextWindow, percent }` (percent is 0–100).
- Memory cost: herdr server **127 MB** (8 days uptime); each pi process **230–385 MB**; a 16-pane
  session is ~3.5–4.5 GB on a 28 GiB box already using 19 GiB and 8 GiB of swap. **Keeping panes is
  cheap; keeping pi processes is not.**
- Real CLI behaviour of the new git gate: refusal prints the remedy and `Nothing was written.` with
  exit 1 and an empty directory; a repo subdirectory keeps the bank in the subdirectory and only
  reports the enclosing root; `dump`/`sync` still exit 0 in an existing bank whose `.git` was removed.

**Unverified / open:**

- Upstream `earendil-works/pi` issue **#2488** (agent-initiated new session) was auto-closed by an
  OSS-weekend bot with no maintainer answer — so the command-only limitation is *observed*, not
  *ruled on*.
- herdr **0.8.2** here vs **0.9.5** upstream. Not upgraded: the MacBook was off and `hpstation` has
  no herdr. Upgrade only fleet-wide.
- Three questions parked in the `waiting` decision: wake policy outside working hours; which wake
  layer a condition-less wait defaults to; and whether a wake arriving while `blocked` re-raises or
  queues behind the human.

## Loose ends

- `pi-background-tasks` (2.6.10, updated 2026-10-13), `@juicesharp/rpiv-todo` and `pi-subagents`
  are all still maintained — the claim that "the task extension's author abandoned the repo" needs
  to name **which** package before anything is rewritten.
- `engram dump` sits at **1448/1500 bytes**, so BINDING already drops decisions. Adding more
  decisions will silently reduce what a fresh session sees. Either raise the budget or give the
  section a documented "recent N" rule.
- `fundus-glaucoma-triage` is not a git repository, so it cannot host a bank or a goal until it gains
  one.

## Do not repeat

- **Do not start a separate `pi-goal` repository.** It was decided, then overruled: the engine goes
  inside engram, opt-in via the pi carrier.
- **Do not write a herdr plugin, and do not fork `pi-background-tasks`.** Runtime belongs to herdr;
  the goal engine holds **no processes**.
- **Do not auto-open the next pane from code.** The agent decides it is at a clean delivery point and
  calls the handoff tool; the extension only asks.
- **Do not build a unified session manager or a web UI.** herdr already is that backend
  (`api snapshot`, session list, remote attach, resume-on-restore).
- **Do not add a runtime dependency to make the goal engine work.**
- **Do not lower herdr's version, and do not upgrade it on one machine only.**

## Next step

**M1 of the goal engine**, in this order:

1. `core/` state machine: `running` / `waiting` / `blocked` / `done`, the singleton `goal_report`
   surface (`progress` / `wait` / `blocked` / `done` / `handoff`), the wait latch and its release on
   any new run, the two stuck detectors.
2. `done_when` evaluator: run a command / read a metric field / check checklist evidence.
3. pi adapter: wire `agent_settled`, `session_before_compact`, `getContextUsage`, and the
   `.pi/extensions/` carrier emitted by `sync` — **opt-in only**.
4. Then, and only then: the `goal_handoff` tool that opens a successor pane through herdr.

Nothing in `core/` may import from `adapters/`, `commands/` or a host package — `test/architecture.test.ts`
enforces that, and it is the rule that makes the engine testable without a pi process.
