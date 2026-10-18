import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_LIMITS,
  holdsBaton,
  isClosed,
  newGoalRecord,
  reduce,
  type DoneWhen,
  type GoalBrief,
  type GoalEffect,
  type GoalEvent,
  type GoalRecord,
  type GoalView,
} from '../src/core/goal.js';

/**
 * The goal state machine, in memory.
 *
 * These tests are the reason the engine is host-free: every branch below is a rule from the three
 * accepted long-running-agent decisions, and none of them needs a pi process, a timer or a clock to
 * be exercised.
 */

const T0 = '2026-10-18T10:00:00.000Z';
const hours = (h: number): string => new Date(Date.parse(T0) + h * 3_600_000).toISOString();

const CMD: DoneWhen = { kind: 'cmd', commands: ['npm test'] };
const brief = (doneWhen: DoneWhen | null = CMD, error: string | null = null): GoalBrief => ({ doneWhen, error });
const BATON = '/sessions/one.jsonl';

function record(over: Partial<GoalRecord> = {}): GoalRecord {
  return {
    ...newGoalRecord({ id: 'g', goal: 'ship it', now: T0, baton: { sessionPath: BATON, paneId: null, startedAt: T0 } }),
    ...over,
  };
}

function view(r: GoalRecord = record(), b: GoalBrief = brief()): GoalView {
  return { record: r, brief: b };
}

/**
 * Feed one event, returning the next view and the effects it produced.
 *
 * `sessionPath` is defaulted to the baton holder on purpose: after the baton rule was tightened, an
 * event carrying **no** identity on a goal that *has* a holder is refused. Every test here is about
 * the transition, not about identity, so the helper identifies as the holder — the refusal itself has
 * its own case below.
 */
function send(v: GoalView, event: GoalEvent, limits = DEFAULT_LIMITS): { view: GoalView; effects: GoalEffect[] } {
  const identified =
    event.kind === 'run-started' || event.kind === 'settled' || event.kind === 'report'
      ? { ...event, sessionPath: event.sessionPath ?? v.record.baton?.sessionPath ?? BATON }
      : event;
  const step = reduce(v, identified, limits);
  return { view: { record: step.record, brief: v.brief }, effects: step.effects };
}

/** Feed an event with **no** session identity, to exercise the baton refusal. */
function sendAnonymous(v: GoalView, event: GoalEvent): { view: GoalView; effects: GoalEffect[] } {
  const step = reduce(v, event);
  return { view: { record: step.record, brief: v.brief }, effects: step.effects };
}

/** Feed a sequence, keeping the view and returning the *last* step's effects. */
function sendAll(v: GoalView, events: GoalEvent[]): { view: GoalView; effects: GoalEffect[] } {
  let cur = v;
  let effects: GoalEffect[] = [];
  for (const e of events) {
    const r = send(cur, e);
    cur = r.view;
    effects = r.effects;
  }
  return { view: cur, effects };
}

const kinds = (effects: GoalEffect[]): string[] => effects.map((e) => e.kind);
const nudgeReason = (effects: GoalEffect[]): string | undefined =>
  effects.find((e) => e.kind === 'nudge')?.kind === 'nudge'
    ? (effects.find((e) => e.kind === 'nudge') as Extract<GoalEffect, { kind: 'nudge' }>).reason
    : undefined;

test('an unclassified goal is nudged to classify and consumes no rounds', () => {
  const r = send(view(record(), brief(null)), {
    kind: 'report',
    now: T0,
    report: { status: 'progress', note: 'started' },
  });
  assert.equal(nudgeReason(r.effects), 'classify');
  assert.equal(r.view.record.rounds, 0, 'an unverifiable goal may not spend rounds');
  assert.equal(r.view.record.reports, 1);
  assert.equal(r.view.record.status, 'running');
});

test('a done claim without a done_when is refused, not accepted', () => {
  const r = send(view(record(), brief(null)), { kind: 'report', now: T0, report: { status: 'done', claim: 'finished' } });
  assert.equal(nudgeReason(r.effects), 'classify');
  assert.equal(r.view.record.pendingVerdict, null, 'no evaluation may be requested without a shape');
  assert.equal(r.view.record.status, 'running');
});

