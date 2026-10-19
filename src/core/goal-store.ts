/**
 * `.ai/goal/<id>/` — where a goal's state lives.
 *
 * The record is `goal.json` (machine-owned, written by the engine), the declaration is `BRIEF.md`
 * (the human's goal text plus the machine-checkable `done_when` block), `TASKS.md` backs a
 * checklist-shaped `done_when`, and `REPORT.md` is the closing report.
 *
 * Nothing here throws. A goal left half-written by a killed session, a JSON file with a trailing
 * comma, a brief whose fenced block is malformed — each one produces a specific error string, so the
 * engine can escalate or ask for classification instead of dying inside `agent_settled`. The
 * distinction that matters is "not classified yet" (`doneWhen: null, error: null`) versus "the
 * declaration is broken" (`error` set): reporting a typo as "no goal yet" would send the agent to
 * rewrite a file that already exists.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { asciiSlug, listIfPresent, readIfPresent, todayISO, writeFileGuarded } from './project.js';
import type { DoneWhen, GoalBrief, GoalRecord, GoalStatus, MetricOp, WakeCondition } from './goal.js';

export const GOAL_DIR = '.ai/goal';
export const GOAL_RECORD = 'goal.json';
export const GOAL_BRIEF = 'BRIEF.md';
export const GOAL_TASKS = 'TASKS.md';
export const GOAL_REPORT = 'REPORT.md';

export const goalDir = (root: string, id: string): string => path.join(root, GOAL_DIR, id);
export const goalRecordPath = (root: string, id: string): string => path.join(goalDir(root, id), GOAL_RECORD);
export const goalBriefPath = (root: string, id: string): string => path.join(goalDir(root, id), GOAL_BRIEF);
export const goalTasksPath = (root: string, id: string): string => path.join(goalDir(root, id), GOAL_TASKS);
export const goalReportPath = (root: string, id: string): string => path.join(goalDir(root, id), GOAL_REPORT);

/** `2026-10-18-ship-the-thing` — dated like every other bank entry, so `ls` sorts chronologically. */
export function newGoalId(goal: string, date: string = todayISO()): string {
  return `${date}-${asciiSlug(goal)}`;
}

const STATUSES: ReadonlySet<GoalStatus> = new Set(['running', 'waiting', 'blocked', 'done']);
const CLOSE_REASONS = new Set(['completed', 'cancelled', 'abandoned']);
const METRIC_OPS: ReadonlySet<MetricOp> = new Set(['>=', '<=', '>', '<', '==', '!=']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Validate the declared `done_when`, including a mistake that must not pass as a weaker verdict. */
export function parseDoneWhen(value: unknown): { doneWhen: DoneWhen | null; error: string | null } {
  if (!isRecord(value)) return { doneWhen: null, error: 'done_when must be a JSON object' };
  const kind = value.kind;

  if (kind === 'cmd') {
    const commands = Array.isArray(value.commands)
      ? value.commands.filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      : [];
    if (commands.length === 0) return { doneWhen: null, error: 'done_when.cmd needs a non-empty "commands" array' };
    return { doneWhen: { kind: 'cmd', commands }, error: null };
  }

  if (kind === 'metric') {
    const file = str(value.file);
    const dotted = str(value.path);
    const op = str(value.op) as MetricOp | null;
    const hasValue = typeof value.value === 'number' || (typeof value.value === 'string' && value.value.trim() !== '');
    if (!file) return { doneWhen: null, error: 'done_when.metric needs "file"' };
    if (!dotted) return { doneWhen: null, error: 'done_when.metric needs "path"' };
    if (op === null || !METRIC_OPS.has(op)) {
      return { doneWhen: null, error: `done_when.metric "op" must be one of >= <= > < == !=` };
    }
    if (!hasValue) return { doneWhen: null, error: 'done_when.metric needs a "value"' };
    return { doneWhen: { kind: 'metric', file, path: dotted, op, value: value.value as number | string }, error: null };
  }

  if (kind === 'checklist') {
    const file = str(value.file) ?? GOAL_TASKS;
    return { doneWhen: { kind: 'checklist', file }, error: null };
  }

  return { doneWhen: null, error: 'done_when.kind must be "cmd", "metric" or "checklist"' };
}

const DONE_WHEN_HEADING_RE = /^#{1,6}\s*done\s*when\b/i;
const JSON_FENCE_RE = /^```(?:json)?\s*$/i;

/**
 * Read `done_when` out of `BRIEF.md`: the first fenced JSON block under a "Done when" heading.
 *
 * A fenced block, rather than front-matter or a second JSON file, because the brief is the one
 * artefact a *human* also writes, and a machine-checkable verdict has to be legible next to the
 * prose it formalises.
 */
export function parseBrief(markdown: string): GoalBrief {
  const lines = markdown.split('\n');
  let inSection = false;
  let inFence = false;
  let sawSection = false;
  const block: string[] = [];

  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!inFence && /^#{1,6}\s+/.test(line)) {
      inSection = DONE_WHEN_HEADING_RE.test(line);
      if (inSection) sawSection = true;
      continue;
    }
    if (!inSection) continue;
    if (!inFence) {
      if (JSON_FENCE_RE.test(line.trim())) inFence = true;
      continue;
    }
    if (line.trim().startsWith('```')) break;
    block.push(line);
  }

  if (!sawSection) return { doneWhen: null, error: 'BRIEF.md has no "## Done when" section' };
  // No block under the heading is **not** an error: it is the state `engram goal new` deliberately
  // scaffolds, where the first run is supposed to classify the goal. Reporting it as a parse failure
  // put a ⚠ in the fingerprint for every freshly created goal — which trains the reader to ignore the
  // one warning that does matter.
  if (block.length === 0) return { doneWhen: null, error: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(block.join('\n'));
  } catch (err) {
    return { doneWhen: null, error: `BRIEF.md done_when is not valid JSON (${(err as Error).message})` };
  }
  return parseDoneWhen(parsed);
}

