# Development setup and verification

**Applies to:** engram contributors · **Owner:** lead architect · **Last verified:** 2026-10-01

## When to use this

After editing anything in `src/`, before opening a PR, and whenever a build behaves oddly.

## Preconditions

- Node.js ≥ 20 (tested on 22.x)
- No global installs; no runtime dependency to fetch

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
node build/src/cli.js init --tools agents,claude,cursor,pi --dry-run
node build/src/cli.js sync
node build/src/cli.js dump
```

## Verification

```bash
npm test             # build + node --test build/test/*.test.js
```

All suites must pass, and `engram dump` must report `under budget`.

## Rollback

Compiled output is disposable: `npm run clean && npm run build`. If a `sync` run rewrote a rule file
in a way you dislike, the file is in git — `git checkout -- AGENTS.md` (plus any other rule file)
and re-run `sync`, which only replaces the delimited contract block.