test('K settlements without any report stop the loop instead of nudging forever', () => {
  // Measured before this guard existed: 50 settlements → 50 nudges, 0 rounds, status still running.
  // Neither stuck detector could see it, because both are driven by reports that never arrived.
  let v = view();
  let escalated = false;
  for (let i = 0; i < DEFAULT_LIMITS.silentSettles + 3; i++) {
    const r = send(v, { kind: 'settled', now: hours(i) });
    v = r.view;
    if (r.effects.some((e) => e.kind === 'escalate')) {
      escalated = true;
      assert.equal(v.record.status, 'blocked');
      assert.match(v.record.blocker?.reason ?? '', /no goal_report/);
      // Once blocked, it must go quiet rather than keep escalating every turn.
      assert.deepEqual(send(v, { kind: 'settled', now: hours(i + 1) }).effects, [{ kind: 'silent', reason: 'blocked' }]);
      break;
    }
  }
  assert.equal(escalated, true, 'a silent loop must have a floor');
});

test('a human answering a stuck goal gives the agent a full turn before escalating again', () => {
  // The silent-settle counter must reset on a new run, or answering a stuck goal is pointless: the
  // agent's very first settled turn escalated again with no chance to report. Measured before the
  // fix: blocked at 8, one human run, blocked again at 9.
  let v = view();
  for (let i = 0; i < DEFAULT_LIMITS.silentSettles + 2 && v.record.status === 'running'; i++) {
    v = send(v, { kind: 'settled', now: hours(i) }).view;
  }
  assert.equal(v.record.status, 'blocked');

  v = send(v, { kind: 'run-started', now: hours(20) }).view;
  assert.equal(v.record.status, 'running');
  assert.equal(v.record.unreportedSettles, 0, 'a new run starts a fresh streak');

  const first = send(v, { kind: 'settled', now: hours(21) });
  assert.equal(first.view.record.status, 'running', 'one turn must not re-escalate');
  assert.ok(!first.effects.some((e) => e.kind === 'escalate'));
});

test('one report resets the silent-settle streak', () => {
  let v = view();
  for (let i = 0; i < DEFAULT_LIMITS.silentSettles - 1; i++) {
    v = send(v, { kind: 'settled', now: hours(i) }).view;
  }
  assert.equal(v.record.unreportedSettles, DEFAULT_LIMITS.silentSettles - 1);
  v = send(v, { kind: 'report', now: hours(9), report: { status: 'progress' } }).view;
  assert.equal(v.record.unreportedSettles, 0);
  assert.equal(v.record.status, 'running');
});

test('a classified progress report counts a round and continues', () => {
  const r = send(view(), { kind: 'report', now: T0, report: { status: 'progress', note: 'step 1' } });
  assert.equal(r.view.record.rounds, 1);
  assert.equal(r.view.record.lastNote, 'step 1');
  assert.equal(nudgeReason(r.effects), 'continue');
});

test('a reported progress gets its own continuation text, not the "no report" one', () => {
  const step = send(view(), { kind: 'report', now: T0, report: { status: 'progress' } });
  const nudge = step.effects.find((e) => e.kind === 'nudge') as Extract<GoalEffect, { kind: 'nudge' }>;
  assert.doesNotMatch(nudge.message, /No goal_report was filed/);
  assert.match(nudge.message, /Progress recorded/);
});

test('a settled run continues, except while a question is in flight', () => {
  assert.equal(nudgeReason(send(view(), { kind: 'settled', now: T0 }).effects), 'continue');

  const waiting = record({ status: 'waiting', wake: { token: 'wake-1', condition: { kind: 'process', pid: 1 }, requestedAt: T0, deadlineAt: hours(24), handled: false } });
  assert.deepEqual(send(view(waiting), { kind: 'settled', now: T0 }).effects, [{ kind: 'silent', reason: 'waiting' }]);

  const blocked = record({ status: 'blocked', blocker: { reason: 'x', repeats: 1, needs: null, raisedAt: T0 } });
  assert.deepEqual(send(view(blocked), { kind: 'settled', now: T0 }).effects, [{ kind: 'silent', reason: 'blocked' }]);

  // A pending verdict is the one in-flight question that must not go quiet: nothing else resolves
  // it, and `silent` there was a permanent mute with the goal still running. It re-asks instead.
  const pending = record({ pendingVerdict: { claimedAt: T0, claim: null } });
  assert.deepEqual(send(view(pending), { kind: 'settled', now: T0 }).effects, [{ kind: 'evaluate', doneWhen: CMD }]);

  // With no done_when there is nothing to evaluate, so the settle falls through to a normal nudge.
  const pendingUnclassified = record({ pendingVerdict: { claimedAt: T0, claim: null } });
  assert.equal(nudgeReason(send(view(pendingUnclassified, brief(null)), { kind: 'settled', now: T0 }).effects), 'continue');

  const handoff = record({ pendingHandoff: { requestedAt: T0, reason: null } });
  assert.deepEqual(send(view(handoff), { kind: 'settled', now: T0 }).effects, [{ kind: 'silent', reason: 'handoff-requested' }]);
});

