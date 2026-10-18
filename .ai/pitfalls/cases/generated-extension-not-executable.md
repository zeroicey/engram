# A generated extension that cannot be executed fails as a *model observation*

**Severity:** 🟠 medium · **Date:** 2026-10-18

## Symptom

The pi goal extension was materialised, loaded, and reported nothing. Then, in a live session, the
*model* reported the failure before any tool did:

> The goal engine isn't recording (missing `/data/dev/engram/build/src/cli.js`). If you want goal
> tracking active, either set `ENGRAM_BIN` to a valid CLI path or add `engram` to `PATH` — otherwise
> I'll just proceed without it.

`engram goal event` was never reached. Two separate causes had to be removed:

1. **Project trust.** `.pi/extensions` is trust-gated. Without `--approve` (or a saved trust decision)
   pi loads the file and never calls it. Every probe looked like "the extension does nothing".
2. **`ENGRAM_BIN` pointing at a non-executable file.** `build/src/cli.js` is emitted by `tsc` as
   `0644` with a `#!/usr/bin/env node` shebang. `spawnSync` therefore fails with `EACCES`, which the
   first version swallowed into `null`.

The model's own note is the useful signal: it had the tool available, called it, got a failure
string, and summarised it. That string was a *lie about the cause* ("missing") produced by a
`null` return, and the model had to guess.

## Root cause

Three values collapsed into one `null` return:

| Real state | What the caller saw |
| --- | --- |
| the extension is not trusted, so it never runs | nothing |
| `spawnSync` returned `error` (ENOENT, EACCES) | `null` → "no answer" |
| `engram` ran and legitimately had no goal | `null` → "no answer" |

## Fix

- `res.error || res.status === null` is now a distinct state, reported once per session as
  `engram-goal: cannot run <bin>. Set ENGRAM_BIN or put engram on PATH — the goal engine is not recording anything.`
- The extension reports **once**, not once per settlement, because a goal loop that runs every turn
  would otherwise spam the transcript with the same warning.
- `ENGRAM_BIN` overrides the compiled-in path at run time (a development checkout must not require a
  global install).
- `sync` writes the carrier, and the carrier is now regenerated whenever the *generator* changes —
  the first version compared content, so a fix to `goalExtensionSource` reached a repository only
  after the file was deleted by hand. `test/goal-extension.test.ts` asserts the emitted source, and
  `sync` reports `written` when it differs.

## Guard

- `test/goal-extension.test.ts`: the emitted source must contain `res.error || res.status === null`
  and the `cannot run` notice; it must contain `ENGRAM_BIN`.
- `sync` is idempotent on identical content (`unchanged`) but rewrites on a generator change, which
  is what makes a fix to the template reach every repository that already opted in.
- The live probe used `pi --approve` **and** an executable `ENGRAM_BIN`; a probe with only one of
  them passes for the wrong reason and reports "the extension is broken".
