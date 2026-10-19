/**
 * `engram goal …` — the human side of the goal engine.
 *
 * M1 delivered a library: a reducer, an evaluator and a store. Nothing could *create* a goal, and
 * the pi adapter in M2 cannot deliver a wake without a `goal wake` command to call. This module is
 * the missing verb set, and it is deliberately the only place that reads a goal from the CLI — the
 * engine itself still holds no lifecycle code.
 *
 * Every command here is a plain filesystem operation on `.ai/goal/<id>/`. None of them runs an
 * agent loop: `unit` *emits* a systemd unit (systemd runs the job, never this process), and
 * `wake --deliver` hands the engine's own message to `herdr agent prompt` for the pane that holds
 * the baton. Neither starts a long job, because the longer a job lives the less it may belong to the
 * agent's process tree.
 */

import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import {
  pathExists,
  readFileSafe,
  resolvesInsideRoot,
  writeFile,
  writeFileGuarded,
  writeIfMissing,
} from '../core/project.js';
import {
  createdPaneId,
  createdTabId,
  herdrAgentStartArgs,
  herdrJson,
  herdrPaneGetArgs,
  herdrTabCloseArgs,
  herdrTabCreateArgs,
  paneForSessionPath,
  paneWorkspaceId,
  promptPane,
  startedSessionPath,
  type HerdrDeps,
} from '../core/herdr.js';
import { engramCommand, goalUnitName, goalUnitSource, unitOutcome } from '../templates/systemd.js';
import { workingTreeDigest } from '../core/git.js';
import { evaluateDoneWhen, staysInsideRoot, type DoneVerdict, type EvalDeps } from '../core/goal-eval.js';
import {
  activeGoal,
  damagedGoals,
  goalBriefPath,
  goalDir,
  goalReportPath,
  goalTasksPath,
  listGoalIds,
  newGoalId,
  readGoalBrief,
  readGoalRecord,
  writeGoalRecord,
} from '../core/goal-store.js';
import { goalBrief, goalTasks } from '../templates/goal-files.js';
import {
  DEFAULT_LIMITS,
  newGoalRecord,
  reduce,
  type DoneWhen,
  type GoalEffect,
  type GoalEvent,
  type GoalLimits,
  type GoalRecord,
  type GoalReport,
  type WakeCondition,
} from '../core/goal.js';
import { idleResponse, responseFromEffects, type GoalResponse } from '../core/goal-host.js';
import { readConfig } from '../core/config.js';

export interface GoalCliResult {
  exitCode: number;
  /** Human-facing lines; the CLI prints them verbatim. */
  lines: string[];
  warnings: string[];
}

const ok = (lines: string[], warnings: string[] = []): GoalCliResult => ({ exitCode: 0, lines, warnings });
const fail = (lines: string[]): GoalCliResult => ({ exitCode: 1, lines, warnings: [] });

/** The active goal, or a result explaining why there is none. */
async function requireActive(root: string): Promise<{ id: string; record: GoalRecord } | GoalCliResult> {
  const active = await activeGoal(root);
  if (active !== null) return active;
  const damaged = await damagedGoals(root);
  if (damaged.length) return fail([`the only goal(s) present are unreadable:`, ...damaged.map((d) => `  ${d}`)]);
  // "no active goal" right after a goal just finished is the confusing case: name the closed one, so
  // the reader does not conclude their goal vanished.
  const ids = await listGoalIds(root);
  const last = ids[0] === undefined ? null : (await readGoalRecord(root, ids[0])).record;
  if (last !== null && last.closedAt !== null) {
    return fail([
      `no active goal. The most recent one (${last.id}) is ${last.closeReason} since ${last.closedAt}.`,
      'Create the next one with `engram goal new "<goal text>"`.',
    ]);
  }
  return fail(['no active goal. Create one with `engram goal new "<goal text>"`.']);
}

export interface GoalNewOptions {
  root: string;
  goal: string;
  today: string;
  doneWhen?: DoneWhen;
  /** Replace an existing goal with the same id instead of refusing. */
  force?: boolean;
  /** Record the creating session as the baton holder. */
  sessionPath?: string;
  paneId?: string;
}

/**
 * Create a goal and its brief.
 *
 * Two refusals carry a rule: a project may hold **one** open goal (single baton, one writer to
 * `CURRENT_TASK.md`), and a goal may not be created in a directory that is not a git repository —
 * traceability is mandatory because round one runs in the normal checkout.
 */
export async function runGoalNew(opts: GoalNewOptions): Promise<GoalCliResult> {
  const { root, goal, today } = opts;
  const text = goal.trim();
  if (!text) return fail(['a goal needs a description: engram goal new "<goal text>"']);

  const existing = await activeGoal(root);
  if (existing !== null && !opts.force) {
    return fail([
      `an active goal already exists: ${existing.id}`,
      `  ${existing.record.goal}`,
      'one goal per project (single baton). Close it first:',
      `  engram goal close --id ${existing.id}`,
    ]);
  }

  const id = newGoalId(text, today);
  const dir = goalDir(root, id);
  if (await pathExists(path.join(dir, 'goal.json')) && !opts.force) {
    return fail([`${id} already exists (use --force to overwrite)`]);
  }

  const now = new Date().toISOString();
  const record = newGoalRecord({
    id,
    goal: text,
    now,
    baton: opts.sessionPath
      ? { sessionPath: opts.sessionPath, paneId: opts.paneId ?? null, startedAt: now }
      : null,
  });
  if (!(await writeGoalRecord(root, record))) {
    return fail([`refusing to write ${id}/goal.json: the path resolves outside ${root}`]);
  }

  await writeIfMissing(
    goalBriefPath(root, id),
    goalBrief({
      goal: text,
      today,
      ...(opts.doneWhen ? { doneWhen: opts.doneWhen } : {}),
      ...(opts.doneWhen?.kind === 'checklist' ? { checklistFile: opts.doneWhen.file } : {}),
    }),
  );
  if (opts.doneWhen?.kind === 'checklist') {
    await writeIfMissing(goalTasksPath(root, id), goalTasks(text, today));
  }

  const declared = opts.doneWhen
    ? `done_when: ${opts.doneWhen.kind}`
    : 'done_when: not declared — the first run classifies the goal instead of working';
  return ok([`created .ai/goal/${id}/`, `  ${declared}`, `  next: engram goal status`]);
}

