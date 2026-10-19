/**
 * The goal engine's host-free core: four states, one report verb, a wait latch, two stuck
 * detectors.
 *
 * Why a pure reducer. The engine has to survive a pi restart, run without a pi process in tests,
 * and be embedded in an extension without dragging `engram`'s CLI into a lifecycle. So nothing here
 * touches the filesystem, the clock or a host API: time is passed in as an ISO string, and the
 * result of a transition is `{ record, effects }` where effects are *descriptions* the adapter
 * executes (`nudge`, `escalate`, `evaluate`, `schedule-wake`, …). That is what makes "the model may
 * stop, the engine is never the one that stops" testable in-memory.
 *
 * The states are exactly the four from
 * `.ai/decisions/2026-10-18-treat-waiting-as-a-first-class-goal-state-with-a-self-wake-c.md`:
 * `running` / `waiting` / `blocked` / `done`. Closure (`done`, or a human cancelling) is recorded
 * as `closedAt` + `closeReason` rather than as a fifth status, so `done` keeps meaning the one thing
 * the engine observed: a `done_when` verdict passed.
 *
 * `done_when` itself is **not** stored here. It is declared in `.ai/goal/<id>/BRIEF.md` (see
 * `.ai/decisions/2026-10-18-verify-goal-completion-with-a-command-a-metric-or-an-evidenc.md`), and
 * the parsed view arrives as `GoalView.brief`. One source of truth: goal.json records what happened,
 * the brief records what would count as finished.
 */

export type GoalStatus = 'running' | 'waiting' | 'blocked' | 'done';

export type MetricOp = '>=' | '<=' | '>' | '<' | '==' | '!=';

/**
 * How completion is decided. Exactly one shape, strongest first: a command's exit code, a
 * machine-written metric compared by the engine, or an evidenced checklist.
 */
export type DoneWhen =
  | { kind: 'cmd'; commands: string[] }
  | { kind: 'metric'; file: string; path: string; op: MetricOp; value: number | string }
  | { kind: 'checklist'; file: string };

/**
 * What a wait is waiting *for*, not how it is delivered.
 *
 * `human` is deliberately absent: waiting on a person is `blocked`, which routes to the
 * needs-attention path instead of arming a timer.
 */
export type WakeCondition =
  | { kind: 'time'; seconds: number }
  | { kind: 'process'; pid: number }
  | { kind: 'artifact'; path: string };

/** Who is driving the goal right now. Exactly one per project (`goal.json` names it). */
export interface Baton {
  sessionPath: string;
  paneId: string | null;
  startedAt: string;
}

export interface WakeRecord {
  token: string;
  condition: WakeCondition;
  requestedAt: string;
  /** Liveness bound: if nothing arrives by then, the goal escalates instead of staying silent. */
  deadlineAt: string;
}

export interface Blocker {
  reason: string;
  /** How many times *this same* reason has been reported; drives the escalation floor. */
  repeats: number;
  needs: string | null;
  raisedAt: string;
}

/** `.ai/goal/<id>/goal.json` — what happened. Machine-owned. */
export interface GoalRecord {
  version: 1;
  id: string;
  /** The goal text as the human stated it. */
  goal: string;
  status: GoalStatus;
  baton: Baton | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closeReason: CloseReason | null;
  /** `goal_report(status=progress)` calls that counted (i.e. after classification). */
  rounds: number;
  /** Every `goal_report` call, including the ones that were rejected. */
  reports: number;
  wake: WakeRecord | null;
  /** Monotonic, so wake tokens are deterministic and testable. */
  wakeSeq: number;
  /** Last working-tree digest supplied by the host; `null` when the host cannot see one. */
  lastDigest: string | null;
  unchangedRounds: number;
  /**
   * Consecutive settlements with no `goal_report` at all.
   *
   * Without this the loop has no floor. Both stuck detectors are driven by reports, so a model that
   * simply never calls the tool settles forever: measured at 50 nudges and 0 rounds on a stand-in
   * reducer run. It is the "unconditional continuation can loop" failure pi's own docs warn about,
   * and it is the one shape of stuckness no counter was watching.
   */
  unreportedSettles: number;
  blocker: Blocker | null;
  lastNote: string | null;
  /** A `done` claim whose `done_when` evaluation has not come back yet. */
  pendingVerdict: { claimedAt: string; claim: string | null } | null;
  lastVerdict: { passed: boolean; detail: string; at: string } | null;
  pendingHandoff: { requestedAt: string; reason: string | null } | null;
  /** Wakes that arrived while `blocked`: kept so nothing is silently lost. */
  pendingWakes: Array<{ reason: string; at: string }>;
}

export type CloseReason = 'completed' | 'cancelled' | 'abandoned';

/** `.ai/goal/<id>/BRIEF.md`, parsed. */
export interface GoalBrief {
  doneWhen: DoneWhen | null;
  /** Why the brief has no usable `done_when` — a typo must not read as "not classified yet". */
  error: string | null;
}

export interface GoalView {
  record: GoalRecord;
  brief: GoalBrief;
}

/** The singleton tool surface. Five verbs, one of which is a question (`handoff`). */
export type GoalReport =
  | { status: 'progress'; note?: string }
  | { status: 'wait'; wakeOn: WakeCondition; note?: string }
  | { status: 'blocked'; reason: string; needs?: string }
  | { status: 'done'; claim?: string }
  | { status: 'handoff'; reason?: string };

export type GoalEvent =
  /** A new agent run began: background-task completion, `herdr agent prompt`, a human typing. */
  | { kind: 'run-started'; now: string; sessionPath?: string }
  /** The run finished producing output; the continuation guard's trigger point. */
  | { kind: 'settled'; now: string; sessionPath?: string }
  | { kind: 'report'; now: string; report: GoalReport; digest?: string | null; sessionPath?: string }
  /** The `done_when` evaluator's result, fed back after an `evaluate` effect ran. */
  | {
      kind: 'verdict';
      now: string;
      passed: boolean;
      detail: string;
      digest?: string | null;
      /**
       * The emitter's identity, when it has one — the same one-sided rule as `wake`.
       *
       * `engram goal check` run by a human has no session and must keep working (it is the manual
       * recovery path), but the *same verb* emitted from another pane's session used to close an
       * anyone's goal with `status: done`. An identified non-holder is now refused.
       */
      sessionPath?: string;
    }
  /**
   * An external wake (`goal wake <id> --reason …`), addressed to the goal, not to a pane.
   *
   * `sessionPath` is the *emitter's* identity, when it has one, and it is not a change of addressee:
   * the token still resolves against `goal.json`. It exists because an in-process timer survives a
   * handoff in the pane that armed it — see the guard in `reduce`.
   */
  | { kind: 'wake'; now: string; token: string; reason: string; sessionPath?: string }
  /**
   * The host asking whether the wait's condition has come true — the timer reaching its plan, or a
   * poll finding a pid gone or an artifact present.
   *
   * A question, not a claim: `observed` is what the CLI saw on the machine (and is meaningless for
   * `time`, which the engine times itself), and the engine decides whether that is a wake. The host
   * owns the clock and nothing else; there is no engine process while pi is idle.
   */
  | { kind: 'poll'; now: string; token: string; observed: boolean; sessionPath?: string }
  /**
   * Session start / restart: re-arm a live wait, or escalate one whose deadline has passed.
   *
   * Carries the starting session's identity because **a restart replaces the baton's holder**. A killed
   * pi comes back as a *new session file*, so the recorded baton names a session that no longer exists;
   * refusing the newcomer left the latch armed with nobody to wake it (measured: a 10-minute wait whose
   * timer never fired after the process was restarted, because every event from the new session was
   * `ignore`d). See `onReconcile`.
   */
  | { kind: 'reconcile'; now: string; sessionPath?: string; paneId?: string }
  | { kind: 'close'; now: string; reason: Exclude<CloseReason, 'completed'>; sessionPath?: string };

