# A window opened by a handoff landed in the focused space, not the project's

**Severity:** 🟠 medium · **Date:** 2026-10-18

## Symptom

Two shapes, both about *where* a handoff puts its successor.

1. **Every handoff narrowed the human's window.** `pane split --direction right` put the successor beside
   the predecessor, so the session doing the handing off lost a column each time. Reported by the user
   after living with it: "我不想直接加 panel 导致分屏".
2. **`tab create` with no `--workspace` targets the focused space.** `herdr tab create --help` has no
   implicit workspace, and the first version of the tab change passed `--workspace ''` when it could
   not resolve one. herdr rejects that (`workspace_not_found`), so nothing was misplaced — by luck, not
   by design. Had it accepted an empty value as "current", a successor would have opened in whichever
   project's space the human last clicked.

## Root cause

The successor's container was treated as a detail of the runtime call rather than as a rule about the
project. Two separate consequences of the same omission:

- A **pane split** answers "beside what?", never "in which window" — so the successor inherited the
  predecessor's window, which is the one thing that must not grow.
- `tab create` **requires** a workspace, and "the focused one" is a human's current click, not a
  property of the goal. Anything that depends on focus is a race against the user.

## Fix

`successorWorkspace` (`src/commands/goal.ts`), three sources strongest first: `HERDR_WORKSPACE_ID` (this
pane's own space), then `herdr pane get <baton pane> → result.pane.workspace_id` (the holder's space,
read from the runtime), then **refuse**. A disagreement between the first two is reported and the
environment wins. `--workspace` pins it. The split is gone; a window whose agent never started is
closed again. See
`.ai/decisions/2026-10-18-a-successor-window-opens-in-the-current-herdr-space.md`.

## Guard

- `test/goal-handoff.test.ts` — "the successor window is pinned to this project's space, from three
  sources": all three resolutions plus the disagreement case, as pure function assertions.
- `test/goal-handoff.test.ts` — "a handoff never opens a window when the workspace cannot be
  determined": asserts the call list is `['pane get']` only, i.e. **`tab create` is never reached**, the
  baton does not move and `pendingHandoff` stays.
- `test/goal-handoff.test.ts` — the happy path asserts `--workspace w13`, `--label goal-…` and
  `--no-focus` on the `tab create` argv, so a future refactor cannot quietly drop any of them.
- Verified against real herdr on this machine: `herdr pane get w15:p2` returns `workspace_id: w15` from a
  session in `w13` (a real read, not an echo), `tab create --workspace w99` is refused, and a real
  `goal handoff` opened `w13:t3` in `w13` with `pane_count: 1` — a window, not a split. Both probe tabs
  were closed afterwards.
- **The general question for anything that opens UI:** *does this depend on where the human's focus
  is?* If yes, it will eventually act in the wrong project, because focus is not a property of the goal.