/** Print the active goal, its verdict declaration and the last recorded verdict. */
export async function runGoalStatus(root: string): Promise<GoalCliResult> {
  const active = await requireActive(root);
  if ('exitCode' in active) return active;
  const { id, record } = active;
  const brief = await readGoalBrief(root, id);

  const lines = [
    `${record.goal}`,
    `  id:      ${id}`,
    `  status:  ${record.status}${record.closedAt ? ` (closed ${record.closeReason} at ${record.closedAt})` : ''}`,
    `  rounds:  ${record.rounds} (${record.reports} reports)`,
    `  baton:   ${record.baton ? `${record.baton.sessionPath}${record.baton.paneId ? ` @ ${record.baton.paneId}` : ''}` : 'unclaimed'}`,
    `  brief:   .ai/goal/${id}/BRIEF.md`,
  ];
  if (brief.error) lines.push(`  verdict: ⚠ ${brief.error}`);
  else if (brief.doneWhen) lines.push(`  verdict: ${brief.doneWhen.kind} — ${describeDoneWhen(brief.doneWhen)}`);
  else lines.push('  verdict: not declared (the goal is unclassifiable until BRIEF.md declares one)');

  if (record.blocker) {
    lines.push(`  blocked: ${record.blocker.reason}${record.blocker.needs ? ` — needs ${record.blocker.needs}` : ''} (${record.blocker.repeats}x)`);
  }
  if (record.wake) {
    lines.push(
      `  waiting: ${describeWake(record.wake.condition)} since ${record.wake.requestedAt}, deadline ${record.wake.deadlineAt}`,
    );
  }
  if (record.lastVerdict) {
    lines.push(`  last verdict: ${record.lastVerdict.passed ? '✅ passed' : '❌ failed'} — ${record.lastVerdict.detail}`);
  }
  if (record.pendingWakes.length) lines.push(`  ${record.pendingWakes.length} wake(s) arrived while blocked`);

  return ok(lines);
}

const describeDoneWhen = (d: DoneWhen): string =>
  d.kind === 'cmd'
    ? d.commands.join(' && ')
    : d.kind === 'metric'
      ? `${d.file}:${d.path} ${d.op} ${String(d.value)}`
      : d.file;

const describeWake = (c: GoalRecord['wake'] extends infer W ? (W extends { condition: infer C } ? C : never) : never): string =>
  c.kind === 'time' ? `${c.seconds}s` : c.kind === 'process' ? `pid ${c.pid}` : c.path;

/** List every goal directory, marking the active one. */
export async function runGoalList(root: string): Promise<GoalCliResult> {
  const ids = await listGoalIds(root);
  if (ids.length === 0) return ok(['no goals yet — engram goal new "<goal text>"']);
  const lines: string[] = [];
  for (const id of ids) {
    const read = await readGoalRecord(root, id);
    if (read.record === null) {
      lines.push(`  ${id.padEnd(40)} ⚠ ${read.error ?? 'unreadable'}`);
      continue;
    }
    const closed = read.record.closedAt ? ` (${read.record.closeReason})` : '';
    lines.push(`  ${id.padEnd(40)} ${read.record.status}${closed} · ${read.record.rounds} rounds · ${read.record.goal}`);
  }
  return ok(lines);
}

/**
 * Run `done_when` now and record the verdict.
 *
 * This is the command that makes "done is re-runnable" true: the same gate that ends a run can be
 * re-executed by a human a week later and produce the same answer.
 */
export async function runGoalCheck(
  root: string,
  id?: string,
  deps: EvalDeps = {},
): Promise<GoalCliResult & { verdict?: DoneVerdict }> {
  const target = id ?? (await activeGoal(root))?.id;
  if (target === undefined) return { ...fail(['no active goal to check']), verdict: undefined };

  const read = await readGoalRecord(root, target);
  if (read.record === null) return { ...fail([`${target}: ${read.error ?? 'unreadable'}`]), verdict: undefined };

  const brief = await readGoalBrief(root, target);
  if (brief.doneWhen === null) {
    return {
      ...fail([`${target}: ${brief.error ?? 'no done_when declared in BRIEF.md'}`]),
      verdict: undefined,
    };
  }

  const verdict = await evaluateDoneWhen(root, resolveDoneWhen(root, target, brief.doneWhen), deps);
  const lines = [
    `${verdict.passed ? '✅' : '❌'} ${target} — ${verdict.detail}`,
    ...verdict.checks.map((c) => `  ${c.passed ? '·' : '✗'} ${c.check} — ${c.outcome}`),
  ];

  // The verdict is fed through the reducer, so a check run by a human has exactly the same effect as
  // one triggered by the agent's `done` claim: it can close the goal, or nudge it back to work.
  const digest = await workingTreeDigest(root);
  const step = reduce(
    { record: read.record, brief },
    { kind: 'verdict', now: new Date().toISOString(), passed: verdict.passed, detail: verdict.detail, digest },
    await limitsFor(root),
  );
  await writeGoalRecord(root, step.record);

  return { exitCode: verdict.passed ? 0 : 1, lines, warnings: describeEffects(step.effects), verdict };
}

/**
 * Resolve a declaration's relative paths against the goal it belongs to.
 *
 * A bare `TASKS.md` is the goal's own checklist, not a file at the repository root — but a
 * `docs/x.md` or `.ai/goal/<id>/TASKS.md` is project-relative. Getting this wrong made the
 * scaffolded checklist unreadable from `goal check` while `goal new` had just created it, which is
 * the worst kind of disagreement: the tool contradicts its own output.
 */
function resolveDoneWhen(root: string, id: string, doneWhen: DoneWhen): DoneWhen {
  const resolve = (file: string): string =>
    path.isAbsolute(file) || file.includes('/') ? file : path.join(goalDir(root, id), file);
  return doneWhen.kind === 'checklist' || doneWhen.kind === 'metric'
    ? { ...doneWhen, file: resolve(doneWhen.file) }
    : doneWhen;
}

/** A one-line description per effect, so the CLI can say what the engine *would* do next. */
function describeEffects(effects: GoalEffect[]): string[] {
  return effects
    .filter((e) => e.kind === 'escalate' || e.kind === 'nudge')
    .map((e) =>
      e.kind === 'escalate'
        ? `engine: escalate (${e.severity}) — ${e.message}`
        : `engine: continue (${e.reason})`,
    );
}

export interface GoalWakeOptions {
  root: string;
  id?: string;
  token?: string;
  reason: string;
  /**
   * Deliver the nudge to the baton holder through herdr — the last hop of L3.
   *
   * Opt-in rather than default: `wake` stays a pure state transition that a human or a test can
   * call, and only a caller that owns a transport (the generated unit's `ExecStopPost`) asks for
   * delivery. Without it the wake is still recorded and still releases the latch.
   */
  deliver?: boolean;
  /** Injected in tests; systemd's `ExecStopPost` exports the unit's outcome here. */
  env?: NodeJS.ProcessEnv;
  /** Injected in tests, so the delivery policy is testable without herdr installed. */
  herdr?: HerdrDeps;
}