export type GoalEffect =
  /** Continue the loop: `agent_before_settle` → `{ continue: true, entries: [...] }`. */
  | { kind: 'nudge'; reason: 'continue' | 'classify' | 'wake' | 'verdict-failed'; message: string }
  /** Stay quiet. A latched wait or a human-facing block must not burn tokens. */
  | { kind: 'silent'; reason: 'waiting' | 'blocked' | 'done' | 'handoff-requested' }
  /**
   * The wait's condition is true, and the message to deliver is here — but **nothing has moved yet**.
   *
   * A question must not be the thing that consumes its own answer: a host that cannot deliver the
   * message (a stale runtime after a reload, a session replacement, a shutdown) has consumed nothing,
   * so the wait stays latched and the next reconcile or retry can still wake it. The claim is
   * `kind: 'wake'`, and it is the only thing that releases the latch.
   */
  | { kind: 'wake-ready'; token: string; reason: string; message: string }
  | { kind: 'escalate'; severity: 'needs-input' | 'stuck'; message: string }
  /** Run the evaluator, then feed the answer back as a `verdict` event. */
  | { kind: 'evaluate'; doneWhen: DoneWhen }
  | { kind: 'schedule-wake'; token: string; condition: WakeCondition; fireAt: string | null; deadlineAt: string }
  | { kind: 'clear-wake'; token: string }
  | { kind: 'handoff'; message: string }
  | { kind: 'done-observed'; message: string }
  /** The event was not this session's business — a non-holder tried to drive the goal. */
  | { kind: 'ignore'; reason: string };

export interface GoalStep {
  record: GoalRecord;
  effects: GoalEffect[];
}

/**
 * The largest instant a JavaScript `Date` can hold, in ms since the epoch (`8.64e15`).
 *
 * Anything past it is an `Invalid Date`, and `.toISOString()` on one throws `RangeError`. That mattered
 * because `wakeOnSeconds` is model-controlled and bounded only at the low end: `1e15` passed validation,
 * `seconds * 1000` overflowed the Date range, and the exception escaped `reduce` — the one thing the
 * engine's own contract forbids, since it runs inside a lifecycle hook and takes the session with it.
 * Measured: `engram goal event --type report --report '{"status":"wait","…","wakeOnSeconds":1e15}'`
 * printed `Invalid time value` and no JSON document.
 */
const MAX_DATE_MS = 8.64e15;

/**
 * An ISO instant, or `null` when the sum is not representable.
 *
 * One helper for both wake times, so the overflow bound cannot be applied in one place and forgotten in
 * the other — which is exactly how the two callers disagreed before.
 */
function isoOrNull(ms: number): string | null {
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  return new Date(ms).toISOString();
}

export interface GoalLimits {
  /** Liveness deadline for a wait, in milliseconds. Default 24h. */
  livenessMs: number;
  /** Consecutive rounds with an unchanged working-tree digest before escalating. */
  stuckRounds: number;
  /** Identical blocked reasons before the escalation stops being a question and becomes `stuck`. */
  blockedRepeats: number;
  /** Settlements in a row with no report at all before the loop is declared stuck. */
  silentSettles: number;
}

/**
 * Defaults come straight from the two accepted decisions: 24h liveness, and *two* detectors rather
 * than a token/round budget. Discovered in `research`, not invented here.
 */
export const DEFAULT_LIMITS: GoalLimits = {
  livenessMs: 24 * 60 * 60 * 1000,
  stuckRounds: 5,
  blockedRepeats: 3,
  silentSettles: 8,
};

/** Context threshold that *asks* the agent to judge a handoff. A reminder, never a trigger. */
export const CONTEXT_REMINDER_PERCENT = 85;

const REASON_NO_PROGRESS = 'no file change across consecutive rounds';
const REASON_WAIT_EXPIRED = 'wait exceeded its liveness deadline';
const REASON_HANDOFF_STALE = 'handoff was requested but never taken';
const REASON_VERDICT_UNANSWERED = 'a done claim was never answered by the gate';

const CLASSIFY_MESSAGE =
  'This goal has no machine-checkable done_when yet. Write `.ai/goal/<id>/BRIEF.md` with a ' +
  '`## Done when` section containing one ```json block: {"kind":"cmd","commands":[…]} or ' +
  '{"kind":"metric",…} or {"kind":"checklist","file":…}. If none of the three can be produced, ' +
  'report blocked instead — do not start working.';

const CONTINUE_MESSAGE =
  'No goal_report was filed for that turn. Continue toward the goal, or report progress / wait / ' +
  'blocked / done — do not stop silently.';

/**
 * The continuation sent after a *reported* `progress`.
 *
 * Deliberately different from `CONTINUE_MESSAGE`: telling a model that filed a report that it filed
 * none is a false statement, and a model that reads it will "correct" itself by reporting twice per
 * turn. The first version of this file sent `CONTINUE_MESSAGE` for both paths.
 */
const PROGRESS_MESSAGE =
  'Progress recorded. Continue toward the goal, and report again before this turn ends.';

export const isClosed = (record: GoalRecord): boolean => record.closedAt !== null;

/**
 * The baton check: only the holder may nudge, wait, hand off or be woken.
 *
 * Three cases, and conflating them was a bug:
 *
 * - `record.baton === null` — nobody holds it yet, so anyone may claim it. This is the first run of
 *   a fresh goal.
 * - `sessionPath === undefined` — the caller **did not identify itself**, which is not the same as
 *   "no baton exists". Treating it as allowed let any unidentified session drive a goal another
 *   session was working on: `onProgress` then cleared that session's blocker and handoff request and
 *   reset its `unreportedSettles`. The shipped pi adapter never passes `--session`, so this was the
 *   *only* reachable branch in practice.
 * - a matching path — allowed.
 */
export function holdsBaton(record: GoalRecord, sessionPath: string | undefined): boolean {
  if (record.baton === null) return true;
  if (sessionPath === undefined) return false;
  return record.baton.sessionPath === sessionPath;
}

function step(record: GoalRecord, effects: GoalEffect[] = []): GoalStep {
  return { record, effects };
}

/** Every transition stamps `updatedAt`; nothing else writes the record. */
function next(record: GoalRecord, now: string, patch: Partial<GoalRecord>): GoalRecord {
  return { ...record, ...patch, updatedAt: now };
}

const silent = (reason: Extract<GoalEffect, { kind: 'silent' }>['reason']): GoalEffect => ({ kind: 'silent', reason });

