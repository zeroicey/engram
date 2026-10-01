# Current task

**Status:** 🟢 v0.1 complete, awaiting publish identity · **Updated:** 2026-10-01

## Goal

Ship `engram` v0.1: `.ai/` scaffolder + cross-tool contracts + ≤1.5 KB `dump`, dogfooded on this
repository (its own rule files are authored, not placeholders), tested, and documented for npm +
GitHub release.

## Checklist

- [x] Four-layer model frozen (`.ai/` = 3 root files + 4 knowledge dirs + `skills/`)
- [x] Template library: decisions / sessions / pitfalls / runbooks + contract block
- [x] Four canonical skills: `/handoff`, `/remember-pitfall`, `/remember-decision`, `/audit`
- [x] CLI `init` with 8 tool adapters, meta-prompt bootstrap, idempotent rules
- [x] CLI `dump` with a hard byte budget, plus `new` and `sync`
- [x] Self-hosted `.ai/` in this repo (this file is the proof)
- [x] `node:test` suite covering dump budget, contract idempotency, adapters, CLI surface (52 tests)
- [x] README with install, usage, publish and push steps (EN + 中文速览)
- [x] Dogfooded the meta-prompt: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, Cursor/Windsurf/Copilot
      rule files authored for this repo, `engram:todo` blocks gone, `engram sync` clean
- [ ] First real `/remember-decision` recorded from production use (dogfood loop closes here)

## Code state

Branch `main`, single commit. `src/` is 11 TypeScript modules, `test/` 5 suites, zero runtime deps.
Build: `npm run build` → `build/`; tests run against compiled output on purpose (the shipped
artifact is what gets tested). `engram dump` currently renders 1085 bytes.

## Blockers

| Blocker | Waiting on | Unblock by |
| --- | --- | --- |
| npm package name + GitHub org not chosen | user | publish under `engram` or a scoped name |

## Pitfall reminders for the current branch

- `.ai/pitfalls/cases/tsc-wrong-outdir.md` — `tsc` exits 0 while emitting nowhere. Check `outDir`.
- `.ai/pitfalls/cases/rule-file-rerender-nesting.md` — re-rendering must strip what it regenerates.
- `.ai/pitfalls/cases/await-member-parens.md` — `(await x).y` vs `await x.y`; lint here is right.
- `.ai/pitfalls/cases/fingerprint-table-noise.md` — regex parsing swallows Markdown tables.

## Next action

Pick the npm/GitHub identity, then run the release steps in `README.md` § Release.