/**
 * Deliver the engine's own message to whoever holds the baton.
 *
 * The holder is resolved *now*, from `goal.json` — which is what lets a wake survive a handoff: the
 * pane recorded when the goal was created may be long gone, and the current holder's address is the
 * only one worth using.
 *
 * **Two identities, tried in order, because a pane is a container and the agent is not.** A `pane_id`
 * *is* durable across a herdr server restart — measured on hpstation with herdr 0.8.2: the server was
 * stopped and started again, `persist.restore` reported `outcome="ok"`, and `w4:p1` still resolved to
 * the same tab and workspace. What did **not** survive is the process inside it: the pane came back
 * holding a fresh shell, so a recorded pane id no longer implies that an agent is there. Two fields
 * that look like identities are not: `terminal_id` changes on every spawn (`term_65e1f20c171f04` →
 * `term_65e1f2cb36f9f2`) and `revision` is a counter.
 *
 * So the retry is not about renumbering. It is that the baton's **session file path** is the only handle
 * that names an *agent* rather than a place — `herdr agent list` maps it to whatever pane that session is
 * in now — and a wake addressed to a pane whose agent is gone would otherwise be reported as delivered
 * into a shell. The id is the fast path; the session path is the identity engram owns.
 *
 * A failure is reported loudly and is never a lost wake, because the **caller** writes the record only
 * after this returns `ok`. That ordering is the whole guarantee and it was once the other way round:
 * the transition was persisted first, so a failed delivery left a `running` goal with no latched token
 * for a later reconcile to re-arm — while this comment claimed the token stayed latched. A claim in a
 * comment that the code does not enforce is worse than no claim.
 */
async function deliverNudge(
  record: GoalRecord,
  message: string,
  deps: HerdrDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const sessionPath = record.baton?.sessionPath;
  const recorded = record.baton?.paneId ?? null;
  if (recorded === null && sessionPath === undefined) {
    return { ok: false, lines: ['  deliver: NOT DELIVERED — the goal has no baton holder, so there is no pane to wake'] };
  }

  const lines: string[] = [];
  if (recorded !== null) {
    const res = await promptPane(recorded, message, deps);
    if (res.ok) return { ok: true, lines: [`  deliver: ${res.detail}`] };
    lines.push(`  deliver: ${recorded} did not accept the prompt — ${res.detail}`);
    if (sessionPath === undefined) {
      return { ok: false, lines: [`  deliver: NOT DELIVERED — ${res.detail}`] };
    }
  }

  // The recorded pane is absent or stale. The session path is the fallback, and it is also the only
  // path when the baton was recorded without a pane (a goal created outside herdr).
  const resolved = await paneForSessionPath(sessionPath as string, deps);
  if (resolved.pane === null) {
    return { ok: false, lines: [...lines, `  deliver: NOT DELIVERED — ${resolved.detail}`] };
  }
  const retry = await promptPane(resolved.pane, message, deps);
  return {
    ok: retry.ok,
    lines: [
      ...lines,
      `  deliver: retried through ${resolved.detail}`,
      retry.ok ? `  deliver: ${retry.detail}` : `  deliver: NOT DELIVERED — ${retry.detail}`,
    ],
  };
}

/**
 * Deliver a wake to the goal.
 *
 * Addressed to the **goal**, not to a pane: the token is matched against `goal.json`'s latched wake,
 * so a wake that arrives after a handoff still reaches whoever holds the baton now. The caller (a
 * systemd `ExecStopPost`, a herdr trigger, a human) delivers the *nudge*; this command only decides
 * whether the wake is real.
 */
export async function runGoalWake(opts: GoalWakeOptions): Promise<GoalCliResult> {
  const active = opts.id !== undefined ? { id: opts.id, record: (await readGoalRecord(opts.root, opts.id)).record } : await activeGoal(opts.root);
  if (active === null || active.record === null) return fail(['no active goal to wake']);

  const token = opts.token ?? active.record.wake?.token;
  if (token === undefined) {
    // Not a failure: a wake is delivered once and consumed, so a second one finds nothing latched.
    // Reporting exit 1 here made `/goal wake` and a systemd `ExecStopPost` look broken when they had
    // in fact already succeeded. Exit 0 with an explicit "ignored" is the honest answer.
    return ok([`${active.id} is not waiting — wake ignored (already consumed, or never latched)`]);
  }

  // systemd's ExecStopPost exports how the unit ended. Folding it into the reason is what keeps
  // "the process exited" from being read as "the job succeeded" — an OOM kill exits too, and the
  // engine cannot tell which happened. Passed on the command line it would have to survive systemd's
  // own `$VAR` expansion; read from the environment it cannot be mangled.
  const outcome = unitOutcome(opts.env ?? process.env);
  const reason = outcome === null ? opts.reason : `${opts.reason} (${outcome})`;

  const step = reduce(
    { record: active.record, brief: await readGoalBrief(opts.root, active.id) },
    { kind: 'wake', now: new Date().toISOString(), token, reason },
    await limitsFor(opts.root),
  );

  if (step.record === active.record) {
    return ok([`wake ${token} ignored (already handled, or the goal is not waiting)`]);
  }

  const lines = [`wake ${token} accepted: ${reason}`, `  status: ${step.record.status}`];
  // An escalation carries a message too: a job that ended while the goal was `blocked` is news for
  // the human who is the blocker, so it must reach them the same way a nudge does.
  const nudge = step.effects.find((e) => e.kind === 'nudge' || e.kind === 'escalate');

  // **Deliver, then record.** The engine consumes the wait here, and a wait that has been consumed
  // cannot be delivered again — so writing the record first would destroy the one thing a failed
  // delivery needs: a latched token that the next `session_start` can re-arm. The cost of this order is
  // the friendlier one: a crash between the two re-wakes and spends one extra turn (at-least-once),
  // never a parked goal nothing is watching.
  if (nudge !== undefined && opts.deliver) {
    const delivered = await deliverNudge(step.record, nudge.message, opts.herdr ?? {});
    lines.push(...delivered.lines);
    if (!delivered.ok) {
      // The token is still latched and the goal is still `waiting`, so this is not a lost wake:
      // the liveness deadline, the next run and the next `session_start` all still apply. Exit 1 so a
      // human running this by hand sees that nothing was delivered, and so a caller that *does* care
      // can retry. systemd's `ExecStopPost` ignores it either way, and its next start re-arms from
      // `goal.json`.
      lines.push(`  ${active.id} is still waiting — the wake was not consumed; re-running this or starting a session will retry`);
      return { exitCode: 1, lines, warnings: describeEffects(step.effects) };
    }
  } else if (nudge !== undefined) {
    lines.push(`  deliver: herdr agent prompt <baton pane> — "${reason}"`);
  }

  await writeGoalRecord(opts.root, step.record);
  return ok(lines);
}

