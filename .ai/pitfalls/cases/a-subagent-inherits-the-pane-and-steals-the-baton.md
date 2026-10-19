# A subagent inherits the pane, so `samePane` adoption gave it the baton

**Severity:** 🔴 high · **Date:** 2026-10-19

## Symptom

Six review subagents were launched from a session driving a goal. Within the same second the goal's
`baton.sessionPath` changed from the holder's session to a **nested child** session:

```
before  …/2026-10-19T07-41-21-205Z_01a1531b-9db5-76da-b6f0-b71601ed8540.jsonl
after   …/2026-10-19T07-41-21-205Z_01a1531b-9db5-76da-b6f0-b71601ed8540/9c73a805-…/run-0/session.jsonl
```

The holder's next `goal_report` was refused with `not the baton holder for this goal` — by the goal it
was driving. The thief was a reviewer that held none of the preceding context and would never report.
The goal did not crash or escalate; it went quietly to the wrong owner, which is the worst shape of
failure for a liveness latch.

## Root cause

`onReconcile` adopts on `samePane` so a **killed pi** can take back a goal it used to hold: a restart is
a new session *file* on the *same pane*, and refusing it once left a 10-minute wait with nobody to wake
it (`.ai/pitfalls/cases/a-restarted-pi-could-not-adopt-its-own-goal.md`).

But `HERDR_PANE_ID` is an **inherited environment variable**. Every child a holder spawns reports the
holder's pane, while its own `PI_SESSION_FILE` names the child. So `!sameHolder && samePane` was true for
each of the six children, and the first `session_start` hook to run took the goal.

This is the repository's recurring shape — *a guard enforced on one side of a transition and not the
other*: `wake`, `poll` and `report` all refuse an identified non-holder, and `reconcile` handed the
same caller ownership. The asymmetry was invisible because the only test fixture used one session.

## Fix

`isNestedSession(holder, candidate)` in `src/core/goal.ts`, and adoption now requires
`samePane && !nested`. The discriminator is **where the session file sits**, which no child can forge
and no env var reports:

| Case | Path shape |
| --- | --- |
| restart (adopt) | same directory: `/s/one.jsonl` → `/s/two.jsonl` |
| child agent (refuse) | nested: `/s/one.jsonl` → `/s/one.jsonl/x/run-0/session.jsonl` |

"Nested" means the remainder below the parent still contains a `/`. The first version tested only
`startsWith(parent + '/')`, which matches a **sibling** too, and broke the restart it exists for — the
existing restart test caught it immediately.

A nested session **keeps the same pane**, so it is not an intruder: it gets `ignore`, not the
`schedule-wake` that an intruder from another pane is refused (that effect is one only the parent could
act on). Recovery is a plain `reconcile` from the real holder, which is now a sibling of the thief and
adopts itself back.

`goal.ts` still has **zero imports** — the check is string slicing, not `node:path`.

## Guard

- `test/goal.test.ts` — *a subagent child inherits the pane and must not adopt the goal*: the measured
  nested path is refused with `ignore`, the baton is unchanged, the wait is untouched **and** a sibling
  restart still adopts with `schedule-wake`. Both halves, because the fix for one was the bug in the
  other.
- **Ask of any adoption rule:** what else in this process tree carries the same identity by
  *inheritance*? An env var is not evidence of "the same actor" — it is evidence of "the same
  ancestor". Prefer a value only the actor can generate (a path, a token, a socket address).
- **Ask of a baton transfer:** if this is refused, is the refusal loud? This one was silent until the
  holder tried to report; nothing in `goal status` distinguishes "I am the holder" from "someone's
  child is".