test('a wait latches, arms a token and mutes the loop', () => {
  const r = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 4242 } } });
  assert.equal(r.view.record.status, 'waiting');
  assert.equal(r.view.record.wake?.token, 'wake-1');
  assert.equal(r.view.record.wake?.deadlineAt, hours(24), 'default liveness is 24h');
  assert.deepEqual(kinds(r.effects), ['schedule-wake', 'silent']);
  assert.deepEqual(send(r.view, { kind: 'settled', now: T0 }).effects, [{ kind: 'silent', reason: 'waiting' }]);
});

test('a time wait longer than the default liveness is not escalated at hour 24', () => {
  const r = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'time', seconds: 30 * 3600 } } });
  // 30h plus a minute of grace, so the planned timer fires before the deadline does.
  assert.equal(r.view.record.wake?.deadlineAt, new Date(Date.parse(hours(30)) + 60_000).toISOString());
});

test('any new run releases the wait latch and cancels its timer', () => {
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 1 } } }).view;
  const r = send(armed, { kind: 'run-started', now: hours(1) });
  assert.equal(r.view.record.status, 'running');
  assert.equal(r.view.record.wake, null);
  assert.deepEqual(r.effects, [{ kind: 'clear-wake', token: 'wake-1' }]);
  assert.equal(nudgeReason(send(r.view, { kind: 'settled', now: hours(1) }).effects), 'continue', 'normal nudging resumes');
});

test('a matching wake cancels its timer, releases the latch and asks for a judgment', () => {
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 1 } } }).view;
  const r = send(armed, { kind: 'wake', now: hours(2), token: 'wake-1', reason: 'pid 1 exited' });
  assert.equal(r.view.record.status, 'running');
  assert.equal(r.view.record.wake, null, 'a consumed wait is cleared, not left handled');
  // The timer must be cancelled: `reconcile` re-arms from `record.wake`, so a handled-but-armed wake
  // produced a schedule for a token the engine no longer holds, and the arrival was dropped.
  assert.deepEqual(kinds(r.effects), ['clear-wake', 'nudge']);
  assert.equal(nudgeReason(r.effects), 'wake');
  const message = (r.effects.find((e) => e.kind === 'nudge') as Extract<GoalEffect, { kind: 'nudge' }>).message;
  assert.match(message, /not success/i, 'a process exiting is not the same as the gate passing');
});

test('a duplicated or mismatched wake is a no-op', () => {
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 1 } } }).view;
  const first = send(armed, { kind: 'wake', now: hours(1), token: 'wake-1', reason: 'exit' });
  assert.deepEqual(send(first.view, { kind: 'wake', now: hours(1), token: 'wake-1', reason: 'exit' }).effects, []);
  assert.deepEqual(send(armed, { kind: 'wake', now: hours(1), token: 'wake-9', reason: 'stale' }).effects, []);
  assert.equal(send(armed, { kind: 'wake', now: hours(1), token: 'wake-9', reason: 'stale' }).view.record.status, 'waiting');
});

test('a wake arriving while blocked re-raises and is recorded, not lost', () => {
  const blocked = record({ status: 'blocked', blocker: { reason: 'need a decision', repeats: 1, needs: null, raisedAt: T0 } });
  const r = send(view(blocked), { kind: 'wake', now: hours(1), token: 'wake-1', reason: 'training finished' });
  assert.equal(r.view.record.status, 'blocked');
  assert.equal(r.view.record.pendingWakes.length, 1);
  assert.equal(r.effects[0]?.kind, 'escalate');
});