/**
 * Close a goal without a verdict.
 *
 * `completed` is deliberately unreachable here: only an observed `done_when` verdict may claim it.
 */
export async function runGoalClose(root: string, reason: 'cancelled' | 'abandoned', id?: string): Promise<GoalCliResult> {
  const target = id ?? (await activeGoal(root))?.id;
  if (target === undefined) return fail(['no active goal to close']);
  const read = await readGoalRecord(root, target);
  if (read.record === null) return fail([`${target}: ${read.error ?? 'unreadable'}`]);

  const step = reduce(
    { record: read.record, brief: await readGoalBrief(root, target) },
    { kind: 'close', now: new Date().toISOString(), reason },
    await limitsFor(root),
  );
  if (step.record === read.record) return ok([`${target} is already closed`]);
  await writeGoalRecord(root, step.record);
  return ok([`closed ${target} (${reason})`]);
}

/**
 * Take the baton for this session, or hand it to another one.
 *
 * A handoff without a baton transfer is how a goal ends up with two drivers or none, so this is a
 * first-class command rather than a side effect of `goal wake`.
 */
export async function runGoalBaton(root: string, sessionPath: string, paneId?: string, id?: string): Promise<GoalCliResult> {
  const target = id ?? (await activeGoal(root))?.id;
  if (target === undefined) return fail(['no active goal']);
  const read = await readGoalRecord(root, target);
  if (read.record === null) return fail([`${target}: ${read.error ?? 'unreadable'}`]);

  const now = new Date().toISOString();
  const previous = read.record.baton?.sessionPath ?? 'none';
  // Taking the baton **is** taking the handoff, so a pending request is cleared here. Without this a
  // successful handoff left `pendingHandoff` set: the successor's continuation guard is silent while a
  // handoff is pending, so it would never be nudged, and `reconcile` would later escalate "handoff was
  // requested but never taken" about a handoff that was taken. A caller whose transfer does *not* mean
  // the handoff was taken must roll back explicitly (see `runGoalHandoff`), not reuse this command.
  const clearedHandoff = read.record.pendingHandoff !== null;
  await writeGoalRecord(root, {
    ...read.record,
    baton: { sessionPath, paneId: paneId ?? null, startedAt: now },
    pendingHandoff: null,
    updatedAt: now,
  });
  return ok([
    `baton ${previous} → ${sessionPath}`,
    ...(clearedHandoff ? ['  pending handoff cleared — it was taken, not abandoned'] : []),
  ]);
}

/**
 * The baton identity a goal should record, taken from the environment the command runs in.
 *
 * Both values are already there when the command is run by anything that participates in the goal's
 * runtime: pi exports its session file as `PI_SESSION_FILE`, and a herdr pane exports
 * `HERDR_PANE_ID` (the decision that split runtime/mechanics/memory relies on panes inheriting
 * `HERDR_ENV`). Reading them is what makes a goal *drivable without being asked*: the pane that must
 * be woken is recorded when the goal is created, so L3 has an address to deliver to later — a goal
 * created without one can only ever be recovered by a new run or the deadline.
 *
 * Explicit flags win, and an absent variable stays absent (`undefined`, not `''`): a goal created
 * outside a pane must stay recognisably unclaimed rather than claim a holder named after nothing.
 *
 * `workspaceId` is read for a different reason: it is the **container** rule (see
 * `successorWorkspace`). One herdr workspace is one project, so a successor window must never open in
 * another one.
 */
