# Changelog

## 0.5.0 — the long-running goal engine, and Pi only (breaking)

Two changes of very different kinds. The **goal engine** is the new product surface: a goal that lives in
the project, is judged by a machine-checkable verdict, and may wait for hours without a human or a token
being spent. **Pi only** is a subtraction — `engram` was an adapter for nine AI coding tools and is now a
tool for Pi, and the subtraction went all the way down rather than stopping at the registry: the code paths
only the removed clients could reach are deleted, not left as branches with a single legal value.

Read "The long-running goal engine" below first if you are here for the new capability; read "Removed
clients" and "Migrating a repository" if you have an existing checkout.

### Removed clients

`claude`, `codex`, `cursor`, `windsurf`, `copilot`, `gemini`, `dsh`, and the generic `agents` entry.
`AGENTS.md` is still written — `pi` reads it — but it is no longer shared with anything.

See `.ai/decisions/2026-10-18-serve-pi-only.md`, and the decision it supersedes
(`2026-10-18-reduce-supported-clients-to-pi-claude-code-and-codex.md`) for the reasoning about *how* a
client is supported.

### Breaking changes

| What | Before | Now |
| --- | --- | --- |
| `engram init --tools a,b,c` | selected the clients to configure | **removed.** Passing it warns and is ignored. |
| `engram sync --tools … \| --all` | limited the sync | **removed.** Passing it warns and is ignored. |
| `.engram/config.json` | `{version: 1, tools: [...], goal}` | `{version: 2, goal?}`. A v1 file still parses — `tools` is ignored, `goal` is preserved — and `sync` rewrites it to v2. |
| Rule files | `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, `.windsurf/rules/*.md`, `.github/copilot-instructions.md`, `.github/instructions/*`, `GEMINI.md` | `AGENTS.md` only |
| Skill carriers | per-tool dirs plus `$ARGUMENTS`/`{{args}}`/`.prompt.md` variants | `.agents/skills/<name>/SKILL.md` and `.pi/prompts/<name>.md` |
| `rules.ts` / `skills.ts` public shapes | `RuleFileKind` union, `SkillSink.invoke`, `prompt-toml`, per-sink `prefix`/`suffix`/`frontmatter` | gone |

### Migrating a repository

`engram sync` does the mechanical part and reports the rest:

1. **Carrier directories are pruned automatically** — `.pi/skills`, `.claude/skills`,
   `.cursor/skills`, `.github/prompts`, `.gemini/commands`. Only files carrying engram's own
   `<!-- engram:generated -->` header are deleted; a hand-written file in one of those dirs survives,
   and a directory emptied by pruning is removed.
2. **Rule files are reported, never deleted.** `sync` warns with the exact path. A rule file may hold a
   human-authored body that `init` deliberately preserves, so there is no marker that would make
   deletion safe. Delete them yourself once you have read them.
   - `CLAUDE.md` deserves a note: **Pi reads it too.** A leftover one does not merely go stale, it puts
     a second copy of the contract into every session.
3. **`.engram/config.json` is upgraded to v2** on the first `sync`, preserving `goal.enabled`.

The `.ai/` bank itself was never tool-specific, so nothing in your memory needs to change.

### The long-running goal engine (new)

A **goal** lives in the project at `.ai/goal/<id>/`, is judged by a machine-checkable `done_when`, may
**wait** without burning tokens, and is never ended by the model's own claim of success. This is the part
of 0.5.0 with the most new surface.

```bash
engram goal new "train to mAP 0.85" --metric out/eval.json:eval.mAP:>=:0.85
engram goal new "ship the parser"  --cmd "npm test && node scripts/gate.js"
engram goal status | list | check | wake --reason "…" | baton --session <path> | close
engram goal unit <id> --job "python train.py"   # systemd unit that wakes the goal from ExecStopPost
engram goal handoff --reason "context is filling"  # opens a successor window, moves the baton
```

- **Four states** — `running` / `waiting` / `blocked` / `done` — in a host-free reducer
  (`src/core/goal.ts`), so a pi restart cannot lose the state machine.
- **Three wake transports**, by expected duration: any new run (L1, no code), an in-process timer
  (L2), or a systemd unit whose exit path delivers the wake (L3). A wake is addressed to the *goal*, not
  to a pane, so it survives a handoff.
- **`done` requires an observed verdict.** The engine runs `done_when` itself; a `cmd`, a `metric` field,
  or an evidenced checklist. A claim is not a verdict, and a cancelled goal is never `done`.
- **Opt in per project**: `engram config --goal on && engram sync` writes
  `.pi/extensions/engram-goal.ts` — a generated marshaller that holds **no rules**, only the clock and
  the host calls. `--goal off` deletes it again.
- **Engine limits are configurable** in `.engram/config.json` (`limits.livenessMs`, `stuckRounds`,
  `blockedRepeats`, `silentSettles`); `engram config --limits` prints the effective values.

### `engram doctor` (new)

Health of the memory bank, as a check rather than advice:

```bash
engram doctor           # contract, size, drift, orphan carriers, unjudgeable goals
engram doctor --json    # same findings, one stable `rule` id each
engram doctor --fix     # the one mechanical fix: archive completed milestones out of CURRENT_TASK.md
```

Exits 1 only on an `error`, so it can gate CI. `--fix` only *moves* `- [x]` entries — verbatim, appended
to `.ai/sessions/_milestone-log-archive.md`, never deleted — and touches no prose.

### Fixed

- **A retired carrier dir is pruned whatever filename shape it holds.** The pruner enumerated four
  built-in skill names × three hard-coded filename shapes, so Copilot's `<name>.prompt.md` matched none
  of them and survived every `sync` in every repository that had ever used that adapter. It now
  enumerates the directory; the safety property was never the name list, it is the generated-marker
  check.
- **A single-line HTML comment used to swallow the rest of the file.** The parser set "inside a comment"
  on seeing `<!--` without checking the same line for the closing `-->`, and the shipped `CURRENT_TASK.md`
  template opens with exactly such a line — so **every scaffolded repository's `## Goal` heading was
  invisible**, and its fingerprint silently lost `project:` / `next:` / `branch:`.
- **`dump` no longer looks complete when it is not.** Whatever the 1500-byte budget drops is now named on
  the artefact (`omitted: PITFALLS (2 lines)`), and the budget shortens sections before giving any of them
  up entirely, so the same bytes buy a decision, a session *and* a pitfall rather than three of one kind.
- **`🪦 SUPERSEDED` decisions were classified `UNKNOWN`** and never reached the fingerprint; the parser
  knew only `🪦 REJECTED`. `SUPERSEDED` is a reason for the tombstone, not a fourth state.
- **A resolved blocker was published as a live one.** `~~struck through~~` / `✅` / `[x]` lead-ins are now
  honoured as the writer's own "this is history" signal.
- **A restarted pi could not adopt its own goal**, so a latched wait never came back: pi's session file is
  per process, the recorded baton named the dead one, and `reconcile` was refused as an intruder.
  `reconcile` may now adopt on the **same pane** (never a different one).
- **A wake was consumed before it was delivered**, in two transports. `poll` now peeks (`wake-ready`),
  `wake` claims, and the CLI delivers before it writes the record — because a delivery that fails after
  the wake is consumed leaves a `running` goal that nothing is watching.
- **`/goal wake` dropped the message its own claim returned**, releasing the latch and starting no run.
- **`pendingWakes` was never drained**, so `goal status` kept reporting wakes the human had already read.
- **The successor opens as a window, not a split**, pinned to this project's own herdr workspace
  (`HERDR_WORKSPACE_ID` → the baton pane's workspace → **refuse**; never the focused one).
- **`herdr agent start` without `--approve`** left pi at "Trust project folder?" on a fresh directory, so
  the handoff reported no session and failed; a window whose agent never started is now closed again.


## 0.4.0

Extension surface: `.ai/sections.json` for project-declared partitions, `.ai/skills/*.md` as the real
source of truth for any number of skills, `engram new <declared-section>`, carrier pruning by
canonical-skill absence, and the git precondition on `init`.

## 0.2.1

Fixed unquoted YAML frontmatter in generated skills: two of the four descriptions contain a
colon-space, which a YAML plain scalar cannot hold, so every carrier was rejected by the parser with
"nested mappings are not allowed".

## 0.2.0

First published release.