function parseWakeCondition(v: unknown): WakeCondition | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'time' && typeof v.seconds === 'number' && Number.isFinite(v.seconds) && v.seconds >= 0) {
    return { kind: 'time', seconds: v.seconds };
  }
  if (v.kind === 'process' && typeof v.pid === 'number' && Number.isInteger(v.pid)) {
    return { kind: 'process', pid: v.pid };
  }
  const artifact = str(v.path);
  if (v.kind === 'artifact' && artifact) return { kind: 'artifact', path: artifact };
  return null;
}

/**
 * Validate a `goal.json` loaded from disk.
 *
 * Tolerant by design: a field engram does not recognise is dropped, and a missing optional field
 * gets its neutral default. A strict parser would turn a hand edit or a newer engine's file into a
 * dead goal, which is the opposite of "the memory outlives the tool".
 */
export function parseGoalRecord(raw: string): { record: GoalRecord | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch (err) {
    return { record: null, error: `goal.json is not valid JSON (${(err as Error).message})` };
  }
  if (!isRecord(parsed)) return { record: null, error: 'goal.json must be a JSON object' };

  const id = str(parsed.id);
  const goal = str(parsed.goal);
  const status = str(parsed.status) as GoalStatus | null;
  const createdAt = str(parsed.createdAt);
  if (!id) return { record: null, error: 'goal.json is missing "id"' };
  if (!goal) return { record: null, error: 'goal.json is missing "goal"' };
  if (status === null || !STATUSES.has(status)) return { record: null, error: 'goal.json has an unknown "status"' };

  const batonRaw = isRecord(parsed.baton) ? parsed.baton : null;
  const batonSession = batonRaw ? str(batonRaw.sessionPath) : null;
  const wakeRaw = isRecord(parsed.wake) ? parsed.wake : null;
  const condition = wakeRaw ? parseWakeCondition(wakeRaw.condition) : null;
  const blockerRaw = isRecord(parsed.blocker) ? parsed.blocker : null;
  const closeReason = str(parsed.closeReason);

  const num = (v: unknown, fallback = 0): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;

  const record: GoalRecord = {
    version: 1,
    id,
    goal,
    status,
    baton: batonSession
      ? { sessionPath: batonSession, paneId: str(batonRaw?.paneId), startedAt: str(batonRaw?.startedAt) ?? createdAt ?? '' }
      : null,
    createdAt: createdAt ?? '',
    updatedAt: str(parsed.updatedAt) ?? createdAt ?? '',
    closedAt: str(parsed.closedAt),
    closeReason: closeReason !== null && CLOSE_REASONS.has(closeReason) ? (closeReason as GoalRecord['closeReason']) : null,
    rounds: num(parsed.rounds),
    reports: num(parsed.reports),
    wake:
      wakeRaw && condition !== null
        ? {
            token: str(wakeRaw.token) ?? 'wake-0',
            condition,
            requestedAt: str(wakeRaw.requestedAt) ?? '',
            deadlineAt: str(wakeRaw.deadlineAt) ?? '',
          }
        : null,
    wakeSeq: num(parsed.wakeSeq),
    lastDigest: str(parsed.lastDigest),
    unchangedRounds: num(parsed.unchangedRounds),
    unreportedSettles: num(parsed.unreportedSettles),
    blocker: blockerRaw && str(blockerRaw.reason)
      ? {
          reason: str(blockerRaw.reason) ?? '',
          repeats: num(blockerRaw.repeats, 1) || 1,
          needs: str(blockerRaw.needs),
          raisedAt: str(blockerRaw.raisedAt) ?? '',
        }
      : null,
    lastNote: str(parsed.lastNote),
    pendingVerdict: isRecord(parsed.pendingVerdict)
      ? { claimedAt: str(parsed.pendingVerdict.claimedAt) ?? '', claim: str(parsed.pendingVerdict.claim) }
      : null,
    lastVerdict: isRecord(parsed.lastVerdict) && typeof parsed.lastVerdict.passed === 'boolean'
      ? {
          passed: parsed.lastVerdict.passed,
          detail: str(parsed.lastVerdict.detail) ?? '',
          at: str(parsed.lastVerdict.at) ?? '',
        }
      : null,
    pendingHandoff: isRecord(parsed.pendingHandoff)
      ? { requestedAt: str(parsed.pendingHandoff.requestedAt) ?? '', reason: str(parsed.pendingHandoff.reason) }
      : null,
    pendingWakes: Array.isArray(parsed.pendingWakes)
      ? parsed.pendingWakes
          .filter(isRecord)
          .map((w) => ({ reason: str(w.reason) ?? '', at: str(w.at) ?? '' }))
      : [],
  };
  return { record, error: null };
}

