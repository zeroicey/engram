# `terminal_id` looks like an ID and is not one

**Severity:** 🟡 low · **Date:** 2026-10-18

## Symptom

None yet — and that is the point of writing it down. herdr's pane info carries four fields that all look
like stable identifiers, and only three of them are:

| Field | Survives a rename | Survives a server restart | Use it as an address? |
| --- | --- | --- | --- |
| `workspace_id` (`w4`) | yes | yes | yes |
| `tab_id` (`w4:t1`) | yes | yes | yes |
| `pane_id` (`w4:p1`) | yes | yes | yes, for a *place* |
| `terminal_id` (`term_65e1f2cb…`) | — | **no** | **never** |
| `revision` (`0` → `1`) | — | no | never: a counter |

## Measured, not reasoned

On hpstation (Windows, herdr 0.8.2), with a probe workspace, tab and pane:

1. `herdr tab rename` and `herdr workspace rename` → only `label` changes, the ids keep resolving, and
   the tab closes by the id it had before the rename.
2. `herdr server stop`, then `herdr server` restarted as a headless process. The log line is the proof of
   the mechanism: `session restore evaluated event="persist.restore" outcome="ok" workspaces=2`.
3. After the restart:
   - `workspace_id` `w4` → `w4`, `tab_id` `w4:t1` → `w4:t1`, `pane_id` `w4:p1` → `w4:p1` — **the structure
     is persisted and restored**.
   - `terminal_id` `term_65e1f20c171f04` → `term_65e1f2cb36f9f2` — a new terminal per spawn.
4. The pane came back holding a **fresh shell**: the pi that had been running in it was gone. A `pane_id`
   is therefore a durable address for a *container*, not for an agent.

Not tested, and stated as untested: whether a *client* restart (the TUI reattaching to a running server)
changes anything. It should not — the server owns the ids — but nobody has looked.

## Root cause

Three different lifetimes were being read as one kind of thing: a label (human, changes on a whim), a
structural id (persisted with the session), and a process handle (`terminal_id`, recreated whenever a
pty is spawned). Only the middle one is an address.

## Fix

engram already used only the right ones — `baton.paneId` and `successorWorkspace`, with `HERDR_PANE_ID` /
`HERDR_WORKSPACE_ID` from the environment (`identityFromEnv` now reads the workspace too). What this
changed is the *claim*: an earlier version of the `deliverNudge` comment said herdr's numbering "is not a
promise engram can lean on", which the measurement contradicts. The comment now says what is true, and
the fallback it justifies has the correct reason.

## Guard

- `AGENTS.md` §"Address herdr by ID, never by name" carries the measured table as a hard rule, in the
  file every session reads before working.
- `test/goal-unit.test.ts` — "a stale pane id falls back to the session path, which is the identity
  engram owns": asserts the order is recorded `pane_id` → `herdr agent list` → retry by session path, and
  that the wake is consumed only after the retry delivered.
- **The general question:** *how long is this value valid for?* A label lives until a human renames it,
  a structural id lives as long as the runtime's session, a process handle lives until the process does.
  An address built from the wrong lifetime works perfectly until the day it does not.
