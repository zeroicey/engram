/**
 * The host port: the contract between a pi extension and `engram goal`.
 *
 * The engine is a pure reducer in `core/goal.ts`, and the extension that drives it lives in the
 * user's repository at `.pi/extensions/engram-goal.ts`. That file **cannot import engram's
 * `build/`**: it runs under pi's own loader, in the user's tree, with no guaranteed resolution to
 * our compiled output. Two ways to bridge that gap, and only one of them survives contact:
 *
 * - **Compile a copy of the engine into the generated file.** Rejected: it is a fork. Every rule
 *   would exist twice, and the day they disagree the extension silently wins because it is the one
 *   the model talks to.
 * - **Make the extension a marshaller and let the installed `engram` do the thinking.** Chosen. The
 *   generated file maps a pi event to one CLI call and one JSON response; every rule stays in
 *   `core/goal.ts`, tested once.
 *
 * So this module is the *inbound* wire format: the shape a host sends, validated with messages that
 * teach the model the right usage in one turn instead of reporting a schema failure it will guess
 * around.
 */

import type { GoalEffect, GoalRecord, GoalReport, WakeCondition } from './goal.js';

// ---------------------------------------------------------------- goal_report arguments

/**
 * The model's tool call, before it becomes a `GoalReport`.
 *
 * A flat, stringly shape on purpose: it is what a tool schema can express without nested unions, and
 * what survives a round trip through `JSON.stringify` in a subprocess invocation.
 */
export interface ReportArgs {
  status: string;
  note?: string;
  wakeOnType?: string;
  wakeOnSeconds?: number;
  wakeOnPid?: number;
  wakeOnPath?: string;
  reason?: string;
  needs?: string;
  claim?: string;
}

export interface ParsedReport {
  report: GoalReport | null;
  /** Set when the arguments cannot become a report; the message is shown to the model verbatim. */
  error: string | null;
}

const WAKE_TYPES = new Set(['time', 'process', 'artifact']);

export function parseReportArgs(args: ReportArgs): ParsedReport {
  const status = (args.status ?? '').trim();
  const note = args.note?.trim() || undefined;
  const notePart = note ? { note } : {};

  switch (status) {
    case 'progress':
      return { report: { status: 'progress', ...notePart }, error: null };

    case 'wait': {
      const kind = (args.wakeOnType ?? '').trim();
      if (!WAKE_TYPES.has(kind)) {
        return {
          report: null,
          error:
            'goal_report(status="wait") needs wakeOnType: "time" (+ wakeOnSeconds) | "process" (+ wakeOnPid) | "artifact" (+ wakeOnPath). ' +
            'Waiting on a human is status="blocked", not "wait".',
        };
      }
      let wakeOn: WakeCondition;
      if (kind === 'time') {
        const seconds = args.wakeOnSeconds;
        if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
          return { report: null, error: 'wakeOnType="time" needs wakeOnSeconds as a positive number.' };
        }
        wakeOn = { kind: 'time', seconds };
      } else if (kind === 'process') {
        const pid = args.wakeOnPid;
        if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
          return { report: null, error: 'wakeOnType="process" needs wakeOnPid as an integer pid.' };
        }
        wakeOn = { kind: 'process', pid };
      } else {
        const path = args.wakeOnPath?.trim();
        if (!path) return { report: null, error: 'wakeOnType="artifact" needs wakeOnPath.' };
        wakeOn = { kind: 'artifact', path };
      }
      return { report: { status: 'wait', wakeOn, ...notePart }, error: null };
    }

    case 'blocked': {
      const reason = args.reason?.trim();
      if (!reason) return { report: null, error: 'goal_report(status="blocked") needs reason: what is stopping you.' };
      const needs = args.needs?.trim();
      return { report: { status: 'blocked', reason, ...(needs ? { needs } : {}) }, error: null };
    }

    case 'done': {
      const claim = args.claim?.trim();
      return { report: { status: 'done', ...(claim ? { claim } : {}) }, error: null };
    }

    case 'handoff': {
      const reason = args.reason?.trim();
      return { report: { status: 'handoff', ...(reason ? { reason } : {}) }, error: null };
    }

    default:
      return {
        report: null,
        error:
          'goal_report needs status: "progress" | "wait" | "blocked" | "done" | "handoff". ' +
          'Use "blocked" when a human decision is required; "wait" only for something that ends on its own.',
      };
  }
}

// ---------------------------------------------------------------- the response

/**
 * What `engram goal report --json` prints, and the only thing the extension may branch on.
 *
 * Deliberately tiny. `continue` is pi's `canContinue` decision; `message` is the exact text to append;
 * `notify` is what a human should see. The extension is not allowed to interpret `status` — it is
 * there for `/goal` display and for logs.
 */