test('the same blocked reason escalates to stuck on the third repeat', () => {
  const first = send(view(), { kind: 'report', now: T0, report: { status: 'blocked', reason: 'no credentials' } });
  assert.equal(first.effects[0]?.kind === 'escalate' && first.effects[0].severity, 'needs-input');
  const second = send(first.view, { kind: 'report', now: hours(1), report: { status: 'blocked', reason: 'no credentials' } });
  assert.equal(second.effects[0]?.kind === 'escalate' && second.effects[0].severity, 'needs-input');
  const third = send(second.view, { kind: 'report', now: hours(2), report: { status: 'blocked', reason: 'no credentials' } });
  assert.equal(third.effects[0]?.kind === 'escalate' && third.effects[0].severity, 'stuck');
  assert.equal(third.view.record.blocker?.repeats, 3);
});

test('a different blocked reason restarts the repeat count', () => {
  const a = send(view(), { kind: 'report', now: T0, report: { status: 'blocked', reason: 'a' } });
  const b = send(a.view, { kind: 'report', now: hours(1), report: { status: 'blocked', reason: 'b' } });
  assert.equal(b.view.record.blocker?.repeats, 1);
});

test('a done claim requests an evaluation instead of closing the goal', () => {
  const r = send(view(), { kind: 'report', now: T0, report: { status: 'done', claim: 'all green' } });
  assert.deepEqual(r.effects, [{ kind: 'evaluate', doneWhen: CMD }]);
  assert.equal(r.view.record.status, 'running', 'the claim alone never closes the goal');
  assert.equal(r.view.record.pendingVerdict?.claim, 'all green');
});

test('a passed verdict is the only thing that closes the goal', () => {
  const claimed = send(view(), { kind: 'report', now: T0, report: { status: 'done' } }).view;
  const r = send(claimed, { kind: 'verdict', now: hours(1), passed: true, detail: 'npm test exited 0' });
  assert.equal(r.view.record.status, 'done');
  assert.equal(r.view.record.closeReason, 'completed');
  assert.equal(r.view.record.closedAt, hours(1));
  assert.equal(isClosed(r.view.record), true);
  assert.deepEqual(kinds(r.effects), ['done-observed']);
  assert.deepEqual(send(r.view, { kind: 'settled', now: hours(2) }).effects, [{ kind: 'silent', reason: 'done' }]);
});

test('a failed verdict keeps working and says why', () => {
  const claimed = send(view(), { kind: 'report', now: T0, report: { status: 'done' } }).view;
  const r = send(claimed, { kind: 'verdict', now: hours(1), passed: false, detail: '3 tests failed' });
  assert.equal(r.view.record.status, 'running');
  assert.equal(nudgeReason(r.effects), 'verdict-failed');
  assert.match((r.effects[0] as Extract<GoalEffect, { kind: 'nudge' }>).message, /3 tests failed/);
});

test('K rounds without a file change block the goal instead of looping', () => {
  let v = view();
  let blocked = false;
  for (let i = 0; i < DEFAULT_LIMITS.stuckRounds + 2 && !blocked; i++) {
    const r = send(v, { kind: 'report', now: hours(i), report: { status: 'progress' }, digest: 'same-digest' });
    v = r.view;
    if (v.record.status === 'blocked') {
      blocked = true;
      assert.equal(r.effects[0]?.kind === 'escalate' && r.effects[0].severity, 'stuck');
    }
  }
  assert.equal(blocked, true, 'the no-change detector must fire');
  assert.match(v.record.blocker?.reason ?? '', /no file change/);
});

test('a digest the host cannot see is not counted as unchanged', () => {
  let v = view();
  for (let i = 0; i < DEFAULT_LIMITS.stuckRounds + 3; i++) {
    v = send(v, { kind: 'report', now: hours(i), report: { status: 'progress' }, digest: null }).view;
  }
  assert.equal(v.record.status, 'running', 'null must not be read as "nothing changed"');
});