export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): {
  sessionPath?: string;
  paneId?: string;
  workspaceId?: string;
} {
  const sessionPath = env.PI_SESSION_FILE?.trim();
  const paneId = env.HERDR_PANE_ID?.trim();
  const workspaceId = env.HERDR_WORKSPACE_ID?.trim();
  return {
    ...(sessionPath ? { sessionPath } : {}),
    ...(paneId ? { paneId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export interface EngramCommandOptions {
  env?: NodeJS.ProcessEnv;
  /** The running CLI, used when neither `--engram` nor `ENGRAM_BIN` names one. */
  argv1?: string;
  /** `process.execPath`; a `tsc`-emitted CLI is not executable on its own. */
  node?: string;
  /** Injected in tests, so the emitted prefix is asserted without touching the filesystem. */
  isExecutable?: (file: string) => Promise<boolean>;
}

export interface GoalHandoffOptions {
  root: string;
  id?: string;
  /** Why the delivery point is clean. Folded into the successor's first message. */
  reason?: string;
  /** The predecessor's identity, so the reducer can check the baton before the runtime is touched. */
  sessionPath?: string;
  /** The pane to open the successor's window beside. Defaults to the baton's pane. */
  paneId?: string;
  /** The successor's pane name, so a human can tell whose handoff it is. */
  name?: string;
  env?: NodeJS.ProcessEnv;
  herdr?: HerdrDeps;
  /**
   * Pin the workspace explicitly. Normally unnecessary — `successorWorkspace` reads
   * `HERDR_WORKSPACE_ID`, then the baton's pane — and it exists so a human can override a mismatch
   * without editing code.
   */
  workspaceId?: string;
}

/**
 * Which workspace the successor's window opens in — a fixed rule, not a fallback.
 *
 * The project's own convention is **one herdr workspace per project** (a space is a project; it does
 * not hold several). So a handoff must never open a window anywhere but the workspace of the session
 * that is handing off, and "where the client happens to be focused" is not an acceptable answer: with
 * three projects open, a focus-dependent choice lands a successor in whatever space was last clicked.
 *
 * Three sources, strongest first, and the disagreement case is deliberate:
 *
 * 1. `HERDR_WORKSPACE_ID` — exported by the pane, so it is *this* session's workspace and cannot be
 *    stale. Preferred because it survives herdr not being readable at all.
 * 2. `herdr pane get <holder pane>` — the recorded baton's own workspace, read from the runtime. Used
 *    when the environment does not say (an older herdr, a hand-driven call from outside a pane).
 * 3. Neither → **refuse**. Not "let herdr pick": `tab create` without `--workspace` targets the
 *    *focused* workspace, and `--workspace ''` is a hard error, so guessing is the one thing that
 *    would put a successor in another project's space without anyone noticing.
 *
 * When both sources answer and they differ, the environment wins *and the disagreement is reported* — a
 * mismatch means the baton's pane was recorded in a different space than the one running this command,
 * which almost always means a goal was created in the wrong window, and silently picking one would bury
 * that.
 */
export function successorWorkspace(input: {
  env: NodeJS.ProcessEnv;
  paneWorkspace: string | null;
}): { workspace: string | null; detail: string } {
  const fromEnv = input.env.HERDR_WORKSPACE_ID?.trim() || null;
  const fromPane = input.paneWorkspace;

  if (fromEnv !== null) {
    if (fromPane !== null && fromPane !== fromEnv) {
      return {
        workspace: fromEnv,
        detail: `this session is in ${fromEnv} but the baton's pane is in ${fromPane}; using ${fromEnv}`,
      };
    }
    return { workspace: fromEnv, detail: `workspace ${fromEnv} (from the pane environment)` };
  }
  if (fromPane !== null) {
    return { workspace: fromPane, detail: `workspace ${fromPane} (from the baton's pane)` };
  }
  return {
    workspace: null,
    detail: 'cannot tell which herdr workspace this handoff belongs to — HERDR_WORKSPACE_ID is unset and the baton pane could not be read',
  };
}

/**
 * The tab label for a successor window.
 *
 * A tab bar reading `2`, `3`, `4` is how a human loses track of which window is which goal, and the
 * label is the only part of the successor a human sees without reading the transcript. Trimmed rather
 * than truncated silently: a label that is cut mid-word is still a label, but one the reader has to
 * finish in their head.
 */
export function successorLabel(raw: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  return text.length <= 40 ? text : `${text.slice(0, 39).trimEnd()}…`;
}

/**
 * The successor's first message. It is the whole handoff: a fresh session knows nothing but what a
 * human would type into it.
 *
 * Deliberately names files rather than summarising them. A summary would be a second, staler copy of
 * the bank — and the bank is the artifact the next session is supposed to read.
 */
export function handoffPrompt(input: { id: string; goal: string; paneId: string; reason?: string }): string {
  const why = input.reason?.trim();
  return [
    `You are taking the baton for the long-running goal ${input.id} in this project (pane ${input.paneId}).`,
    `Goal: ${input.goal}`,
    why ? `The previous holder handed off because: ${why}.` : 'The previous holder handed off at a clean delivery point.',
    '',
    'Before working, read in this order: `.ai/CURRENT_TASK.md`, the newest `.ai/sessions/*-handoff.md`,',
    `and \`.ai/goal/${input.id}/BRIEF.md\` (its \`done_when\` is what ends this goal — a claim is not a verdict).`,
    'You are the baton holder: report with goal_report once per turn. Do not ask the previous holder',
    'anything — it is not reading this pane. If the bank and the code disagree, fix the bank in the same change.',
  ].join('\n');
}

/**
 * Open a successor pane through herdr and hand it the goal (M4).
 *
 * The order of the five steps is the whole design, and each edge is a failure that was reasoned
 * about rather than discovered:
 *
 * 1. **Record the request first.** `pendingHandoff` is set through the reducer (which also enforces
 *    that only the baton holder may drive), so a spawn that fails leaves evidence and the stale-handoff
 *    escalation still fires. Touching the runtime before the record would make a failed handoff
 *    invisible.
 * 2. **Split beside the holder's pane, not beside "the current one".** herdr splits whatever pane the
 *    client last focused otherwise; a probe on 2026-10-18 put the successor in another workspace.
 * 3. **Start, and take the successor's session file from the answer.** That identity is what makes a
 *    real baton transfer possible instead of a placeholder.
 * 4. **Transfer the baton before prompting.** The successor's first turn must already belong to the
 *    holder, or its `run-started` and first report are refused as an intruder's and it settles in
 *    silence. If the prompt then fails, the baton is handed *back* — an orphaned goal is worse than a
 *    failed handoff.
 * 5. **Prompt last, without `--wait`.** A successor's first turn can take minutes; the predecessor's
 *    job is to hand over and stop, not to watch.
 *
 * Outside herdr there is nothing to open a pane with, so this refuses *before* step 1 and says why.
 * The handoff decision's rule 5 still holds: the model asks for a handoff, and this — a command the
 * model called — is what opens the pane. No lifecycle code decides to spawn.
 */
export async function runGoalHandoff(opts: GoalHandoffOptions): Promise<GoalCliResult> {  const env = opts.env ?? process.env;
  const active = opts.id !== undefined ? { id: opts.id, record: (await readGoalRecord(opts.root, opts.id)).record } : await activeGoal(opts.root);
  if (active === null || active.record === null) return fail(['no active goal to hand off']);
  const id = active.id;

  if (env.HERDR_ENV !== '1') {
    return fail([
      'a handoff needs herdr: engram can only open a successor pane through it.',
      '  run this from inside a herdr pane (HERDR_ENV=1), or report blocked and let a human open one.',
    ]);
  }

  // 1. The record, through the reducer: the baton rule and the `pendingHandoff` state belong to the
  //    engine, not to this command.
  const reported = await runGoalReport(
    opts.root,
    { status: 'handoff', ...(opts.reason ? { reason: opts.reason } : {}) },
    opts.sessionPath !== undefined ? { sessionPath: opts.sessionPath } : {},
  );
  if (!reported.effects.some((e) => e.kind === 'handoff')) {
    return fail([
      `${id}: handoff not recorded — the engine ignored it`,
      ...reported.effects.filter((e) => e.kind === 'ignore').map((e) => `  ${e.reason}`),
    ]);
  }

  const deps = opts.herdr ?? {};
  const predecessor = opts.sessionPath ?? reported.record?.baton?.sessionPath ?? null;
  const target = opts.paneId ?? active.record.baton?.paneId ?? null;
  const lines: string[] = [`handoff recorded for ${id}`];

  // 2. A window to inherit the goal. A *tab*, not a split: splitting made the human's tab narrower on
  //    every handoff and put the successor beside a transcript it shares no context with. And always in
  //    **this project's own workspace** — one space is one project here, so a successor in another space
  //    would be in another project's window. See `successorWorkspace` for the three sources and why
  //    "neither" is a refusal rather than a guess.
  const fromPane = target === null ? null : paneWorkspaceId((await herdrJson(herdrPaneGetArgs(target), deps)).json);
  const where =
    opts.workspaceId !== undefined
      ? { workspace: opts.workspaceId, detail: `workspace ${opts.workspaceId} (pinned by --workspace)` }
      : successorWorkspace({ env, paneWorkspace: fromPane });
  if (where.workspace === null) {
    return fail([
      ...lines,
      `could not place the successor window: ${where.detail}`,
      '  a successor outside this project\'s space would be in another project; nothing was opened.',
      '  the handoff request stays on the record, so the stale-handoff escalation still applies',
    ]);
  }
  if (fromPane !== null && fromPane !== where.workspace) {
    lines.push(`  warning: ${where.detail}`);
  }
  const label = successorLabel(opts.name ?? `goal-${id.slice(0, 24)}`);
  const created = await herdrJson(herdrTabCreateArgs(where.workspace, opts.root, label), deps);
  const pane = created.ok ? createdPaneId(created.json) : null;
  if (pane === null) {
    return fail([
      ...lines,
      `could not open a successor window: ${created.ok ? `${deps.bin ?? 'herdr'} answered without a pane id` : created.detail}`,
      '  the handoff request stays on the record, so the stale-handoff escalation still applies',
    ]);
  }
  const tab = createdTabId(created.json);
  lines.push(`  window: ${tab ?? '(unknown tab)'} — “${label}” in ${where.detail}`, `  pane: ${pane}`);

  // 3. The successor, and its identity.
  //
  //    A pane whose agent never starts is closed again: leaving it open strands an empty window in the
  //    human's tab bar for every failed handoff, and the useful information is the *reason*, not the
  //    window. Measured: a fresh directory makes pi ask "Trust project folder?", herdr then reports no
  //    session path, and the window stays behind looking like a working successor.
  const name = opts.name ?? `goal-${id.slice(0, 24)}`;
  const start = await herdrJson(herdrAgentStartArgs(name, 'pi', pane, 60_000), deps);
  const successor = start.ok ? startedSessionPath(start.json) : null;
  if (successor === null) {
    const why = start.ok ? 'herdr answered without a session path' : start.detail;
    const closed = tab === null ? null : await herdrJson(herdrTabCloseArgs(tab), deps);
    lines.push(
      `  successor not started: ${why}`,
      closed === null
        ? `  window ${tab ?? pane} left open: no tab id to close`
        : closed.ok
          ? `  window ${tab} closed again`
          : `  window ${tab} could not be closed: ${closed.detail}`,
      '  a first run in a directory pi has not trusted stops at "Trust project folder?" and never becomes ready.',
    );
    return {
      exitCode: 1,
      lines,
      warnings: [`no successor agent in ${pane} (${why})`],
    };
  }
  lines.push(`  successor: ${successor}`);

  // 4. Baton first, prompt second — with a rollback, because an unclaimed goal is the worse failure.
  const transfer = await runGoalBaton(opts.root, successor, pane, id);
  lines.push(...transfer.lines.map((l) => `  ${l}`));
  const delivered = await promptPane(pane, handoffPrompt({ id, goal: active.record.goal, paneId: pane, ...(opts.reason ? { reason: opts.reason } : {}) }), deps);
  if (!delivered.ok) {
    lines.push(`  prompt NOT delivered: ${delivered.detail}`);
    if (predecessor !== null) {
      // An explicit rollback, not `runGoalBaton`: that command *clears* a pending handoff because a
      // transfer means it was taken, and this one was not. Restoring the value the reducer just wrote
      // is what keeps the request — and the stale-handoff escalation — alive.
      const current = await readGoalRecord(opts.root, id);
      if (current.record === null) {
        lines.push(`  and ${id} could not be re-read, so the baton stays with ${successor}`);
      } else {
        const now = new Date().toISOString();
        await writeGoalRecord(opts.root, {
          ...current.record,
          baton: { sessionPath: predecessor, paneId: active.record.baton?.paneId ?? null, startedAt: now },
          pendingHandoff: reported.record?.pendingHandoff ?? null,
          updatedAt: now,
        });
        lines.push(`  baton ${successor} → ${predecessor}`, '  the handoff request stays pending — it was not taken');
      }
    } else {
      // No recorded predecessor: the baton cannot be returned, so say so rather than pretend.
      lines.push('  the baton could not be returned — no predecessor was recorded');
    }
    return { exitCode: 1, lines, warnings: [`${pane} holds the baton but never received the brief`] };
  }
  lines.push(`  delivered: ${delivered.detail}`, '  this session must stop driving: the baton is not yours any more');
  return ok(lines);
}

export interface GoalUnitOptions extends EngramCommandOptions {
  root: string;
  id?: string;
  /** `ExecStart` payload, verbatim. Required: engram schedules nothing, systemd runs the job. */
  job: string;
  /** Write the unit into `.ai/goal/<id>/` instead of printing it to stdout. */
  write?: boolean;
  /** Overrides the engram argv baked into the unit (tests, and installs that are not on PATH). */
  engram?: string[];
}

/**
 * Which engram the unit should call.
 *
 * An absolute path in every case, because a systemd user unit has no login `PATH` to find `engram`
 * in; and a shebang is not enough, because `tsc` emits `build/src/cli.js` as `0644` — the unit would
 * start, the job would run, and the wake would fail with `EACCES` while nothing looked broken.
 */
export async function resolveEngramCommand(opts: EngramCommandOptions = {}): Promise<string[]> {
  const env = opts.env ?? process.env;
  const explicit = env.ENGRAM_BIN?.trim();
  if (explicit !== undefined && explicit !== '') return [explicit];
  // Absolutised: the unit sets its own `WorkingDirectory`, so a CLI named as `build/src/cli.js`
  // would resolve against the *goal's* project rather than the one that emitted the unit.
  const argv1 = opts.argv1 ?? process.argv[1] ?? '';
  if (argv1 === '') return ['engram'];
  const bin = path.resolve(argv1);
  const node = opts.node ?? process.execPath;
  const canExec = await (opts.isExecutable ??
    (async (file: string) => {
      try {
        await fs.access(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }))(bin);
  return engramCommand(bin, canExec, node);
}

/**
 * Emit the systemd unit that runs a long job and wakes this goal when it exits (L3).
 *
 * `--write` is not the default on purpose: this command's normal output is a *file to read*, and a
 * scaffolder that writes into a repository unasked is the kind of side effect the opt-in goal carrier
 * already had to be taught not to have. When it does write, it writes inside `.ai/goal/<id>/` only,
 * through the same symlink guard as every other write in the bank.
 */
export async function runGoalUnit(opts: GoalUnitOptions): Promise<GoalCliResult> {
  const target = opts.id ?? (await activeGoal(opts.root))?.id;
  if (target === undefined) return fail(['no active goal — engram goal new "<goal text>" first']);
  const read = await readGoalRecord(opts.root, target);
  if (read.record === null) return fail([`${target}: ${read.error ?? 'unreadable'}`]);

  const job = opts.job.trim();
  // A unit with an empty ExecStart is refused by systemd with a message about the unit, which reads
  // as "engram emitted a broken file" rather than "you forgot the job".
  if (job === '') return fail(['a unit needs the job to run: --job "<command>"']);

  const env = opts.env ?? process.env;
  const source = goalUnitSource({
    id: target,
    goal: read.record.goal,
    root: opts.root,
    job,
    engram: opts.engram ?? (await resolveEngramCommand(opts)),
    path: env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    reason: `goal unit ${target} exited`,
  });

  const unit = goalUnitName(target);
  // `split` leaves an empty element after the file's trailing newline; printing it would add a blank
  // line that `--write` does not put on disk, so the printed unit and the written one would differ.
  if (opts.write !== true) return ok(source.split('\n').slice(0, -1));

  const abs = path.join(goalDir(opts.root, target), unit);
  if (!(await resolvesInsideRoot(opts.root, abs))) {
    return fail([`refusing to write ${unit}: the path resolves outside ${opts.root}`]);
  }
  if (!(await writeFileGuarded(opts.root, abs, source))) {
    return fail([`refusing to write ${unit} through a symlinked directory — nothing was modified`]);
  }
  const rel = path.relative(opts.root, abs);
  return ok([
    `wrote ${rel}`,
    '',
    'install it as a user unit (a symlink, so regenerating the unit is picked up):',
    `  mkdir -p ~/.config/systemd/user`,
    `  ln -sf ${abs} ~/.config/systemd/user/${unit}`,
    '  systemctl --user daemon-reload',
    `  systemctl --user start ${unit}`,
    `  journalctl --user -u ${unit} -f`,
  ]);
}

/**
 * A one-screen summary for `/goal`, built from the record already on hand.
 *
 * Deliberately here rather than in the extension: the extension must contain no rule and no wording,
 * and a summary that disagreed with `engram goal status` would become a second source of truth about
 * the goal's state.
 */
function describeStatus(view: { record: GoalRecord; brief: { doneWhen: DoneWhen | null; error: string | null } }): string {
  const g = view.record;
  const lines = [`${g.goal} (${g.id})`, `status: ${g.status} · ${g.rounds} rounds`];
  const d = view.brief.doneWhen;
  if (d) {
    lines.push(
      `done_when: ${
        d.kind === 'cmd'
          ? d.commands.join(' && ')
          : d.kind === 'metric'
            ? `${d.file}:${d.path} ${d.op} ${String(d.value)}`
            : d.file
      }`,
    );
  } else {
    lines.push(`done_when: ${view.brief.error ?? 'not declared'}`);
  }
  if (g.blocker) lines.push(`blocked: ${g.blocker.reason}${g.blocker.needs ? ` — needs ${g.blocker.needs}` : ''}`);
  if (g.wake) lines.push(`waiting until ${g.wake.deadlineAt}`);
  if (g.lastVerdict) lines.push(`last verdict: ${g.lastVerdict.passed ? 'passed' : 'failed'} — ${g.lastVerdict.detail}`);
  return lines.join('\n');
}

/**
 * Report on behalf of an agent. Used by the pi adapter and by tests; not exposed as a CLI verb
 * because a human driving the loop by hand should use `check` / `wake` / `close` instead.
 */
export async function runGoalReport(
  root: string,
  report: GoalReport,
  opts: { sessionPath?: string; digest?: string | null } = {},
): Promise<GoalCliResult & { record: GoalRecord | null; effects: GoalEffect[] }> {
  const active = await activeGoal(root);
  if (active === null) return { exitCode: 1, lines: ['no active goal'], warnings: [], record: null, effects: [] };

  const brief = await readGoalBrief(root, active.id);
  const step = reduce(
    { record: active.record, brief },
    {
      kind: 'report',
      now: new Date().toISOString(),
      report,
      digest: opts.digest ?? null,
      ...(opts.sessionPath ? { sessionPath: opts.sessionPath } : {}),
    },
    await limitsFor(root),
  );
  await writeGoalRecord(root, step.record);
  return { exitCode: 0, lines: [`${active.id}: ${step.record.status}`], warnings: [], record: step.record, effects: step.effects };
}

/**
 * The engine limits this project asked for, over the defaults.
 *
 * One reader, called at every `reduce`, because a limit applied on some transitions and not others is
 * the asymmetric-guard shape that has already cost this codebase three bugs: `livenessMs` read in one
 * branch and defaulted in another means a wait expires on one path and never on the next. The waiting
 * decision promised "default 24h, configurable"; until this existed the config key was not read at all.
 *
 * A missing or unreadable config is the default, never an error: the limits are a tuning knob, and
 * refusing to report a goal because a number is malformed would trade a working engine for a strict one.
 */
async function limitsFor(root: string): Promise<GoalLimits> {
  const config = await readConfig(root);
  return { ...DEFAULT_LIMITS, ...(config?.limits ?? {}) };
}

// ---------------------------------------------------------------- the host wire surface

/**
 * Has the wait's condition been observed on this machine?
 *
 * Only `process` and `artifact` reach here. `time` is the engine's own clock, so there is nothing to
 * look at — the reducer decides it from the wait's `requestedAt`.
 *
 * Two failure modes are deliberately *not* folded into `null`: an artifact path outside the project is
 * refused exactly like `done_when.file` and checklist evidence are (a declaration is not a way out of
 * the project), and an unknown error from the pid probe is "still there" rather than "gone", because
 * a false wake spends a turn on nothing while a late one is covered by the deadline.
 */
async function conditionObserved(root: string, condition: WakeCondition): Promise<boolean> {
  if (condition.kind === 'time') return false;
  if (condition.kind === 'artifact') {
    const inside = staysInsideRoot(root, condition.path);
    if (!inside.ok) return false;
    return pathExists(inside.resolved);
  }
  // `kill(pid, 0)` sends no signal: it asks the OS whether the process exists. EPERM means it exists
  // and belongs to another user — alive, not exited. Only ESRCH ("no such process") is an exit.
  try {
    process.kill(condition.pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * One pi lifecycle event in, one `GoalResponse` out — the entire contract the generated extension
 * depends on.
 *
 * `--json` on these verbs is the protocol. The extension shells out to `engram goal event --json`
 * rather than importing the engine, so there is exactly one implementation of every rule and no
 * second copy to drift. A failure never throws: a missing bank, an unreadable goal and an invalid
 * report all come back as `ok: false` with a reason, because an extension that throws inside
 * `agent_before_settle` takes the session down.
 */
export interface HostEventInput {
  /** `settled` | `run-started` | `wake` | `poll` | `reconcile` | `report` | `status` */
  event: string;
  sessionPath?: string;
  /** The pane this event came from; `reconcile` uses it to recognise a restarted holder. */
  paneId?: string;
  reason?: string;
  token?: string;
  /** Present for `event: "report"`: the raw `goal_report` arguments. */
  report?: import('../core/goal-host.js').ReportArgs;
}

export async function runGoalEvent(
  root: string,
  input: HostEventInput,
  deps: { digest?: () => Promise<string | null>; runAt?: string } = {},
): Promise<GoalResponse> {
  const now = deps.runAt ?? new Date().toISOString();
  const active = await activeGoal(root);
  if (active === null) {
    const damaged = await damagedGoals(root);
    return idleResponse(damaged.length ? `the goal record is unreadable: ${damaged[0]}` : 'no active goal');
  }

  const brief = await readGoalBrief(root, active.id);
  const view = { record: active.record, brief };

  let event: GoalEvent;
  switch (input.event) {
    case 'settled':
    case 'run-started':
      event = {
        kind: input.event,
        now,
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
      } as GoalEvent;
      break;
    case 'reconcile': {
      // `reconcile` is the one event that may *adopt* a goal: a restarted pi is a new session file, so
      // the recorded holder no longer exists and every other event from it is refused. The pane id is
      // what makes the adoption safe — see `onReconcile`.
      const identity = identityFromEnv();
      const paneId = input.paneId ?? identity.paneId;
      event = {
        kind: 'reconcile',
        now,
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
        ...(paneId ? { paneId } : {}),
      };
      break;
    }
    case 'wake': {
      const token = input.token ?? active.record.wake?.token;
      if (token === undefined) return idleResponse('not waiting; nothing to wake');
      // The emitter's identity travels with the wake so the reducer can refuse a stale holder's timer.
      // An absent one stays absent: an unidentified emitter is a legitimate wake (a unit, a human).
      event = {
        kind: 'wake',
        now,
        token,
        reason: input.reason ?? 'external wake',
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
      };
      break;
    }
    case 'poll': {
      const token = input.token ?? active.record.wake?.token;
      if (token === undefined) return idleResponse('not waiting; nothing to poll');
      // The one place a wake condition is looked at, and it lives here rather than in the generated
      // extension for two reasons: reading the machine is I/O (`core/` is a pure reducer), and a
      // declared artifact path has to be confined by the same rule as every other declared path in the
      // project. The extension holds the clock and no observation rule at all.
      const condition = active.record.wake?.condition;
      const observed = condition === undefined ? false : await conditionObserved(root, condition);
      event = {
        kind: 'poll',
        now,
        token,
        observed,
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
      };
      break;
    }
    case 'status':
      // `/goal` asks for a summary, not a transition. Returning it through the same wire shape keeps
      // the generated extension from needing a second call signature — and a second parser. Without
      // this branch the extension's `event("status")` fell through to `default`, so `/goal` always
      // printed `unknown goal event "status"` instead of the goal.
      return {
        ok: true,
        continue: false,
        message: describeStatus(view),
        notify: null,
        status: view.record.status,
        goalId: view.record.id,
        reason: null,
        effects: [],
      };
    case 'report': {
      const { parseReportArgs } = await import('../core/goal-host.js');
      const parsed = parseReportArgs(input.report ?? { status: '' });
      if (parsed.report === null) {
        return {
          ok: false,
          continue: false,
          message: null,
          notify: null,
          status: view.record.status,
          goalId: view.record.id,
          reason: parsed.error,
          effects: [],
        };
      }
      // The digest is the stuck detector's only input. A host that cannot compute one sends null,
      // which the reducer treats as "unknown", never as "unchanged".
      const digest = deps.digest ? await deps.digest() : null;
      event = {
        kind: 'report',
        now,
        report: parsed.report,
        digest,
        ...(input.sessionPath ? { sessionPath: input.sessionPath } : {}),
      };
      break;
    }
    default:
      return idleResponse(`unknown goal event "${input.event}"`);
  }

  const limits = await limitsFor(root);
  const step = reduce(view, event, limits);
  let record = step.record;
  let effects = step.effects;

  // `evaluate` is the one effect that must be resolved *here*, not by the extension.
  //
  // Verifying completion is the engine's job: a host that had to run the gate and feed the answer
  // back would be a second place where "done" is decided, and the generated extension is exactly
  // the place where that rule has to not exist. So the CLI runs `done_when`, reduces the verdict, and
  // answers in one round trip.
  const evaluate = effects.find((e) => e.kind === 'evaluate');
  if (evaluate?.kind === 'evaluate') {
    const digest = deps.digest ? await deps.digest() : null;
    const verdict = await evaluateDoneWhen(root, resolveDoneWhen(root, active.id, evaluate.doneWhen));
    const verdictStep = reduce(
      { record, brief },
      { kind: 'verdict', now, passed: verdict.passed, detail: verdict.detail, digest },
      limits,
    );
    record = verdictStep.record;
    // The verdict effects replace the evaluate effect: the caller needs "what happens now", not
    // "we asked a question" plus "here is the answer".
    effects = [...effects.filter((e) => e.kind !== 'evaluate'), ...verdictStep.effects];
    if (verdictStep.record.status === 'done') {
      effects = [
        { kind: 'escalate', severity: 'needs-input', message: `Goal complete — done_when passed: ${verdict.detail}` },
        ...effects,
      ];
    } else if (verdictStep.effects.some((e) => e.kind === 'nudge')) {
      // A failed gate is the model's next instruction, so it must read as a nudge with the reason,
      // not as an escalation to a human.
      effects = effects.map((e) =>
        e.kind === 'nudge'
          ? { kind: 'nudge', reason: 'verdict-failed' as const, message: `done_when did not pass: ${verdict.detail}` }
          : e,
      );
    }
  }

  if (record !== view.record) await writeGoalRecord(root, record);
  return responseFromEffects(effects, record);
}

/** Write the closing report next to the record. Human prose; the verdict is already in `goal.json`. */
export async function writeGoalReportFile(root: string, id: string, body: string): Promise<string> {
  const file = goalReportPath(root, id);
  await writeFile(file, body.endsWith('\n') ? body : `${body}\n`);
  return file;
}

/** The existing `REPORT.md`, for `goal status` and for tests. */
export async function readGoalReportFile(root: string, id: string): Promise<string | null> {
  return readFileSafe(goalReportPath(root, id));
}