/**
 * A wait's liveness deadline.
 *
 * For a `time` condition the timer is a *plan*, not a lost notification, so a 30-hour wait must not
 * be escalated at hour 24 just because the default is a day: the deadline is the larger of the
 * default and the planned time plus a minute of grace.
 */
/**
 * The instant a wake's *condition* is planned to be satisfied — `null` for the conditions that have
 * no plan.
 *
 * A `time` wait has one; a `process` or an `artifact` is observed rather than scheduled, so the host
 * polls and there is nothing to name.
 *
 * It is absolute, and derived from the wait's own `requestedAt` rather than from "now", because
 * `reconcile` re-arms the same wait after a restart: a fire time computed from the new `now` would
 * restart the full duration, so a 6-hour wait that survived a restart would take twelve. With the
 * absolute instant, a restart *after* the planned time asks immediately, which is the honest answer —
 * the time already elapsed.
 */
function fireAtFor(condition: WakeCondition, requestedAt: string): string | null {
  if (condition.kind !== 'time') return null;
  const from = Date.parse(requestedAt);
  // Same total-not-throwing rule as `deadlineFor`: a hand-edited timestamp must not throw inside a
  // lifecycle hook, and `null` is already the "no plan" answer.
  if (!Number.isFinite(from)) return null;
  return isoOrNull(from + condition.seconds * 1000);
}

/**
 * What ended, in the words the wake message needs.
 *
 * The model judges the *event* against `done_when`, so "pid 4242 exited" and "out/eval.json appeared"
 * are what it has to read — not `Wake: not yet`. Built here rather than by the host because "what
 * happened" is the engine's account of its own condition; the host only watched for it.
 */
function describeWakeCondition(condition: WakeCondition): string {
  if (condition.kind === 'time') return `${condition.seconds}s elapsed`;
  if (condition.kind === 'artifact') return `${condition.path} appeared`;
  return `pid ${condition.pid} exited`;
}

/**
 * The engine's wake message.
 *
 * One builder for both sides of the delivery: the host delivers the message from `wake-ready` and the
 * claim's message is then discarded, so two builders would be two texts for one event — and the one a
 * model reads would be whichever path happened to run.
 */
function wakeMessage(reason: string): string {
  return `Wake: ${reason}. A process exiting is not success — judge it against done_when before reporting done.`;
}

function deadlineFor(condition: WakeCondition, now: string, limits: GoalLimits): string {
  const nowMs = Date.parse(now);
  // `reduce` is documented as total, and its `now` is caller-supplied. An unparseable timestamp used
  // to make `.toISOString()` throw `RangeError: Invalid time value` from inside a lifecycle hook.
  // Returning the caller's own string keeps the record monotonic instead of crashing.
  if (!Number.isFinite(nowMs)) return now;
  const planned = condition.kind === 'time' ? condition.seconds * 1000 + 60_000 : 0;
  // A wait whose deadline is not representable keeps the caller's own string, which `isPast` treats as
  // expired: the honest answer for "1e15 seconds from now" is that the engine cannot plan it.
  return isoOrNull(nowMs + Math.max(limits.livenessMs, planned)) ?? now;
}

/**
 * Is `deadline` in the past relative to `now`?
 *
 * A malformed deadline (a hand-edited `goal.json`, an empty string) must count as **expired**, not as
 * "not yet": `NaN >= NaN` is false, so the old comparison re-armed a wait that could never fire and
 * the goal stayed silent forever.
 */
function isPast(now: string, deadline: string): boolean {
  const nowMs = Date.parse(now);
  const deadlineMs = Date.parse(deadline);
  if (!Number.isFinite(nowMs)) return false;
  if (!Number.isFinite(deadlineMs)) return true;
  return nowMs >= deadlineMs;
}

/**
 * Apply one event to the goal.
 *
 * Every branch is total: an event that does not apply (a report against a closed goal, a duplicate
 * wake, a non-holder's nudge) returns the record unchanged plus an `ignore`/empty effect list
 * rather than throwing. A state machine that can throw inside `agent_settled` would take the whole
 * session down over a stale token.
 */
export function reduce(
  view: GoalView,
  event: GoalEvent,
  limits: GoalLimits = DEFAULT_LIMITS,
): GoalStep {
  const { brief } = view;
  let record = view.record;

  // Baton enforcement first: a second session in the same project directory must not be able to
  // drive someone else's goal, and it must be told why it is being ignored. An unidentified caller is
  // refused *with a reason naming the fix*, because "pass --session" is actionable and "ignored" is
  // not.
  if (event.kind === 'run-started' || event.kind === 'settled' || event.kind === 'report') {
    if (!holdsBaton(record, event.sessionPath)) {
      const reason =
        event.sessionPath === undefined
          ? 'this event carried no session identity; pass --session so the baton can be checked'
          : 'not the baton holder for this goal';
      return step(record, [{ kind: 'ignore', reason }]);
    }
    // The first identified session to drive a **holderless** goal claims it, in one place rather than in
    // each branch. `holdsBaton` returns true when nobody holds the baton, so without this a goal created
    // the documented human way (`goal new` with no `--session`) had no single holder: two panes would
    // each pass that check and both could drive it, and "one goal, one baton" was enforced only for
    // goals created with an explicit session. `onReconcile` already claims; this is the same move for the
    // three ordinary driving events.
    if (record.baton === null && event.sessionPath !== undefined) {
      record = { ...record, baton: { sessionPath: event.sessionPath, paneId: null, startedAt: event.now } };
    }
  }

  // `verdict` and `close` are the two state-moving verbs this block did not cover, and both were
  // reachable by an identified non-holder:
  //
  // - `verdict` closes a goal with `status: done` + `closedAt` + `closeReason: completed`. It is emitted
  //   by `engram goal check` (a human's shell, another pane) and by the CLI's own in-process evaluator
  //   answering late. Neither carried the baton, and neither was checked. A `P0`: any session in the
  //   project could end anyone's goal, and the goal would read as *verified complete*.
  // - `close` is the escape hatch, and the unidentified path already serves a human at a shell. An
  //   *identified* non-holder cancelling someone else's goal is not the escape hatch.
  //
  // Both keep the unidentified-emitter exemption for the same reason `wake` does: a human's `engram goal
  // check` has no session identity, and refusing that would delete the manual recovery path.
  if (
    (event.kind === 'verdict' || event.kind === 'close') &&
    event.sessionPath !== undefined &&
    !holdsBaton(record, event.sessionPath)
  ) {
    return step(record, [{ kind: 'ignore', reason: 'not the baton holder for this goal' }]);
  }

  // A wake is the one event whose guard is **one-sided**, and both halves are deliberate.
  //
  // An *unidentified* emitter is legitimate: the wake is addressed to the goal, not to a pane (rule
  // 6), so a systemd unit's `ExecStopPost`, herdr's delivery and `goal wake` typed by a human all
  // arrive without a session — refusing them would delete L3 and the human escape hatch in one line.
  //
  // An *identified* emitter that is not the holder is not legitimate, and this became reachable
  // when the in-process timer arrived: a wait survives a handoff, so the predecessor's timer is still
  // armed in a pane that no longer holds the baton, while the successor arms its own at
  // `session_start`. Whoever fires first consumes the token. Letting the predecessor win left the
  // goal `running` with the wake consumed in the wrong pane and the successor idle — a parked goal
  // that nothing was watching, since `waiting` was the only state with a deadline. So a claim is
  // refused; a stranger is not.
  //
  // `poll` is the same guard for the same reason: it is the timer asking, not a human.
  if (
    (event.kind === 'wake' || event.kind === 'poll') &&
    event.sessionPath !== undefined &&
    !holdsBaton(record, event.sessionPath)
  ) {
    return step(record, [{ kind: 'ignore', reason: 'not the baton holder for this goal' }]);
  }

  // The handlers take a *view*, and two of them (`onSettled`, `onReport`) read `view.record` — so the
  // claim above has to reach the view, not just the local. Passing `view` unchanged discarded it, which is
  // how the first version of the claim silently did nothing.
  const current: GoalView = { record, brief };

  switch (event.kind) {
    case 'run-started':
      return onRunStarted(record, event.now, limits);
    case 'settled':
      return onSettled(current, event.now, limits);
    case 'report':
      return onReport(current, event.now, event.report, event.digest ?? null, limits);
    case 'verdict':
      return onVerdict(record, event.now, event.passed, event.detail, event.digest ?? null, limits);
    case 'wake':
      return onWake(record, event.now, event.token, event.reason);
    case 'poll':
      return onPoll(record, event.now, event.token, event.observed);
    case 'reconcile':
      return onReconcile(record, event.now, limits, event.sessionPath, event.paneId);
    case 'close':
      return onClose(record, event.now, event.reason);
  }
}

