# Development setup and verification

**Applies to:** engram contributors · **Owner:** lead architect · **Last verified:** 2026-10-20

## When to use this

After editing anything in `src/`, before opening a PR, and whenever a build behaves oddly.

## Preconditions

- Node.js ≥ 20 (tested on 22.x and 26.x)
- No global installs; no runtime dependency to fetch

## `engram` does not need to be on `PATH`

Every command below uses `node build/src/cli.js` on purpose: a development checkout is **not** a global
install, and nothing here requires one. The goal extension is the one exception worth naming, because it
runs inside `pi` rather than in your shell:

- `engram sync` bakes the argv that invoked it into `.pi/extensions/engram-goal.ts` as a fallback, so a
  checkout carries its own CLI address and pi needs no `PATH` and no `ENGRAM_BIN`.
- If `sync` reports *“no fallback CLI was recorded”*, it was run through something transient (a test
  harness, a bundled shim). Re-run it from `node build/src/cli.js`.
- The extension warns **once per session** if it still cannot reach a CLI:
  `engram-goal: cannot run … the goal engine is not recording anything.` That message means nothing is
  being recorded — it is not a warning you may ignore. See
  `.ai/pitfalls/cases/a-carrier-that-baked-in-a-binary-no-machine-had.md`.

`ENGRAM_BIN` still wins at run time, for pointing a live session at a different build without
regenerating the file.

## Procedure

```bash
npm install          # devDependencies only: typescript, @types/node
npm run typecheck    # tsc --noEmit
npm run build        # tsc -> build/
node build/src/cli.js --version
```

Exercise the CLI against this repository itself (safe: it only writes missing files and refreshes
contract blocks):

```bash
node build/src/cli.js init --dry-run
node build/src/cli.js sync
node build/src/cli.js dump
```

## Verification

```bash
npm test             # build + node --test build/test/*.test.js
node build/src/cli.js doctor
node build/src/cli.js sync     # a second run must be a no-op
```

All suites must pass, `engram dump` must stay inside its budget, and the second `sync` must print
`unchanged AGENTS.md` with no `written`/`pruned` lines — a `pruned` line on a clean tree means a
carrier regex stopped recognising something (that is exactly how `.gemini/commands/*.toml` survived
for months; see `.ai/pitfalls/cases/a-test-fixture-the-generator-never-emits.md`).

## Rollback

Compiled output is disposable: `npm run clean && npm run build`. If a `sync` run rewrote a rule file
in a way you dislike, the file is in git — `git checkout -- AGENTS.md` (plus any other rule file)
and re-run `sync`, which only replaces the delimited contract block.