/**
 * The one thing engram asks of herdr: *prompt the pane that holds the baton*.
 *
 * herdr owns the runtime — panes, process lifetime, crash recovery — so a wake that has to reach a
 * parked session goes through `herdr agent prompt <target> <text>` rather than through anything
 * engram invents. This is the last hop of L3: the systemd unit's `ExecStopPost` calls
 * `engram goal wake --deliver`, and that is what turns "a wake is latched in `goal.json`" into "the
 * agent is running again".
 *
 * Two rules it inherits from the decision that created the `waiting` state:
 *
 * - **A wake is addressed to the goal, not to a pane.** The caller resolves the *current* baton
 *   holder at delivery time, so a wake that arrives after a handoff still reaches whoever holds the
 *   baton now. Nothing here caches a pane.
 * - **Failures are loud and distinguishable.** A missing `herdr`, a refused submission because the
 *   agent is blocked, and a successful delivery are three different states. Collapsing them into
 *   `null` is exactly how an installed goal engine comes to look like a working one while every
 *   wake is dropped (see `.ai/pitfalls/cases/generated-extension-not-executable.md`).
 *
 * All I/O goes through `HerdrDeps`, so the delivery policy is testable without herdr installed.
 */

import { execFile } from 'node:child_process';

export interface HerdrRun {
  /** `null` when the process never started (ENOENT/EACCES) — *not* the same as a non-zero exit. */
  status: number | null;
  stdout: string;
  error: string | null;
}

export interface HerdrDeps {
  run?(argv: string[], timeoutMs: number): Promise<HerdrRun>;
  /** The herdr executable; `herdr` on `PATH` by default. */
  bin?: string;
  timeoutMs?: number;
}

export interface DeliveryResult {
  ok: boolean;
  /** Always set: what was attempted, and what actually happened. */
  detail: string;
}

/** Submitting a prompt is a socket round trip, not a job. */
const DEFAULT_TIMEOUT_MS = 15_000;

export const herdrListArgs = (): string[] => ['agent', 'list'];

/** `herdr agent prompt <target> <text>` — argv, never a shell string. */
export const herdrPromptArgs = (target: string, text: string): string[] => ['agent', 'prompt', target, text];

/**
 * Split `cwd`'s pane beside the pane that holds the baton.
 *
 * The target pane is **named**, never left implicit: without it herdr splits whatever pane the
 * client last focused, which put the successor in a different workspace than the goal it inherits.
 * `--no-focus` keeps the human's cursor where it is — a handoff is not a request to steal the
 * keyboard.
 */
export const herdrPaneSplitArgs = (paneId: string, cwd: string): string[] => [
  'pane',
  'split',
  paneId,
  '--direction',
  'right',
  '--cwd',
  cwd,
  '--no-focus',
];

/** Start an interactive agent in a pane that is sitting at a shell prompt. */
export const herdrAgentStartArgs = (name: string, kind: string, paneId: string, timeoutMs: number): string[] => [
  'agent',
  'start',
  name,
  '--kind',
  kind,
  '--pane',
  paneId,
  '--timeout',
  String(timeoutMs),
];

/**
 * A dotted lookup into a herdr response.
 *
 * herdr answers with `{"id": "cli:pane:split", "result": { … }}`, and the shape is the runtime's,
 * not ours — so this returns `null` for anything unexpected instead of throwing a `TypeError` that
 * would read as "engram is broken" when the runtime merely changed.
 */