/**
 * A new run releases the wait latch.
 *
 * This is the whole rule from the waiting decision: the engine never asks *which* channel woke it.
 * "Something happened" releases the mute, and the next settlement decides whether to nudge. It is
 * also what keeps a lost notification from becoming a dead end.
 */
function onRunStarted(record: GoalRecord, now: string, limits: GoalLimits): GoalStep {
  if (isClosed(record)) return step(record, [{ kind: 'ignore', reason: 'goal is closed' }]);

  if (record.status === 'waiting') {
    const effects: GoalEffect[] = [];
    if (record.wake) effects.push({ kind: 'clear-wake', token: record.wake.token });
    // A new run is the agent acting again, so the silent-settle streak restarts — the same rule the
    // `blocked` branch below already applied. Leaving it meant a goal that settled N times, waited, and
    // was woken escalated "settled N+1 times without calling goal_report" on its first settlement back.
    return step(next(record, now, { status: 'running', wake: null, unreportedSettles: 0 }), effects);
  }
  // A human answering a blocked goal is a run. The blocker counters survive on purpose: if the
  // same reason comes back after the answer, that *is* the loop the repeat detector exists for.
  //
  // `unreportedSettles` is different and must reset: it counts settlements that produced no report,
  // and that streak is over the moment a new run begins. Without this, a human replying to a stuck
  // goal left the counter at its ceiling, so the agent's very first settled turn escalated again —
  // the model got no turn at all. Measured: blocked at 8, one run, blocked again at 9.
  //
  // `clear-wake` is pushed here too. The `waiting` branch above always did; this one dropped a live
  // wake with no matching clear, so the adapter's timer stayed armed for a token the goal no longer
  // held. A hand-edited record, or a host that wrote `status: blocked` with a wake still set, made
  // that reachable — and the wake then arrived against a `running` goal and was silently dropped.
  if (record.status === 'blocked') {
    const effects: GoalEffect[] = [];
    if (record.wake) effects.push({ kind: 'clear-wake', token: record.wake.token });
    // `pendingWakes` is drained here, and that is the whole point of the field. Wakes that arrived while
    // a human was the blocker are news *for that blockage*: once the human's answer starts a run, they
    // have been read (they were escalated, and `goal status` listed them). Leaving them set made the
    // count accumulate across every later blockage, so `4 wake(s) arrived while blocked` described wakes
    // from three unrelated incidents and the reader could not tell which were still unanswered. Same
    // rule as `pendingHandoff`: ask which transition retires a `pending*` field, on every path.
    return step(next(record, now, { status: 'running', wake: null, unreportedSettles: 0, pendingWakes: [] }), effects);
  }
  return step(record);
}

/**
 * The continuation guard.
 *
 * `silent` while waiting or blocked is the point of both states. A pending verdict is the one case
 * that must **not** go quiet: nothing else in the system resolves it, so pure silence there is a
 * permanent mute with the goal still `running`. Re-asking the evaluator is the resolution.
 *
 * And a run that reports nothing, over and over, is a third kind of stuckness that has to have a
 * floor: every other detector is driven by `goal_report`, so a model that never calls the tool would
 * settle forever and the goal would look healthy the whole time.
 */