test('reconcile re-arms a live wait and escalates an expired one', () => {
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'artifact', path: 'out/metric.json' } } }).view;
  const live = send(armed, { kind: 'reconcile', now: hours(2) });
  assert.deepEqual(kinds(live.effects), ['schedule-wake'], 'a restart must not swallow the wait');
  assert.equal(live.view.record.status, 'waiting');

  const dead = send(armed, { kind: 'reconcile', now: hours(25) });
  assert.equal(dead.view.record.status, 'blocked');
  // The timer is cancelled *before* the escalation: an expired wait that only escalates leaves the
  // host armed for a token the record has already dropped.
  assert.deepEqual(kinds(dead.effects), ['clear-wake', 'escalate', 'silent']);
  assert.equal(dead.effects[1]?.kind === 'escalate' && dead.effects[1].severity, 'stuck');
});

test('a second wait cancels the first timer', () => {
  const first = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 1 } } }).view;
  const second = send(first, { kind: 'report', now: hours(1), report: { status: 'wait', wakeOn: { kind: 'process', pid: 2 } } });
  assert.deepEqual(second.effects[0], { kind: 'clear-wake', token: 'wake-1' });
  assert.equal(second.view.record.wake?.token, 'wake-2');
});

test('a wait publishes an absolute plan, and a restart keeps the remainder', () => {
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'time', seconds: 3600 } } });
  const scheduled = armed.effects[0];
  assert.equal(scheduled?.kind, 'schedule-wake');
  assert.equal(
    scheduled?.kind === 'schedule-wake' ? scheduled.fireAt : null,
    hours(1),
    'a time wait names the instant its condition comes true, which is not its deadline',
  );
  assert.equal(armed.view.record.wake?.deadlineAt, hours(24), 'the deadline is still the liveness bound');

  // Two hours later the wait is re-armed — and the plan is the *same* instant, now in the past, so the
  // host asks immediately instead of waiting a second full hour. A fire time computed from the new
  // `now` would turn a 6-hour wait that survived a restart into twelve.
  const live = send(armed.view, { kind: 'reconcile', now: hours(2) });
  const rearmed = live.effects[0];
  assert.equal(rearmed?.kind === 'schedule-wake' ? rearmed.fireAt : null, hours(1));

  // A process or an artifact has no plan to publish: the host polls, so there is nothing to name.
  const observed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'artifact', path: 'out/x.json' } } });
  const effect = observed.effects[0];
  assert.equal(effect?.kind === 'schedule-wake' ? effect.fireAt : 'missing', null);
});

test('a report that releases a wait cancels its timer', () => {
  // `onProgress` was the one branch that set `wake: null` without emitting `clear-wake`, so the host's
  // timer stayed armed for a token the record no longer held.
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 1 } } }).view;
  const r = send(armed, { kind: 'report', now: hours(1), report: { status: 'progress' } });
  assert.equal(r.view.record.wake, null);
  assert.deepEqual(kinds(r.effects), ['clear-wake', 'nudge']);

  // The unclassified path releases the same latch and must cancel it too.
  const bare = send(view(record(), brief(null)), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'time', seconds: 60 } } }).view;
  const classified = send(bare, { kind: 'report', now: hours(1), report: { status: 'progress' } });
  assert.deepEqual(kinds(classified.effects), ['clear-wake', 'nudge']);
  assert.equal(nudgeReason(classified.effects), 'classify');
});