export function serializeGoalRecord(record: GoalRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function readGoalRecord(root: string, id: string): Promise<{ record: GoalRecord | null; error: string | null }> {
  const read = await readIfPresent(goalRecordPath(root, id));
  if (read.error) return { record: null, error: read.error };
  if (read.text === null) return { record: null, error: `no ${GOAL_DIR}/${id}/${GOAL_RECORD}` };
  return parseGoalRecord(read.text);
}

/**
 * Write the record through the symlink guard.
 *
 * `goal.json` is rewritten on every transition, so this is the busiest write engram performs. The
 * same lesson as `sync` applies: a guarded pruner next to an unguarded write is only half a fix.
 */
export async function writeGoalRecord(root: string, record: GoalRecord): Promise<boolean> {
  return writeFileGuarded(root, goalRecordPath(root, record.id), serializeGoalRecord(record));
}

/** `doneWhen: null, error: null` means "not declared yet" — the normal state of a fresh goal. */
export async function readGoalBrief(root: string, id: string): Promise<GoalBrief> {
  const read = await readIfPresent(goalBriefPath(root, id));
  if (read.error) return { doneWhen: null, error: read.error };
  if (read.text === null) return { doneWhen: null, error: null };
  return parseBrief(read.text);
}

/** Goal directories present on disk, newest name first. Unreadable directories are skipped. */
export async function listGoalIds(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(root, GOAL_DIR), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

/**
 * The project's live goal: the newest record that is not closed.
 *
 * "One goal per project" is enforced by returning one — a second open goal is a state the store
 * refuses to invent rather than one it silently arbitrates.
 */
export async function activeGoal(
  root: string,
  ids?: string[],
): Promise<{ id: string; record: GoalRecord } | null> {
  for (const id of ids ?? (await listGoalIds(root))) {
    const read = await readGoalRecord(root, id);
    if (read.record && read.record.closedAt === null) return { id, record: read.record };
  }
  return null;
}

/** Names of the goal directories that hold no readable `goal.json` — a damaged goal, not an absent one. */
export async function damagedGoals(root: string, ids?: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids ?? (await listGoalIds(root))) {
    const read = await readGoalRecord(root, id);
    if (read.record === null) out.push(`${id}: ${read.error ?? 'unreadable'}`);
  }
  return out;
}

/** Names of the files a goal owns, for `dump`/`doctor` without duplicating the path helpers. */
export async function goalFiles(root: string, id: string): Promise<string[]> {
  const dir = goalDir(root, id);
  const { names } = await listIfPresent(dir);
  return names.map((n) => `${GOAL_DIR}/${id}/${n}`);
}