function onSettled(view: GoalView, now: string, limits: GoalLimits): GoalStep {
  const { record, brief } = view;
  if (isClosed(record)) return step(record, [silent('done')]);
  if (record.status === 'waiting') return step(record, [silent('waiting')]);
  if (record.status === 'blocked') return step(record, [silent('blocked')]);
  if (record.pendingVerdict && brief.doneWhen) {
    // Re-asking is correct — nothing else resolves a pending verdict — but it must be *bounded*.
    // `pendingVerdict` is cleared only by a verdict, a block or a close, so an unanswered claim (a
    // host crash between the two writes) re-emitted `evaluate` on every settlement forever, and
    // `unreportedSettles` was never incremented on this path: the silent-settle floor could not fire
    // either. Two unbounded questions in a row with no detector watching is a permanent mute.
    // Parsed once, and an unparseable `claimedAt` counts as **stale** rather than throwing. The store
    // deliberately repairs a hand-edited record (`claimedAt: str(...) ?? ''`), and `Date.parse('')` is
    // NaN — so the one input `isPast` exists to survive reached `.toISOString()` before `isPast` saw it.
    const claimedMs = Date.parse(record.pendingVerdict.claimedAt);
    // `claimedMs + limits.livenessMs` is the second unbounded `Date` in this file, and `isoOrNull` was
    // added for the first one. A `livenessMs` above ~8.64e15 (or `Number.MAX_SAFE_INTEGER`, which is
    // what a hand-edited config can carry) makes the sum an invalid time and `.toISOString()` throws
    // `RangeError` **out of a reducer documented as total** — the identical shape as the
    // `wakeOnSeconds: 1e15` bug, in a branch that fix did not reach. `isoOrNull` is the existing
    // answer: `null` means "not representable", which is not a deadline that has passed.
    const verdictDeadline = isoOrNull(claimedMs + limits.livenessMs);
    // Two different "not a date" cases, and conflating them was the mistake in the first cut of this fix:
    //
    // - `claimedAt` unparseable → **stale**. That is the store's documented repair of a hand-edited
    //   record, and escalating is what resolves it.
    // - `claimedAt + livenessMs` past the Date range → **not stale**. A `livenessMs` that large means
    //   "never expire"; escalating immediately would invert the setting it was given. Re-ask instead.
    const stale = !Number.isFinite(claimedMs) || (verdictDeadline !== null && isPast(now, verdictDeadline));
    if (stale) {
      return step(
        next(record, now, {
          pendingVerdict: null,
          status: 'blocked',
          blocker: { reason: REASON_VERDICT_UNANSWERED, repeats: 1, needs: 'human review', raisedAt: now },
        }),
        [
          {
            kind: 'escalate',
            severity: 'needs-input',
            message: `A done claim from ${record.pendingVerdict.claimedAt} was never answered by done_when.`,
          },
          silent('blocked'),
        ],
      );
    }
    return step(record, [{ kind: 'evaluate', doneWhen: brief.doneWhen }]);
  }
  // A pending handoff must not mute the loop **unbounded**, and the reasoning is what makes the bound
  // safe: reaching this point at all means the settling session still holds the baton, because the baton
  // check refuses a predecessor whose transfer succeeded. So "pending" here means "the handoff was
  // requested and did not happen" — no herdr, a refused prompt, a human who closed the window — and the
  // holder has to keep working. Measured dead end before this: the 85 % reminder suggests a handoff, the
  // model asks for one, `runGoalHandoff` refuses before it records anything, and the record keeps
  // `pendingHandoff` — so every later settlement returned `silent('handoff-requested')` with no nudge, no
  // notification, and **no increment of `unreportedSettles`**, which is the floor that would have caught
  // it. A `running` goal with nothing watching it, and no deadline, because only `waiting` has one.
  if (record.pendingHandoff) {
    const unreported = record.unreportedSettles + 1;
    return step(next(record, now, { unreportedSettles: unreported }), [
      {
        kind: 'nudge',
        reason: 'continue',
        message:
          'A handoff was requested but was not taken, and you still hold the baton. Continue the goal, ' +
          'or report blocked if a successor is genuinely needed — do not stop silently.',
      },
    ]);
  }

  const unreportedSettles = record.unreportedSettles + 1;
  if (unreportedSettles >= limits.silentSettles) {
    // Escalate rather than nudge: the model has been asked N times in a row and has not answered.
    // Continuing to ask spends tokens on the same non-answer.
    return step(
      next(record, now, {
        status: 'blocked',
        unreportedSettles,
        blocker: {
          reason: `no goal_report for ${unreportedSettles} consecutive settlements`,
          repeats: 1,
          needs: 'the agent to call goal_report, or a human',
          raisedAt: now,
        },
      }),
      [
        {
          kind: 'escalate',
          severity: 'stuck',
          message: `The agent settled ${unreportedSettles} times without calling goal_report. Stopping the loop.`,
        },
        silent('blocked'),
      ],
    );
  }

  return step(next(record, now, { unreportedSettles }), [
    { kind: 'nudge', reason: 'continue', message: CONTINUE_MESSAGE },
  ]);
}

function onReport(
  view: GoalView,
  now: string,
  report: GoalReport,
  digest: string | null,
  limits: GoalLimits,
): GoalStep {
  const { record, brief } = view;
  if (isClosed(record)) return step(record, [{ kind: 'ignore', reason: 'goal is closed' }]);

  switch (report.status) {
    case 'progress':
      return onProgress(record, brief, now, report.note ?? null, digest, limits);
    case 'wait':
      return onWait(record, now, report.wakeOn, report.note ?? null, limits);
    case 'blocked':
      return onBlocked(record, now, report.reason, report.needs ?? null, limits);
    case 'done':
      if (brief.doneWhen === null) {
        return step(next(record, now, { reports: record.reports + 1 }), [
          { kind: 'nudge', reason: 'classify', message: CLASSIFY_MESSAGE },
        ]);
      }
      // A claim is not a verdict. The engine asks the evaluator and only a passed verdict closes
      // the goal — the model's word is never the thing that ends the run.
      return step(
        next(record, now, {
          reports: record.reports + 1,
          pendingVerdict: { claimedAt: now, claim: report.claim ?? null },
        }),
        [{ kind: 'evaluate', doneWhen: brief.doneWhen }],
      );
    case 'handoff':
      return step(
        next(record, now, {
          reports: record.reports + 1,
          pendingHandoff: { requestedAt: now, reason: report.reason ?? null },
        }),
        [{ kind: 'handoff', message: 'Clean delivery point requested: open the successor pane and transfer the baton.' }],
      );
  }
}

function onProgress(
  record: GoalRecord,
  brief: GoalBrief,
  now: string,
  note: string | null,
  digest: string | null,
  limits: GoalLimits,
): GoalStep {
  const released = record.status === 'waiting'
    ? next(record, now, { status: 'running', wake: null })
    : next(record, now, {});

  // A report that releases a wait — or that merely overwrites it via `patch` below — must cancel the
  // timer, exactly like every other path that clears `wake` (`onRunStarted`, `onBlocked`, `onVerdict`,
  // `onClose`). This was the one branch that dropped a wake and emitted no `clear-wake`, so a host
  // that consumes the effect kept a timer armed for a token the record no longer held. Invisible while
  // nothing consumed the effect; once the L2 timer did, that stale timer asked the engine about a
  // token it had already released — and the answer, for a goal that is now `running`, is nothing.
  const dropped: GoalEffect[] = record.wake ? [{ kind: 'clear-wake', token: record.wake.token }] : [];

  // The classification gate: a goal with no `done_when` may not consume rounds. This is what stops
  // an unverifiable goal before it burns a night of tokens.
  if (brief.doneWhen === null) {
    return step(next(released, now, { reports: released.reports + 1, lastNote: note, unreportedSettles: 0 }), [
      ...dropped,
      { kind: 'nudge', reason: 'classify', message: CLASSIFY_MESSAGE },
    ]);
  }

  // Three cases, not two. `onVerdict` below already had this right; `onProgress` did not, and the
  // difference was a real hole:
  //
  // - a digest equal to the last one -> count the round;
  // - a *different* digest -> real progress, reset;
  // - a `null` digest -> the host cannot see a working tree. That used to **reset** the counter, so a
  //   model that alternated ``digest: null`` with real reports could hold `unchangedRounds` at 0
  //   forever, and on a non-git host the detector could never accumulate at all. A missing digest is
  //   not an unchanged digest — and it is not progress either. Leave the count alone.
  const unchangedRounds =
    digest === null
      ? released.unchangedRounds
      : digest === released.lastDigest && released.lastDigest !== null
        ? released.unchangedRounds + 1
        : 0;
  const patch: Partial<GoalRecord> = {
    status: 'running',
    wake: null,
    reports: released.reports + 1,
    rounds: released.rounds + 1,
    unchangedRounds,
    // Any report at all breaks the silent-settle streak; the loop is being driven.
    unreportedSettles: 0,
    lastDigest: digest ?? released.lastDigest,
    blocker: null,
    pendingHandoff: null,
    lastNote: note,
    // A report is the model answering, which is what the recorded wakes were news *about*. Leaving them
    // set made `goal status` keep printing "N wake(s) arrived while blocked" for a goal that is not
    // blocked, across every later blockage — the same staleness `onRunStarted` was fixed for.
    pendingWakes: [],
  };

  if (unchangedRounds >= limits.stuckRounds) {
    return step(
      next(released, now, {
        ...patch,
        status: 'blocked',
        blocker: { reason: REASON_NO_PROGRESS, repeats: 1, needs: 'human review', raisedAt: now },
      }),
      [
        ...dropped,
        {
          kind: 'escalate',
          severity: 'stuck',
          message: `${limits.stuckRounds} rounds produced no file change. Escalating instead of continuing.`,
        },
        silent('blocked'),
      ],
    );
  }
  return step(next(released, now, patch), [
    ...dropped,
    { kind: 'nudge', reason: 'continue', message: PROGRESS_MESSAGE },
  ]);
}