test('a poll is a question the engine answers, not a claim it accepts', () => {
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'time', seconds: 3600 } } }).view;

  // Early: the host asked, the engine's own clock says not yet, and the answer says "still waiting" —
  // which is what tells the host to ask again. The record does not move.
  const early = send(armed, { kind: 'poll', now: hours(0.5), token: 'wake-1', observed: false });
  assert.deepEqual(early.effects, [{ kind: 'silent', reason: 'waiting' }]);
  assert.equal(early.view.record.status, 'waiting');

  // Due: the answer carries the message to deliver — and **nothing has moved**. A question must not
  // consume its own answer: if the host cannot deliver the message (a stale runtime), it has consumed
  // nothing and the wait is still there for the next reconcile or retry to wake.
  const due = send(armed, { kind: 'poll', now: hours(1), token: 'wake-1', observed: false });
  assert.equal(due.view.record.status, 'waiting', 'a peek is not a wake');
  assert.equal(due.view.record.wake?.token, 'wake-1', 'and the token is still latched');
  assert.deepEqual(kinds(due.effects), ['wake-ready']);
  const ready = due.effects[0] as Extract<GoalEffect, { kind: 'wake-ready' }>;
  assert.equal(ready.token, 'wake-1');
  assert.equal(ready.reason, '3600s elapsed');
  assert.match(ready.message, /3600s elapsed/);

  // The claim is what releases it, and it is a separate call.
  const claimed = send(due.view, { kind: 'wake', now: hours(1), token: 'wake-1', reason: ready.reason });
  assert.equal(claimed.view.record.status, 'running');
  assert.equal(claimed.view.record.wake, null);
  assert.deepEqual(kinds(claimed.effects), ['clear-wake', 'nudge']);
  assert.equal(
    (claimed.effects[1] as Extract<GoalEffect, { kind: 'nudge' }>).message,
    ready.message,
    'one builder for both sides of the delivery, or a model reads whichever path ran',
  );

  // A peek for a wait the engine has already released answers nothing to deliver.
  assert.deepEqual(send(claimed.view, { kind: 'poll', now: hours(2), token: 'wake-1', observed: false }).effects, []);
});

test('an observed condition wakes on what the CLI saw, and a stale token stays silent', () => {
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 4242 } } }).view;
  assert.deepEqual(
    kinds(send(armed, { kind: 'poll', now: hours(1), token: 'wake-1', observed: false }).effects),
    ['silent'],
    'a pid that is still there is not a wake',
  );
  const gone = send(armed, { kind: 'poll', now: hours(1), token: 'wake-1', observed: true });
  assert.deepEqual(kinds(gone.effects), ['wake-ready']);
  assert.match((gone.effects[0] as Extract<GoalEffect, { kind: 'wake-ready' }>).message, /pid 4242 exited/);

  const artifact = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'artifact', path: 'out/x.json' } } }).view;
  const appeared = send(artifact, { kind: 'poll', now: hours(1), token: 'wake-1', observed: true });
  assert.match((appeared.effects[0] as Extract<GoalEffect, { kind: 'wake-ready' }>).message, /out\/x\.json appeared/);

  // A poll for a token the goal no longer holds is empty, not "still waiting": the host must stop
  // asking rather than poll a released wait forever.
  assert.deepEqual(send(armed, { kind: 'poll', now: hours(1), token: 'wake-9', observed: true }).effects, []);
  assert.equal(send(armed, { kind: 'poll', now: hours(1), token: 'wake-9', observed: true }).view.record.status, 'waiting');
});

test('a timer that survived a handoff cannot consume the wake the successor is watching', () => {
  // The predecessor's timer is still armed in a pane that handed the baton away. If its poll were
  // accepted, it would consume the token, release the latch, and leave a `running` goal with nobody
  // driving it — the successor would never be nudged and `waiting` is the only state with a deadline.
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 1 } } }).view;
  const stale = reduce(armed, { kind: 'poll', now: hours(1), token: 'wake-1', observed: true, sessionPath: '/sessions/two.jsonl' });
  assert.equal(stale.effects[0]?.kind, 'ignore');
  assert.equal(stale.record.status, 'waiting', 'the wait is untouched');

  const staleWake = reduce(armed, { kind: 'wake', now: hours(1), token: 'wake-1', reason: 'x', sessionPath: '/sessions/two.jsonl' });
  assert.equal(staleWake.effects[0]?.kind, 'ignore');

  // Second, an *unidentified* emitter is legitimate: a systemd unit's ExecStopPost, herdr's delivery
  // and a human typing `goal wake` all arrive without a session, and refusing them would delete L3 and
  // the escape hatch together.
  const stranger = reduce(armed, { kind: 'wake', now: hours(1), token: 'wake-1', reason: 'unit exited' });
  assert.equal(stranger.effects[0]?.kind, 'clear-wake');
  assert.equal(stranger.record.status, 'running');
});

