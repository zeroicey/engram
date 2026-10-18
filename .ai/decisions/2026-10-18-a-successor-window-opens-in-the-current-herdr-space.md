# One herdr space is one project: a successor window opens in the current space, or not at all

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey

## Context

The handoff (M4) opened the successor by **splitting the holder's pane**:

```text
herdr pane split <pane> --direction right --cwd <root> --no-focus
```

That is wrong for how the human actually works, and it took using it to see it:

1. **A split is not a window.** Every handoff made the holder's tab one column narrower, so the
   session that keeps handing off ends up unusable — three handoffs and the transcript is a sliver.
2. **The successor belongs in its own window.** It is a fresh session with a fresh context; putting it
   beside the predecessor's transcript suggests they share one.
3. **A space is a project.** The user's convention: one herdr workspace per project, never several
   projects in one space. So the successor must land in **the same space as the session handing off**
   — and never in another project's space.

The third point was a latent bug, not just an aesthetic one. `tab create` has no implicit workspace:
without `--workspace` it targets **whatever is focused**, and a focused-space default is exactly how a
successor appears in another project. The first version of the tab change passed
`--workspace ''` when it could not read the workspace; herdr rejects that
(`{"error":{"code":"workspace_not_found"}}`), so the failure mode was a broken handoff rather than a
misplaced window — accidentally safe, and only by luck.

## Options

- **A. Keep `pane split`, add `--ratio`.** *Rejected*: the narrowing is the problem.
- **B. `tab create` with no `--workspace`.** *Rejected*: it lands in the focused space, which may be
  another project. This is the failure the rule exists to prevent.
- **C. `tab create` in the workspace of the pane that holds the baton.** *Chosen*, with the sources
  below and a refusal when neither is readable.

## Decision

1. **The successor opens as a tab (`herdr tab create`), never a split.** `--no-focus`, so a handoff
   never steals the keyboard, and `--label`, so the tab bar reads `goal-2026-10-18-…` rather than `2`.
2. **The workspace is resolved from three sources, strongest first** (`successorWorkspace` in
   `commands/goal.ts`):
   1. **`HERDR_WORKSPACE_ID`** — exported by the pane. It is *this session's* space and cannot be stale,
      and it works even when herdr is not readable.
   2. **`herdr pane get <baton pane>` → `result.pane.workspace_id`** — the recorded holder's space, read
      from the runtime. Verified on this machine: reading a pane in another space returns *that* space,
      so this is a real read, not an echo.
   3. **Neither → refuse.** The handoff is not recorded as taken, nothing is opened, and the message
      says a successor outside this project's space would be in another project.
3. **A disagreement between (1) and (2) is reported, not buried.** The environment wins — this session
   decides where its own successor goes — but the line says
   `this session is in w13 but the baton's pane is in w14; using w13`, because a mismatch almost always
   means the goal was created in a different window and someone should know.
4. **`--workspace <id>` pins it explicitly**, for a human resolving that mismatch without editing code.
5. **A window whose agent never started is closed again.** `agent start` needs the pane at an
   interactive shell prompt and a directory pi has trusted; in a fresh directory pi stops at
   *"Trust project folder?"*, herdr reports no session path, and the old code left an empty window
   behind. The failure now closes the tab and names the cause.
6. **Nothing else may open a window.** This is the only place in engram that asks herdr for one, so the
   rule has one implementation and one test file.

## Consequences

- The human's tab bar gains one labelled window per handoff and the predecessor's tab is untouched.
- A handoff can now fail *before* anything opens (no resolvable workspace), which is the right order:
  the request stays on the record and the stale-handoff escalation still applies.
- `HERDR_WORKSPACE_ID` becomes a second reason the runtime identity is read from the environment, next
  to `PI_SESSION_FILE` and `HERDR_PANE_ID`.
- The old `pane split` path is gone, not kept as a fallback. A fallback that quietly reverts to
  splitting would reintroduce the narrowing the moment `tab create` fails.

## Revisit when

- herdr gains a "same workspace as pane X" argument for `tab create`, which would collapse sources (1)
  and (2) into one.
- A project ever legitimately spans two spaces (a monorepo split by component), which would make
  "same space" the wrong rule rather than the safe one.