function onWait(
  record: GoalRecord,
  now: string,
  condition: WakeCondition,
  note: string | null,
  limits: GoalLimits,
): GoalStep {
  const token = `wake-${record.wakeSeq + 1}`;
  const deadlineAt = deadlineFor(condition, now, limits);
  // The plan, not the deadline: `fireAt` is when the condition is expected to hold, `deadlineAt` when
  // the engine stops waiting for it. The host arms its timer for the former and reports to the engine
  // at the latter.
  const fireAt = fireAtFor(condition, now);
  const wake: WakeRecord = { token, condition, requestedAt: now, deadlineAt };
  const effects: GoalEffect[] = [];
  // Replacing a wait must cancel the old timer, or the old token would wake the goal out of the new
  // wait — a wake the goal can no longer match, which reads as a lost notification.
  if (record.wake) effects.push({ kind: 'clear-wake', token: record.wake.token });
  effects.push({ kind: 'schedule-wake', token, condition, fireAt, deadlineAt }, silent('waiting'));

  return step(
    next(record, now, {
      status: 'waiting',
      wake,
      wakeSeq: record.wakeSeq + 1,
      reports: record.reports + 1,
      blocker: null,
      // The silent-settle floor counts settlements since the agent last *spoke*. A report is speaking,
      // so the streak is over and the counter must restart here — exactly as `onProgress` does it.
      // Without this, a goal that settled N times, then legitimately reported `wait`, woke, and settled
      // once more hit the ceiling on that first settlement and escalated "settled N+1 times without
      // calling goal_report" about an agent that had just reported. The detector was measuring stale
      // bookkeeping instead of the current streak.
      unreportedSettles: 0,
      // A wait is a later statement of what the goal is doing, so the earlier handoff request does not
      // survive it.
      pendingHandoff: null,
      // `pendingWakes` are news *for a blockage* that this wait has now replaced. Leaving them set made
      // `goal status` keep printing "N wake(s) arrived while blocked" for a goal that had not been
      // blocked since — the staleness `onProgress`, onVerdict and the blocked branch of `onRunStarted`
      // were each fixed for. This is the fourth path; the rule is the same on every one.
      pendingWakes: [],
      lastNote: note,
    }),
    effects,
  );
}

function onBlocked(
  record: GoalRecord,
  now: string,
  rawReason: string,
  needs: string | null,
  limits: GoalLimits,
): GoalStep {
  const reason = rawReason.trim();
  const repeats = record.blocker?.reason === reason ? record.blocker.repeats + 1 : 1;
  const severity = repeats >= limits.blockedRepeats ? 'stuck' : 'needs-input';
  const effects: GoalEffect[] = [];
  if (record.wake) effects.push({ kind: 'clear-wake', token: record.wake.token });
  effects.push(
    {
      kind: 'escalate',
      severity,
      message:
        severity === 'stuck'
          ? `Blocked ${repeats}x on the same reason: ${reason}`
          : `Blocked: ${reason}${needs ? ` — needs ${needs}` : ''}`,
    },
    silent('blocked'),
  );

  return step(
    next(record, now, {
      status: 'blocked',
      wake: null,
      reports: record.reports + 1,
      blocker: { reason, repeats, needs, raisedAt: now },
      pendingVerdict: null,
      // A block supersedes a handoff request: the human is now the thing being waited on, and leaving
      // both set meant the request outlived its reason and muted the loop after the human answered.
      pendingHandoff: null,
    }),
    effects,
  );
}

/**
 * A failed verdict is progress-free by definition, so it feeds the same no-change detector as a
 * quiet round. Without that, "claim done → gate fails → claim done" is an unbounded loop that the
 * blocked-repeat detector can never see.
 */
function onVerdict(
  record: GoalRecord,
  now: string,
  passed: boolean,
  detail: string,
  digest: string | null,
  limits: GoalLimits,
): GoalStep {
  if (isClosed(record)) return step(record, [{ kind: 'ignore', reason: 'goal is closed' }]);

  const lastVerdict = { passed, detail, at: now };

  if (passed) {
    const effects: GoalEffect[] = [];
    if (record.wake) effects.push({ kind: 'clear-wake', token: record.wake.token });
    effects.push({ kind: 'done-observed', message: `done_when passed: ${detail}` });
    return step(
      next(record, now, {
        status: 'done',
        closedAt: now,
        closeReason: 'completed',
        wake: null,
        pendingVerdict: null,
        pendingHandoff: null,
        lastVerdict,
      }),
      effects,
    );
  }

  const unchanged = digest !== null && record.lastDigest !== null && digest === record.lastDigest;
  const unchangedRounds = unchanged ? record.unchangedRounds + 1 : record.unchangedRounds;

  // A failed verdict leaves the wait behind, so it must retire it — this was the one transition that
  // moved `status` *away from* `waiting` while neither setting `wake: null` nor emitting `clear-wake`.
  // Reachable with one documented verb: `report wait` (timer armed) → a human runs `engal goal check` →
  // the gate fails → the record claims a live wait in a `running` goal, the host's timer stays armed, and
  // when the job finally ends `goal wake --token` answers "ignored (the goal is not waiting)" — so the
  // message the model had to read is never delivered.
  const dropped: GoalEffect[] = record.wake ? [{ kind: 'clear-wake', token: record.wake.token }] : [];

  // The status is *kept*, not forced to `running`. A `blocked` goal whose gate was re-checked by a human
  // is still blocked — promoting it silently printed `status: running` next to `blocked: <reason>` and
  // nudged the model out of a state whose whole meaning is "a human must act".
  const patch: Partial<GoalRecord> = {
    status: record.status === 'waiting' ? 'running' : record.status,
    wake: null,
    pendingVerdict: null,
    lastVerdict,
    unchangedRounds,
    lastDigest: digest ?? record.lastDigest,
    // A verdict is the gate answering, so the wakes that arrived during a blockage have been read.
    pendingWakes: record.status === 'blocked' ? [] : record.pendingWakes,
  };

  if (unchangedRounds >= limits.stuckRounds) {
    return step(
      next(record, now, {
        ...patch,
        status: 'blocked',
        blocker: { reason: REASON_NO_PROGRESS, repeats: 1, needs: 'human review', raisedAt: now },
      }),
      [
        ...dropped,
        { kind: 'escalate', severity: 'stuck', message: `done_when kept failing: ${detail}` },
        silent('blocked'),
      ],
    );
  }
  return step(next(record, now, patch), [
    ...dropped,
    { kind: 'nudge', reason: 'verdict-failed', message: `done_when did not pass: ${detail}` },
  ]);
}