test('only the baton holder may drive the goal', () => {
  const v = view();
  assert.equal(holdsBaton(v.record, BATON), true);
  assert.equal(holdsBaton(v.record, '/sessions/two.jsonl'), false);

  const r = send(v, { kind: 'report', now: T0, report: { status: 'progress' }, sessionPath: '/sessions/two.jsonl' });
  assert.equal(r.effects[0]?.kind, 'ignore');
  assert.equal(r.view.record.rounds, 0);

  const holder = send(v, { kind: 'report', now: T0, report: { status: 'progress' }, sessionPath: BATON });
  assert.equal(holder.view.record.rounds, 1);
});

test('a human answering a blocked goal resumes it, and the counters survive', () => {
  const blocked = record({ status: 'blocked', blocker: { reason: 'no credentials', repeats: 2, needs: null, raisedAt: T0 } });
  const r = send(view(blocked), { kind: 'run-started', now: hours(1) });
  assert.equal(r.view.record.status, 'running');
  assert.equal(r.view.record.blocker?.repeats, 2, 'a repeat after the answer is still the same loop');
});

test('a progress report clears the blocker and counts forward motion', () => {
  const blocked = record({ status: 'blocked', blocker: { reason: 'no credentials', repeats: 2, needs: null, raisedAt: T0 } });
  const r = send(view(blocked), { kind: 'report', now: hours(1), report: { status: 'progress' } });
  assert.equal(r.view.record.blocker, null);
  assert.equal(r.view.record.status, 'running');
});

test('closing a goal cancels its timer and ignores later events', () => {
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 1 } } }).view;
  const closed = send(armed, { kind: 'close', now: hours(1), reason: 'cancelled' });
  assert.equal(closed.view.record.closedAt, hours(1));
  assert.equal(closed.view.record.closeReason, 'cancelled');
  assert.deepEqual(closed.effects, [{ kind: 'clear-wake', token: 'wake-1' }]);
  assert.equal(send(closed.view, { kind: 'report', now: hours(2), report: { status: 'progress' } }).effects[0]?.kind, 'ignore');
});

test('a closed goal never reports a live status', () => {
  // `status` and `closedAt` are two fields that must agree. Leaving `status: running` on a cancelled
  // goal made `dump`'s GOAL block, `goal list` and `/goal` all present it as still running.
  for (const reason of ['cancelled', 'abandoned'] as const) {
    const closed = send(view(), { kind: 'close', now: hours(1), reason });
    assert.notEqual(closed.view.record.status, 'running', `${reason} must not leave status=running`);
    assert.equal(closed.view.record.status, 'blocked', 'stopped-and-not-finished is blocked, never done');
    assert.equal(isClosed(closed.view.record), true, 'isClosed stays the authority on movement');
  }
  // `done` keeps meaning exactly one thing: an observed verdict.
  const claimed = send(view(), { kind: 'report', now: T0, report: { status: 'done' } }).view;
  const passed = send(claimed, { kind: 'verdict', now: hours(1), passed: true, detail: 'ok' });
  assert.equal(passed.view.record.status, 'done');
  assert.equal(passed.view.record.closeReason, 'completed');
});

test('a handoff request does not close the turn by itself', () => {
  const r = send(view(), { kind: 'report', now: T0, report: { status: 'handoff', reason: 'clean point' } });
  assert.deepEqual(kinds(r.effects), ['handoff']);
  assert.equal(r.view.record.pendingHandoff?.reason, 'clean point');
  assert.equal(r.view.record.status, 'running');
});

// --- cases the review named as uncovered: each one deletes a rule if it is removed -------------

test('a failed verdict with an unchanged digest blocks instead of looping', () => {
  // "claim done → gate fails → claim done" is a loop the blocked-repeat detector cannot see, because
  // the reason is identical only if you count verdicts, not blocks. Deleting the branch in onVerdict
  // left the suite green, so the rule was prose.
  let v = view();
  let blocked = false;
  for (let i = 0; i < DEFAULT_LIMITS.stuckRounds + 1 && !blocked; i++) {
    const r = send(v, { kind: 'verdict', now: hours(i), passed: false, detail: 'gate failed', digest: 'same' });
    v = r.view;
    if (v.record.status === 'blocked') {
      blocked = true;
      assert.equal(r.effects[0]?.kind === 'escalate' && r.effects[0].severity, 'stuck');
      assert.match(v.record.blocker?.reason ?? '', /no file change/);
    }
  }
  assert.equal(blocked, true, 'repeated failed verdicts must be bounded');
});

