# A generated carrier baked in a binary no machine had

**Severity:** 🔴 high · **Date:** 2026-10-20 · **Found on:** a reinstalled host (hphelm)

## Symptom

The first `pi` start on the new host printed, at `session_start`:

> `engram-goal: cannot run engram. Set ENGRAM_BIN or put engram on PATH — the goal engine is not recording anything.`

Every part of the engine was healthy: `node build/src/cli.js` worked, `doctor` said *bank is healthy*,
`sync` was clean, 370 tests green. Only the extension's call was broken, and it reported that correctly —
which is why it read like a configuration problem rather than a defect.

## Root cause

`src/commands/init.ts` called `syncGoalCarrier` with a **literal**:

```ts
{ engramBin: 'engram', version: VERSION, reminderPercent: … }
```

`'engram'` is only reachable through a global `npm i -g`, which this project has never required and
which the reinstall did not restore. So the generated file contained

```js
const ENGRAM = process.env.ENGRAM_BIN || "engram";
```

and `spawnSync('engram', …)` returned `ENOENT` on every event. Reproduced directly:

```
$ node -e "spawnSync('engram', ['goal','status'])"
error: ENOENT  status: null  stdout: ""
```

The failure was silent in the direction that matters: the engine records nothing, so `goal status`
kept reporting the *previous* goal and there was no artefact anywhere that said this session had
been unwatched.

Three things let it survive every review round and 370 tests:

1. **The workaround was documented, so it looked intentional.** `ENGRAM_BIN` is real, tested, and
   named in the notice the user saw. A documented workaround for a broken default still ships a
   broken default — and it requires a human to re-remember an env var on every boot.
2. **Every test injected its own binary.** `goalExtensionSource({ engramBin: shim, … })` with a shim,
   or `/nonexistent/…` to assert the *notice*. Nothing ever exercised the value `sync` actually bakes
   in, so the literal `'engram'` was asserted by nothing and used by everything.
3. **The notice proved the failure was handled, and handling was confused with working.** The
   pre-existing test asserted the notice appears. It did appear. That was the bug.

## Fix

- `resolveExtensionFallback` (`commands/goal.ts`) computes the argv that is *actually running*, in the
  same shape the systemd unit uses (`[node, <abs>/build/src/cli.js]` for a `tsc` 0644 emit, or
  `[<abs>/engram]` for an executable).
- `sync` bakes it into the carrier as `ENGRAM_FALLBACK`, and `runSync` warns when it could not record
  one — silence there is the same failure one layer up.
- The emitted file tries `ENGRAM_BIN`/the primary first and retries with the fallback **only on a spawn
  failure** (`res.error`). A non-zero exit is never retried: the CLI ran and answered, which is never a
  reason to call a second binary. A stale `ENGRAM_BIN` therefore cannot make a fallback outrank the
  file the user just synced.
- `engramFallback` is a **required** field of `GoalExtensionContext`, so the compiler forces every call
  site to state it. Optional would have defaulted this back to the broken value.

## Guard

- `test/goal-extension.test.ts` → *a carrier with a baked fallback starts the engine without
  `ENGRAM_BIN` or a PATH install*: loads the emitted module with `PATH=/nonexistent-bin` and no
  `ENGRAM_BIN`, drives `goal_report`, and asserts **`reports: 1` in `goal.json`** — the recording, not
  the notice. Asserting the notice passes for both states.
- The inverse case is asserted too: `engramFallback: []` with an unfindable primary must still print
  `cannot run`, because "no fallback" is an honest state and guessing another project's path is worse.
- Verified live on the real repository *and* on a second git project scaffolded from this build: with
  `ENGRAM_BIN` unset and `PATH=/nonexistent-bin`, the goal report reached the engine and moved the
  record from `reports: 0` to `reports: 1`.

## The generalisable rule

> A generated artefact must not name an *environment fact* as its default when the generator can
> observe the real one. `sync` knows exactly which binary invoked it — baking in a bare name discards
> that knowledge and hands the user a runtime dependency they never asked for.