/**
 * A poll: the host asking whether the wait's condition is true yet.
 *
 * Why this is an event and not a convention: the host owns the clock — there is no engine process
 * while pi is idle — and *nothing else*. Whether the condition holds is the engine's call, so `time`
 * is decided here from the wait's own `requestedAt` and never from the host's arithmetic, and the two
 * observed conditions arrive as an answer the CLI looked up. A satisfied poll is a wake and shares its
 * transition exactly: "the condition came true" and "someone says it is over" differ in who decided,
 * not in what happens next.
 *
 * A poll that is not satisfied answers `silent('waiting')` rather than nothing: "still waiting" is
 * information the host acts on — it is the answer that says *ask again* — and inferring it from an
 * empty effect list would make an empty list mean two different things (see
 * `pitfalls/cases/destructive-cleanup-on-empty-input.md`).
 *
 * A poll that *is* satisfied answers `wake-ready` and changes nothing. The consumption is the claim
 * (`onWake`), and it is a separate call on purpose — see `wake-ready`.
 */
function onPoll(record: GoalRecord, now: string, token: string, observed: boolean): GoalStep {
  if (isClosed(record)) return step(record, [{ kind: 'ignore', reason: 'goal is closed' }]);
  if (record.status !== 'waiting' || record.wake === null) return step(record);
  if (record.wake.token !== token) return step(record);
  if (!conditionDue(record.wake.condition, record.wake.requestedAt, now, observed)) {
    return step(record, [silent('waiting')]);
  }
  const reason = describeWakeCondition(record.wake.condition);
  return step(record, [{ kind: 'wake-ready', token, reason, message: wakeMessage(reason) }]);
}

/**
 * Is the condition satisfied?
 *
 * `time` is the engine's own clock, so an early poll — a host that clamped a long delay, a machine
 * whose clock moved — cannot wake the goal ahead of the plan. A `requestedAt` that cannot be parsed is
 * "not due" rather than "due": the wait still has its liveness deadline, and a premature wake would
 * spend a turn on nothing.
 */
function conditionDue(
  condition: WakeCondition,
  requestedAt: string,
  now: string,
  observed: boolean,
): boolean {
  if (condition.kind !== 'time') return observed;
  const from = Date.parse(requestedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(from) || !Number.isFinite(at)) return false;
  return at >= from + condition.seconds * 1000;
}

function onWake(record: GoalRecord, now: string, token: string, reason: string): GoalStep {
  if (isClosed(record)) return step(record, [{ kind: 'ignore', reason: 'goal is closed' }]);

  if (record.status === 'waiting' && record.wake) {
    // Idempotent and lossy-safe: a duplicate token is a no-op, so a doubled delivery cannot
    // double-charge, and a missing one is covered by the deadline rather than stranding the goal.
    if (record.wake.token !== token) return step(record);
    // The consumed timer must be **cancelled**, not just marked handled: `onReconcile` re-arms from
    // `record.wake`, so a handled-but-still-armed wake produced a `schedule-wake` for a token the
    // engine no longer holds. That token then hit the `handled` guard and was dropped — a lost
    // notification by construction, which is exactly what this file's own comment forbids.
    return step(next(record, now, { status: 'running', wake: null, unreportedSettles: 0, pendingWakes: [] }), [
      { kind: 'clear-wake', token },
      { kind: 'nudge', reason: 'wake', message: wakeMessage(reason) },
    ]);
  }

  // Open question in the waiting decision: a wake during `blocked` re-raises rather than queueing
  // silently, because the human is the blocker and a finished job is news for them. It is recorded
  // either way, so nothing depends on that provisional choice.
  if (record.status === 'blocked') {
    return step(
      next(record, now, { pendingWakes: [...record.pendingWakes, { reason, at: now }] }),
      [{ kind: 'escalate', severity: 'needs-input', message: `Wake while blocked: ${reason}` }],
    );
  }

  // Already running: the wake added nothing. Reporting it as handled keeps the token from being
  // replayed later against a different wait.
  return step(record);
}

/**
 * A session starting: adopt it if the recorded holder is gone, then re-arm or escalate its wait.
 *
 * **The adoption is the part a restart needs.** A restarted pi is a *new session file*, so
 * `record.baton.sessionPath` names a session that no longer exists and `holdsBaton` refuses every event
 * from the newcomer — including this one. That path was measured on a real restart: a 10-minute wait
 * whose timer never fired, because the new process was told `not the baton holder` for every event and
 * therefore never armed anything. The goal was picked up only by hand.
 *
 * Adopting is not a loophole in the baton rule, because of who is allowed to take it:
 *
 * - **the same pane** (`paneId` matches) — the pane is the continuity, and the session file is the thing
 *   that changes across a restart. These two facts are what make the rule workable: pane ids survive a
 *   herdr server restart (measured), session files do not survive a pi restart.
 * - **the same session file** — nothing changed at all (a `session_start` in the same process).
 * - **no recorded holder** — nothing to displace.
 *
 * Anything else is a different pane, and is refused exactly as before: an intruder opening the same
 * project must not be able to adopt someone's goal. And a *closed* goal is never adopted.
 */
/**
 * Is `candidate` a child agent session running *inside* the pane that holds the baton?
 *
 * `samePane` adoption exists for one case: a killed pi comes back as a **new session file** on the same
 * pane, and refusing it left the latch armed with nobody to wake it. But `HERDR_PANE_ID` is an
 * **inherited environment variable**, so every child a holder spawns reports the holder's pane while
 * carrying its own `PI_SESSION_FILE`. Adopting on the pane alone therefore handed the baton to a
 * reviewer subagent 330 ms after it started — and because `wake`/`poll`/`report` all refuse an identified
 * non-holder, the holder's own `goal_report` was then refused by the goal it was driving. Measured on
 * this repository: six parallel review children, every one of them reporting `w13:pE`.
 *
 * The two cases are distinguishable by *where the file sits*, which no child can fake and no env var
 * reports:
 *
 * - a restart is a new session in the **same** directory — `…/<parentId>.jsonl`
 * - a child is nested **beneath** the holder — `…/<parentId>/<childId>/run-0/session.jsonl`
 *
 * So a nested path is never a restart. It keeps the same pane and is still the holder's own process
 * tree, so it is refused rather than treated as an intruder from another pane: the pane-level
 * `schedule-wake` it would receive is an effect only its parent can act on.
 *
 * Written without `node:path` on purpose: this module has no imports at all, which is a property worth
 * more than a `dirname` call. Session paths are absolute and `/`-separated by construction (pi writes
 * them), and `.`/`..` segments cannot appear in a path pi generated.
 */
function isNestedSession(holder: string, candidate: string): boolean {
  const cut = holder.lastIndexOf('/');
  if (cut <= 0) return false;
  const parent = holder.slice(0, cut);
  if (candidate === holder || !candidate.startsWith(parent + '/')) return false;
  // Deeper than a sibling file: the remainder must still hold a separator. `/a/one.jsonl` and
  // `/a/two.jsonl` are siblings (a restart); `/a/one.jsonl` and `/a/x/run-0/s.jsonl` are not.
  return candidate.slice(parent.length + 1).includes('/');
}