export function stringAt(json: unknown, dotted: string): string | null {
  let cur: unknown = json;
  for (const key of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' && cur !== '' ? cur : null;
}

/** The pane a `pane split` created. */
export const createdPaneId = (json: unknown): string | null => stringAt(json, 'result.pane.pane_id');

/**
 * The session file of a started agent.
 *
 * `agent start` reports it directly, which is what makes a real baton transfer possible: the
 * successor's identity is known *before* it is prompted, so the goal can be handed over and its
 * first turn already belongs to the holder instead of being refused as an intruder.
 */
export const startedSessionPath = (json: unknown): string | null => stringAt(json, 'result.agent.agent_session.value');

export interface HerdrCall {
  ok: boolean;
  /** Always set: what was attempted, and what actually happened. */
  detail: string;
  json: unknown;
}

/**
 * One herdr command whose answer is a JSON document.
 *
 * Separate from `promptPane` because the callers differ in how much they may assume: a wake may
 * arrive when herdr is gone (and must not be lost), while a handoff cannot proceed at all without
 * the runtime and must say so before it touches the goal record.
 */
export async function herdrJson(argv: string[], deps: HerdrDeps = {}): Promise<HerdrCall> {
  const { run, bin } = runnerOf(deps);
  const res = await run(argv, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const label = `${bin} ${argv.slice(0, 2).join(' ')}`;
  if (res.status === null) {
    return { ok: false, detail: `cannot run ${bin} (${res.error ?? 'spawn failed'})`, json: null };
  }
  const refused = herdrError(res.stdout);
  if (refused !== null) return { ok: false, detail: `${label} refused: ${refused}`, json: null };
  if (res.status !== 0) {
    const why = res.error ?? res.stdout.trim();
    return { ok: false, detail: `${label} exited ${res.status}${why ? `: ${why}` : ''}`, json: null };
  }
  try {
    return { ok: true, detail: `${label} ok`, json: JSON.parse(res.stdout.trim()) };
  } catch {
    return { ok: false, detail: `${label} did not answer with JSON: ${res.stdout.trim().slice(0, 200)}`, json: null };
  }
}

function defaultRun(bin: string): (argv: string[], timeoutMs: number) => Promise<HerdrRun> {
  return (argv, timeoutMs) =>
    new Promise<HerdrRun>((resolve) => {
      execFile(
        bin,
        argv,
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return resolve({ status: 0, stdout, error: null });
          const e = err as NodeJS.ErrnoException & { code?: number | string | null };
          // A spawn failure and a non-zero exit are different causes with different fixes, so they
          // are reported as different states rather than merged into "it did not work".
          if (typeof e.code === 'string') {
            return resolve({ status: null, stdout: stdout ?? '', error: `${e.code}: ${e.message}` });
          }
          const code = typeof e.code === 'number' ? e.code : null;
          resolve({
            status: code,
            stdout: stdout ?? '',
            error: (stderr ?? '').trim() || e.message,
          });
        },
      );
    });
}

function runnerOf(deps: HerdrDeps): { run: (argv: string[], timeoutMs: number) => Promise<HerdrRun>; bin: string } {
  const bin = deps.bin ?? 'herdr';
  return { run: deps.run ?? defaultRun(bin), bin };
}

/** herdr answers with a JSON document; `error` is a field, not an exit code. */
function herdrError(stdout: string): string | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
      const err = (parsed as { error: unknown }).error;
      if (err === null || err === undefined) return null;
      return typeof err === 'string' ? err : JSON.stringify(err);
    }
  } catch {
    /* not JSON: an operator-readable message, judged by the exit status instead */
  }
  return null;
}

/**
 * Which pane holds this pi session, per herdr's own agent table.
 *
 * The fallback for a baton recorded without a pane id: herdr tracks each pi session *file*
 * (`agent_session.value`), so the address is recoverable rather than lost. Matching is on the exact
 * path herdr reports, because a prefix match would deliver a wake into a different project's pane.
 */
export function paneForSession(listJson: string, sessionPath: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(listJson.trim());
  } catch {
    return null;
  }
  const agents = (parsed as { result?: { agents?: unknown } } | null)?.result?.agents;
  if (!Array.isArray(agents)) return null;
  for (const agent of agents) {
    if (agent === null || typeof agent !== 'object') continue;
    const entry = agent as { pane_id?: unknown; agent_session?: { value?: unknown } };
    if (entry.agent_session?.value !== sessionPath) continue;
    if (typeof entry.pane_id === 'string' && entry.pane_id !== '') return entry.pane_id;
  }
  return null;
}

/** Resolve a session file to a pane, or say why it could not be resolved. */
export async function paneForSessionPath(
  sessionPath: string,
  deps: HerdrDeps = {},
): Promise<{ pane: string | null; detail: string }> {
  const { run, bin } = runnerOf(deps);
  const res = await run(herdrListArgs(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (res.status === null) return { pane: null, detail: `cannot run ${bin} (${res.error ?? 'spawn failed'})` };
  if (res.status !== 0) return { pane: null, detail: `${bin} agent list exited ${res.status}: ${res.error ?? ''}`.trim() };
  const pane = paneForSession(res.stdout, sessionPath);
  return pane === null
    ? { pane: null, detail: `${bin} does not list a pane for ${sessionPath}` }
    : { pane, detail: `resolved ${sessionPath} → ${pane}` };
}

/** Submit `text` to `target`. Never throws; every outcome is in the result. */
export async function promptPane(target: string, text: string, deps: HerdrDeps = {}): Promise<DeliveryResult> {
  const { run, bin } = runnerOf(deps);
  const res = await run(herdrPromptArgs(target, text), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (res.status === null) {
    // The motivating case: the unit has no login PATH, or herdr is not installed on this machine.
    // The wake stays latched either way, so this is reported as "not delivered", not as a lost wake.
    return { ok: false, detail: `cannot run ${bin} (${res.error ?? 'spawn failed'}) — the wake is latched but nothing was delivered` };
  }
  const refused = herdrError(res.stdout);
  if (refused !== null) return { ok: false, detail: `${bin} refused the prompt: ${refused}` };
  if (res.status !== 0) {
    const why = res.error ?? res.stdout.trim();
    return { ok: false, detail: `${bin} agent prompt exited ${res.status}${why ? `: ${why}` : ''}` };
  }
  return { ok: true, detail: `delivered to ${target}` };
}
