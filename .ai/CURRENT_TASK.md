# Current task

**Status:** 🟢 v0.1 complete, awaiting publish identity · **Updated:** 2026-10-01

## Goal

Ship `engram` v0.2 as `@zeroicey/engram`. v0.1 did not survive its own release review: five
parallel agents found two data-loss bugs, six factual errors in the tool adapters, eight silent CLI
failures, and a flagship `dump` that printed template prose on a fresh `init`. All are fixed with
regression tests; what remains is publishing.

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
- [x] 5-lane adversarial review of v0.1, then a 3-lane re-review of the fixes
- [x] P0 data loss fixed: unpaired markers no longer cut files; prose mentions are not markers
- [x] `init` can never overwrite a file inside `.ai/` (it did, and committed the damage)
- [x] `--max-bytes` is a real UTF-8 ceiling; `truncated` is honest
- [x] Template placeholder prose no longer leaks into the fingerprint
- [x] Adapter facts re-verified against vendor docs; Copilot args, Windsurf/Devin, Codex invocation
- [x] CRLF, 4-backtick fences, unterminated frontmatter, HTML-comment markers: all covered
- [x] Layering enforced by tests instead of prose
- [ ] Publish to npm (needs `npm login`) and push to `zeroicey/engram`

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
- `.ai/pitfalls/cases/contract-marker-matched-in-prose.md` — markers count only on their own line.

## Next action

`npm login`, then `npm publish --access public` and push the tagged repo per `README.md` § Release.