test('an unanswered done claim escalates instead of re-evaluating forever', () => {
  const claimed = send(view(), { kind: 'report', now: T0, report: { status: 'done' } }).view;
  // Inside the deadline it re-asks: nothing else resolves a pending verdict.
  assert.equal(send(claimed, { kind: 'settled', now: hours(1) }).effects[0]?.kind, 'evaluate');
  // Past it, the claim is stale and a human is told. Without the bound this re-emitted `evaluate` on
  // every settlement forever, and `unreportedSettles` never incremented on this path.
  const stale = send(claimed, { kind: 'settled', now: hours(25) });
  assert.equal(stale.view.record.status, 'blocked');
  assert.equal(stale.view.record.pendingVerdict, null);
  assert.equal(stale.effects[0]?.kind, 'escalate');
});

test('a wake that was already consumed is not re-armed by reconcile', () => {
  const armed = send(view(), { kind: 'report', now: T0, report: { status: 'wait', wakeOn: { kind: 'process', pid: 1 } } }).view;
  const woken = send(armed, { kind: 'wake', now: hours(1), token: 'wake-1', reason: 'exit' }).view;
  assert.equal(woken.record.wake, null, "a consumed wake is cleared");
  // Reconcile with no wake must do nothing — re-arming a handled token scheduled a wake the engine
  // could no longer match, and the arrival was dropped.
  assert.deepEqual(send(woken, { kind: 'reconcile', now: hours(2) }).effects, []);
});

test('a stale handoff request escalates on reconcile', () => {
  const pending = record({ pendingHandoff: { requestedAt: T0, reason: 'clean point' } });
  const r = send(view(pending), { kind: 'reconcile', now: hours(25) });
  assert.equal(r.effects[0]?.kind, 'escalate');
  assert.equal(r.effects[0]?.kind === 'escalate' && r.effects[0].severity, 'needs-input');
  assert.match((r.effects[0] as Extract<GoalEffect, { kind: 'escalate' }>).message, /never taken/);
});

test('an unidentified session cannot drive a goal that has a holder', () => {
  const v = view();
  const r = sendAnonymous(v, { kind: 'report', now: T0, report: { status: 'progress' } });
  assert.equal(r.effects[0]?.kind, 'ignore');
  assert.match(r.effects[0]?.kind === 'ignore' ? r.effects[0].reason : '', /no session identity/);
  assert.equal(r.view.record.rounds, 0, 'and it must not count a round');
  // A goal with no holder yet accepts anyone — that is how a fresh goal is claimed.
  const fresh = record({ baton: null });
  assert.equal(sendAnonymous(view(fresh), { kind: 'report', now: T0, report: { status: 'progress' } }).view.record.rounds, 1);
});

test('a missing digest preserves the no-change counter instead of resetting it', () => {
  // A model that alternates real reports with `digest: null` used to hold the counter at 0 forever.
  let v = send(view(), { kind: 'report', now: T0, report: { status: 'progress' }, digest: 'd' }).view;
  for (let i = 0; i < 3; i++) v = send(v, { kind: 'report', now: hours(i + 1), report: { status: 'progress' }, digest: 'd' }).view;
  const before = v.record.unchangedRounds;
  assert.ok(before > 0);
  v = send(v, { kind: 'report', now: hours(9), report: { status: 'progress' }, digest: null }).view;
  assert.equal(v.record.unchangedRounds, before, 'a null digest is neither progress nor repetition');
});

test('closing a goal hangs up the baton', () => {
  const closed = send(view(), { kind: 'close', now: hours(1), reason: 'cancelled' });
  assert.equal(closed.view.record.baton, null, 'a closed goal must not name a holder who cannot act');
});

test('an unparseable timestamp does not throw', () => {
  // `reduce` is documented as total and `now` is caller-supplied; `.toISOString()` on Invalid Date
  // used to throw RangeError from inside a lifecycle hook.
  const r = send(view(), { kind: 'report', now: 'not-a-date', report: { status: 'wait', wakeOn: { kind: 'process', pid: 1 } } });
  assert.equal(r.view.record.status, 'waiting');
  assert.equal(r.view.record.wake?.deadlineAt, 'not-a-date', 'the caller string is kept rather than crashing');
});
