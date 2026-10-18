# A wake was consumed before it was delivered — in both transports

**Severity:** 🔴 high · **Date:** 2026-10-18

## Symptom

Two live probes, two different transports, one shape.

**L2 (the in-process timer), a real `pi --print` session.** The model parked the goal on
`wakeOnSeconds=12`. At the planned instant the timer fired, `pi.sendMessage(…, {triggerTurn: true})`
threw `This extension ctx is stale after session replacement or reload.`, the throw escaped a
`setTimeout` callback, and node died with an uncaught exception. The engine had already consumed the
wait (`status: running`, `wake: null`) — so a goal that was parked, healthy and watched became
`running` with nobody driving it.

**L3 (`goal wake --deliver`).** `runGoalWake` reduced the wake (consuming the token) and called
`writeGoalRecord` **before** asking herdr to prompt the pane. A failed delivery therefore left the
same state — and the test for it asserted exactly that, with the comment *"the token is still
consumed, so a replay cannot double-charge; the deadline is what recovers it"*.

## Root cause

The deadline claim was false twice over, and it is the reason nobody looked:

- `onReconcile` escalates an expired wait only while `status === 'waiting'` **and** `wake` is set. A
  consumed wake is neither, so the 24h liveness deadline never looked at the goal again.
- A liveness deadline is a bound on *waiting*, not a recovery channel for a broken transport. Only
  `waiting` is recoverable, so the transport must not leave it.

Underneath both symptoms is one ordering rule: **the step that consumes a wake must come after the step
that delivers it.** The transport is the thing that can fail; the record is the thing that must survive
it. Consuming first converts "the delivery failed" into "there is nothing left to deliver", and the
failure becomes unreportable because the state it would be reported about has been erased.

Three sub-shapes, all fixed:

1. **The question consumed its own answer.** `poll` (has the condition come true?) released the latch,
   so a host that could not deliver had already destroyed the wait. It now answers `wake-ready` — the
   message to deliver, and no state change. The claim (`wake`) is a separate call.
2. **An unguarded `pi` call from a timer callback.** `pi.sendMessage` is documented for exactly this,
   but the captured `pi` is dead after a reload, a session replacement or a shutdown, and a throw from
   `setTimeout` is an uncaught exception in the *host* process. Delivery is now wrapped, and the timer
   paths use a guarded notify.
3. **A retry that would have made it worse.** The first fix retried the delivery after 1s. A stale
   runtime never comes back, and a pending `setTimeout` keeps node's event loop alive — so a
   shutting-down process would have stayed open until the deadline, spinning a spawn per second for up
   to a day. Measured in print mode. There is now no retry; the latched token is the recovery.

## Fix

- `poll` → `wake-ready` (peek). `wake`/claim → the transition. One builder for the message so the text
  the model reads is the engine's, whichever path ran.
- The extension delivers inside `try/catch`; on failure it notifies (guarded) and **stops**, leaving
  the latch for the next `session_start` → `reconcile` to re-arm.
- `runGoalWake` delivers first and writes the record only when the delivery succeeded, and a failed
  delivery is now exit 1 with `still waiting — the wake was not consumed`.

## Guard

- `test/goal-extension.test.ts` — a `sendMessage` that throws (a stub runtime): the record must still
  be `waiting` with a latched token, exactly one delivery attempt must have happened, and a **fresh**
  extension instance must recover it. The throw is real (not a mocked return), so an unguarded call
  fails the test run rather than passing quietly.
- `test/goal-unit.test.ts` — "unreachable herdr leaves the wait latched, so the wake can still be
  delivered": asserts `waiting` + the token, then retries and asserts the delivery and the transition.
- `test/goal.test.ts` — a satisfied `poll` asserts `status: waiting` and a `wake-ready` effect; the
  claim is a separate step.
- Live, this session: print mode → no crash, no hang, latch intact, process exits ~1s after the fire;
  RPC mode (a pi process that stays alive) → `agent_start #2` 2s after the plan and `wake: null`, i.e.
  the timer really started a new run in a live session.
- **Ask of any future transport:** *if delivery fails here, what still knows the goal is waiting?* If
  the answer is "nothing", the consume step is in the wrong place. And treat a comment that claims a
  guarantee as unverified until a test fails without it — the L3 comment asserted this exact property
  while the code did the opposite.

## Not ours, but seen while probing

A run started by `triggerTurn` produced `extension_error … event: "turn_end" … "could not resolve the
persisted assistant entry ID"`, reported against `extensionPath: "<boundary>"`. The engram carrier's
`turn_end` handler does nothing but read context usage, and the message appears in no engram source, so
this is pi's own bookkeeping on a custom-message-started run. Recorded so the next reader does not
attribute it to the goal engine.