function onReconcile(
  record: GoalRecord,
  now: string,
  limits: GoalLimits,
  sessionPath?: string,
  paneId?: string,
): GoalStep {
  if (isClosed(record)) return step(record);

  // The restart case, before anything reads `record.baton`.
  let adopted = record;
  const holder = record.baton?.sessionPath;
  const sameHolder = sessionPath === undefined || holder === undefined || holder === sessionPath;
  const samePane =
    paneId !== undefined && record.baton?.paneId !== null && record.baton?.paneId === paneId;
  // A child agent of the holder shares its pane by inheritance but holds a *nested* session file. It
  // must not adopt; see `isNestedSession` for why the path, and not the pane, is the discriminator.
  const nested = holder !== undefined && sessionPath !== undefined && isNestedSession(holder, sessionPath);
  const adopts = record.baton === null || sameHolder || (samePane && !nested);
  if (record.baton !== null && sessionPath !== undefined && !sameHolder && samePane && !nested) {
    adopted = { ...record, baton: { sessionPath, paneId: paneId ?? record.baton.paneId, startedAt: now } };
  } else if (record.baton === null && sessionPath !== undefined) {
    // A goal created outside a session and driven for the first time: claim it, as `run-started` would.
    adopted = { ...record, baton: { sessionPath, paneId: paneId ?? null, startedAt: now } };
  }
  record = adopted;

  // An **identified intruder** gets nothing but a refusal. Before this, everything below ran on the
  // unadopted record: reconciling an *expired* wait flipped the goal `waiting → blocked` on behalf of a
  // session that does not hold it, and a *live* one handed the intruder a `schedule-wake` for a token
  // its own `wake`/`poll` would be refused — an effect no host could act on. A same-pane restart is not
  // an intruder; that is what `adopts` decides.
  if (!adopts && sessionPath !== undefined) {
    return step(record, [{ kind: 'ignore', reason: 'not the baton holder for this goal' }]);
  }

  // A `waiting` record with no wake at all: producible when the store drops a malformed condition
  // (`wake.condition = {kind:'time'}` with no `seconds`). Nothing can leave it — `onSettled` is silent,
  // `onPoll` has no token, and the branch below is skipped — so it has no deadline and no timer. Escalate
  // rather than sit quiet: a wait with no token is a wait with no clock.
  if (record.status === 'waiting' && record.wake === null) {
    return step(
      next(record, now, {
        status: 'blocked',
        blocker: { reason: 'the latched wait has no usable condition', repeats: 1, needs: 'human', raisedAt: now },
      }),
      [
        {
          kind: 'escalate',
          severity: 'needs-input',
          message: 'A wait is latched with no readable condition, so nothing can ever wake it. Re-report the wait.',
        },
        silent('blocked'),
      ],
    );
  }

  if (record.status === 'waiting' && record.wake) {
    const expired = isPast(now, record.wake.deadlineAt);
    if (expired) {
      return step(
        next(record, now, {
          status: 'blocked',
          wake: null,
          blocker: { reason: REASON_WAIT_EXPIRED, repeats: 1, needs: 'human', raisedAt: now },
        }),
        [
          // The dropped wake still has to cancel its timer. Every other path that clears `wake` says
          // so; this one set `wake: null` and left the host's timer armed for a token the record no
          // longer held — the same leak as the `blocked` branch of `onRunStarted`.
          ...(record.wake ? [{ kind: 'clear-wake' as const, token: record.wake.token }] : []),
          {
            kind: 'escalate',
            severity: 'stuck',
            message: `A wait latched at ${record.wake.requestedAt} never woke and passed its deadline.`,
          },
          silent('blocked'),
        ],
      );
    }
    // A restart must not swallow a live wait: re-arm it with the same *absolute* plan, so the
    // remaining time is the remainder rather than the full duration again.
    return step(record, [
      {
        kind: 'schedule-wake',
        token: record.wake.token,
        condition: record.wake.condition,
        fireAt: fireAtFor(record.wake.condition, record.wake.requestedAt),
        deadlineAt: record.wake.deadlineAt,
      },
    ]);
  }

  if (record.pendingHandoff) {
    // NaN made `waited >= livenessMs` false, so a hand-edited `requestedAt` silenced the stale-handoff
    // escalation forever. An unreadable request time is treated as stale, not as fresh.
    const waited = Date.parse(now) - Date.parse(record.pendingHandoff.requestedAt);
    if (!Number.isFinite(waited) || waited >= limits.livenessMs) {
      return step(record, [
        {
          kind: 'escalate',
          severity: 'needs-input',
          message: `${REASON_HANDOFF_STALE} (asked ${record.pendingHandoff.requestedAt}).`,
        },
      ]);
    }
  }
  return step(record);
}

function onClose(record: GoalRecord, now: string, reason: 'cancelled' | 'abandoned'): GoalStep {
  if (isClosed(record)) return step(record, [{ kind: 'ignore', reason: 'goal is already closed' }]);
  const effects: GoalEffect[] = [];
  if (record.wake) effects.push({ kind: 'clear-wake', token: record.wake.token });
  return step(
    next(record, now, {
      closedAt: now,
      closeReason: reason,
      wake: null,
      pendingHandoff: null,
      pendingVerdict: null,
      // `status` must agree with `closedAt`, or every reader that shows the status — `dump`'s GOAL
      // block, `goal list`, `/goal` — reports a cancelled goal as still `running`. The distinction
      // the design protects is that `done` *means a verdict was observed*, so a cancel cannot use it;
      // `blocked` is the honest label for "stopped, not finished", and `isClosed` stays the single
      // authority on "may this goal move again".
      status: 'blocked',
      blocker: record.blocker ?? {
        reason: reason === 'abandoned' ? 'abandoned' : 'cancelled',
        repeats: 1,
        needs: null,
        raisedAt: now,
      },
      unreportedSettles: 0,
      // Closure **hangs up the baton**. Without this the record still named a holder, so the holder's
      // own events were refused by `isClosed` while every other session was refused by the baton —
      // the goal became undrivable by everyone, and the only recovery was hand-editing `goal.json`.
      // A closed goal is read-only either way; clearing the baton makes that visible instead of
      // leaving a holder who cannot act.
      baton: null,
    }),
    effects,
  );
}

/** A fresh record for a newly created goal, with the baton already handed to its creator. */
export function newGoalRecord(input: {
  id: string;
  goal: string;
  now: string;
  baton?: Baton | null;
}): GoalRecord {
  return {
    version: 1,
    id: input.id,
    goal: input.goal,
    status: 'running',
    baton: input.baton ?? null,
    createdAt: input.now,
    updatedAt: input.now,
    closedAt: null,
    closeReason: null,
    rounds: 0,
    reports: 0,
    wake: null,
    wakeSeq: 0,
    lastDigest: null,
    unchangedRounds: 0,
    unreportedSettles: 0,
    blocker: null,
    lastNote: null,
    pendingVerdict: null,
    lastVerdict: null,
    pendingHandoff: null,
    pendingWakes: [],
  };
}