export interface GoalResponse {
  ok: boolean;
  /** False when there is no active goal, the event was ignored, or the call was invalid. */
  continue: boolean;
  message: string | null;
  /** Shown to the human through pi's notification path, when non-null. */
  notify: string | null;
  status: GoalRecord['status'] | null;
  goalId: string | null;
  /** Why `continue` is false, or why the call failed. Never shown to the model unless it is an error. */
  reason: string | null;
  effects: GoalEffect[];
}

export const idleResponse = (reason: string): GoalResponse => ({
  ok: true,
  continue: false,
  message: null,
  notify: null,
  status: null,
  goalId: null,
  reason,
  effects: [],
});

/**
 * `agent_before_settle` is allowed exactly one continuation.
 *
 * pi's own contract is the reason this is a function and not an `if` in the generated file: an
 * unconditional `continue` loops forever, and the extension is the one place where that mistake
 * costs a night of tokens. Only the first `nudge` is honoured; `silent`, `escalate`, `handoff` and
 * `done-observed` never continue a run.
 */
export function responseFromEffects(
  effects: GoalEffect[],
  record: GoalRecord,
  reason: string | null = null,
): GoalResponse {
  const nudge = effects.find((e) => e.kind === 'nudge');
  const escalate = effects.find((e) => e.kind === 'escalate');
  const handoff = effects.find((e) => e.kind === 'handoff');
  const done = effects.find((e) => e.kind === 'done-observed');
  // An `ignore` is the only effect that says *why nothing happened*, and it used to be invisible:
  // the response carried `effects: [{kind:'ignore'}]` and a `reason` of `null`, so `/goal` printed
  // "goal woken" for a wake the goal had refused. A host that cannot read the refusal cannot report
  // it, and a silent refusal is the failure mode this whole file exists to avoid.
  const ignore = effects.find((e) => e.kind === 'ignore');

  return {
    ok: true,
    continue: nudge !== undefined,
    message: nudge?.kind === 'nudge' ? nudge.message : null,
    notify: escalate?.kind === 'escalate' ? escalate.message : null,
    status: record.status,
    goalId: record.id,
    // `handoff` is a request the extension has to act on, so it needs to be distinguishable from
    // "nothing to do" even when nothing is continued.
    reason:
      reason ??
      (ignore?.kind === 'ignore'
        ? ignore.reason
        : handoff !== undefined
          ? 'handoff requested'
          : done !== undefined
            ? 'done observed'
            : null),
    effects,
  };
}

/**
 * Who acts on each effect.
 *
 * The generated extension can only ever *see* an effect list; it cannot import this file, so nothing
 * forced it to have an opinion about a new kind. That is how a real defect shipped twice:
 * `responseFromEffects` ignored `ignore`, and the `/goal wake` handler dropped the `message` that its
 * own claim returned — both cases of an effect nobody was assigned to.
 *
 * So the disposition is declared here, `Record<GoalEffect['kind'], …>` makes it **exhaustive at compile
 * time** (a new kind does not build until someone decides), and `test/goal-extension.test.ts` asserts the
 * generated source names every `host-action` one. The alternative — a comment saying "remember to update
 * the adapter" — is a promise, and this codebase has been bitten by exactly that.
 *
 * - `host-action`: the extension must do something. A `wake-ready` that is not delivered, or a
 *   `clear-wake` that is not cancelled, is a bug with no other symptom.
 * - `cli-internal`: resolved inside `runGoalEvent` before the response is built, so a host that sees one
 *   is looking at a stale answer.
 * - `informational`: for a human or a log. A host may ignore it, and `responseFromEffects` is where a
 *   message becomes `message`/`notify`.
 */
export type EffectDisposition = 'host-action' | 'cli-internal' | 'informational';

export const EFFECT_DISPOSITIONS: Record<GoalEffect['kind'], EffectDisposition> = {
  nudge: 'host-action',
  escalate: 'host-action',
  'clear-wake': 'host-action',
  'schedule-wake': 'host-action',
  'wake-ready': 'host-action',
  handoff: 'host-action',
  evaluate: 'cli-internal',
  silent: 'informational',
  ignore: 'informational',
  'done-observed': 'informational',
};

/** Every effect the generated extension is required to have an opinion about. */
export const HOST_ACTION_EFFECTS = Object.entries(EFFECT_DISPOSITIONS)
  .filter(([, disposition]) => disposition === 'host-action')
  .map(([kind]) => kind);

// Both symbols that used to live here are gone on purpose, and their absence is the record.
//
// - `describeVerdict(passed, detail)` was never called: the real notify text is built inline in
//   `commands/goal.ts`, with different wording ("done_when did not pass" / "Goal complete"). Two
//   sentence builders that disagree is a second source of truth for what a verdict reads like.
// - `CONTEXT_REMINDER` was documented as "lives here so the generated extension holds no wording of
//   its own", and the template hardcoded its own copy anyway — they had already drifted on quoting.
//   Interpolating it into a template literal is the fix that would be needed, not a duplicate
//   export; until someone does that, the template's copy is the single one.
//
// `CONTEXT_REMINDER_PERCENT` still lives in `core/goal.ts` and is the number both sides agree on.
