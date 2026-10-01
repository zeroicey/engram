# Zero runtime dependencies, `tsc` only

**Status:** ✅ ACCEPTED · **Date:** 2026-10-01 · **Deciders:** lead architect

## Context

`engram` is installed into *other people's repositories* via `npx`/`npm`. Every dependency it carries
enters their lockfile, their install time and their audit surface. The tool's whole value is trust:
it writes the instruction file their AI reads. Runtime supply-chain risk is a direct threat to that
trust.

## Options

| Option | Upside | Downside | Reversibility |
| --- | --- | --- | --- |
| A. Zero runtime deps, plain TS + `tsc` | install is instant, no lockfile churn, auditable in one sitting | we hand-roll argv parsing and TOML/JSON emission | easy |
| B. Node CLI framework (`commander`/`cac`) + a template engine | less hand-written glue | 5–20 transitive deps shipped into every consumer repo | easy |
| C. Bundled binary | fastest startup | build/release complexity, platform matrix, hurts reviewability | hard |

## Decision

Runtime dependencies stay at zero. Only `typescript` and `@types/node` exist, as devDependencies.
Arg parsing, template rendering and TOML emission are ~150 lines of plain code we own.

Templates live in `src/templates/*.ts` as string builders, not as shipped `.md` files, so
`tsc` output is self-contained and the published tarball needs no asset copying.

## Consequences

- `package.json` has no `dependencies` field. A test asserts this.
- `src/cli.ts` owns a hand-rolled `parseArgs`; adding a flag means editing that one function.
- Node's built-in `node:test` is the test runner, so `npm i -D` installs two packages total.

## Revisit when

A genuine need for a third-party runtime dependency appears that cannot be written in ~50 lines, or
Node drops support for the version floor we target.