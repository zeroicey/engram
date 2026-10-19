/**
 * The `done_when` evaluator: run a command, read a metric field, or check checklist evidence.
 *
 * This is the file that makes "done" reproducible. The engine owns the comparison in every shape,
 * including `metric`, so a goal never has to smuggle a `jq`/`grep` pipeline through a shell string
 * whose quoting can silently flip the verdict.
 *
 * The three shapes are ordered by strength and it shows: `cmd` is an exit code, `metric` is a number
 * a script wrote, and `checklist` is the structurally weaker one — allowed, but it cannot claim the
 * same strength as a command, and an empty or unevidenced list is a *rejection*, not a pass.
 *
 * All I/O goes through `EvalDeps`, so the evaluator runs in tests without spawning anything.
 */

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { DoneWhen, MetricOp } from './goal.js';

/** Long enough for a real test suite, short enough that a hung gate cannot strand the loop. */
export const DEFAULT_CMD_TIMEOUT_MS = 10 * 60 * 1000;

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the command was killed for exceeding the timeout. */
  timedOut: boolean;
}

export interface EvalDeps {
  run?(command: string, cwd: string, timeoutMs: number): Promise<CommandResult>;
  readFile?(file: string): Promise<string | null>;
  pathExists?(file: string): Promise<boolean>;
  timeoutMs?: number;
}

export interface EvalCheck {
  check: string;
  outcome: string;
  passed: boolean;
}

export interface DoneVerdict {
  passed: boolean;
  shape: DoneWhen['kind'];
  /** One line, safe to put in `REPORT.md` and in a nudge message. */
  detail: string;
  checks: EvalCheck[];
}

const tail = (s: string, max = 400): string => {
  const t = s.trim();
  return t.length <= max ? t : `…${t.slice(t.length - max)}`;
};

/**
 * One short line from a command's stderr, for a verdict message a human will actually read.
 *
 * The old version pasted the whole npm failure — including the debug-log path and the syscall dump —
 * into `detail` *and* into every per-check line, so one failing gate produced a screen of
 * boilerplate with the actual reason buried in it.
 */
const summarise = (stderr: string, max = 160): string => {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const interesting = lines.find((l) =>
    /\b(error|failed|failure|not ok|cannot|missing|denied)\b/i.test(l),
  );
  const chosen = interesting ?? lines[lines.length - 1] ?? '';
  return chosen.length <= max ? chosen : `${chosen.slice(0, max - 1)}…`;
};

async function defaultRun(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    exec(
      command,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, timedOut: false });
        const e = err as NodeJS.ErrnoException & {
          code?: number | string | null;
          killed?: boolean;
          signal?: string | null;
        };
        resolve({
          code: typeof e.code === 'number' ? e.code : null,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: e.killed === true || e.signal === 'SIGTERM',
        });
      },
    );
  });
}

const defaultReadFile = async (file: string): Promise<string | null> => {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
};

const defaultPathExists = async (file: string): Promise<boolean> => {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
};

/** Judge a goal against its declared `done_when`. */
export async function evaluateDoneWhen(
  root: string,
  doneWhen: DoneWhen,
  deps: EvalDeps = {},
): Promise<DoneVerdict> {
  switch (doneWhen.kind) {
    case 'cmd':
      return evaluateCommands(root, doneWhen.commands, deps);
    case 'metric':
      return evaluateMetric(root, doneWhen, deps);
    case 'checklist':
      return evaluateChecklist(root, doneWhen.file, deps);
  }
}

/**
 * What an evidence string asks the engine to check.
 *
 * The rule is deterministic and needs no guessing about intent:
 *
 * - `path:<file>` — the file must exist.
 * - `cmd:<command>` — the command must exit 0.
 * - a backticked span **with whitespace** is a command (`npm test`, `git diff --quiet`).
 * - a backticked span **without whitespace** is a path (`docs/goal.md`, `out/eval.json`).
 *
 * The bare form used by the first version of this evaluator (`- [x] x — \`echo hi\``) counted as
 * evidence merely because a backtick existed. An evidence field that cannot fail is a signature, not
 * a check.
 */
export type EvidenceSpec = { kind: 'path'; value: string } | { kind: 'cmd'; value: string };

export function parseEvidence(raw: string): EvidenceSpec | null {
  // Backticks are stripped by the *caller* that extracted the span, but a hand-written checklist or
  // the generated template spells evidence as a fenced span, so the value can still arrive wrapped:
  // ``` `evidence: cmd:grep -q DONE=1 out/p_big.txt` ```. Left in place, that trailing backtick became
  // part of the command and `sh` reported `exit 2` for a command that was correct — a checklist item
  // that could never pass however right it was. Measured on a real goal's TASKS.md.
  const evidence = raw.trim().replace(/^`+|`+$/g, '').trim();
  if (evidence === '') return null;
  // A value collected by `parseChecklist`'s `evidence:` clause can keep the span's *closing* backtick
  // even when the opening one was consumed, so a command arrives as
  //   cmd:grep -q DONE=1 out/p_big.txt`
  // and `sh` reports exit 2 for a command that was written correctly. Strip it once more *after* the
  // prefix is removed, which is the only place both shapes are handled.
  const strip = (v: string): string => v.trim().replace(/^`+|`+$/g, '').trim();
  const pathPrefix = /^path:\s*(.+)$/i.exec(evidence);
  if (pathPrefix?.[1]) return { kind: 'path', value: strip(pathPrefix[1]) };
  const cmdPrefix = /^cmd:\s*(.+)$/i.exec(evidence);
  if (cmdPrefix?.[1]) return { kind: 'cmd', value: strip(cmdPrefix[1]) };
  if (/\s/.test(evidence)) return { kind: 'cmd', value: evidence };
  return { kind: 'path', value: evidence };
}

/**
 * Does this declared path stay inside the project?
 *
 * `done_when.file` and checklist evidence are **project-owned text**, but a typo — or a model that has
 * been talked into it — can name `../../../etc/passwd`. The engine's job is to judge the project, not
 * to read the machine: a path outside the root is a failed verdict with a named reason, not an
 * `fs.readFile` of whatever it resolves to. Absolute paths are refused for the same reason, except
 * when the caller's own root is absolute and contains them (the CLI resolves `--root` first).
 *
 * Purely lexical — no `fs.realpath` — because the file may not exist yet, and a symlink pointing
 * outside is caught later by the reader's own failure.
 */
export function staysInsideRoot(root: string, declared: string): { ok: boolean; resolved: string } {
  const normalizedRoot = path.resolve(root);
  const resolved = path.isAbsolute(declared) ? path.normalize(declared) : path.join(normalizedRoot, declared);
  const normalizedTarget = path.resolve(resolved);
  const inside =
    normalizedTarget === normalizedRoot || normalizedTarget.startsWith(normalizedRoot + path.sep);
  return { ok: inside, resolved: normalizedTarget };
}

async function evaluateCommands(root: string, commands: string[], deps: EvalDeps): Promise<DoneVerdict> {
  const run = deps.run ?? defaultRun;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
  const checks: EvalCheck[] = [];

  // A `cmd` shape with no commands would pass vacuously — the one verdict that must never be
  // free. Whitespace counts as nothing for the same reason: `['   ']` used to reach the shell, exit
  // 0, and pass. A missing *binary* is a failed verdict, never a skipped one.
  const runnable = commands.map((c) => c.trim()).filter((c) => c !== '');
  if (runnable.length === 0) {
    return {
      passed: false,
      shape: 'cmd',
      detail: 'done_when.cmd lists no commands',
      checks: [],
    };
  }

  for (const command of runnable) {
    const r = await run(command, root, timeoutMs);
    const passed = r.code === 0;
    checks.push({
      check: command,
      passed,
      outcome: passed
        ? 'exit 0'
        : r.timedOut
          ? `timed out after ${Math.round(timeoutMs / 1000)}s`
          : `exit ${r.code ?? 'null'}${r.stderr.trim() ? ` · ${summarise(r.stderr)}` : ''}`,
    });
  }

  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    shape: 'cmd',
    detail:
      failed.length === 0
        ? `${checks.length} command(s) exited 0`
        : `${failed.length}/${checks.length} command(s) failed: ${failed.map((c) => `${c.check} (${c.outcome})`).join('; ')}`,
    checks,
  };
}

/**
 * Walk a dotted path through parsed JSON.
 *
 * `a.b[0].c` and `a.0.c` are both accepted: the same field is written as an array index by one
 * script and as a key by another, and rejecting one spelling would look like a wrong metric rather
 * than a syntax difference.
 */
export function readPath(value: unknown, dotted: string): { found: boolean; value: unknown } {
  const parts = dotted
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .map((p) => p.trim())
    .filter((p) => p !== '');
  let cur: unknown = value;
  for (const key of parts) {
    if (cur === null || typeof cur !== 'object') return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      const i = Number.parseInt(key, 10);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return { found: false, value: undefined };
      cur = cur[i];
      continue;
    }
    const obj = cur as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(obj, key)) return { found: false, value: undefined };
    cur = obj[key];
  }
  return { found: true, value: cur };
}

/**
 * Parse a small CSV/TSV: the first non-empty line is the header, the **last** data row supplies the
 * value (a training log is appended to, so the last line is the latest epoch).
 *
 * `delimiter` is supplied by the caller: a quoted field containing a comma (`"a,b"`) made the old
 * comma-split return the wrong column *silently*, which is the worst failure mode a metric reader
 * can have — it reports a number, just not the one that was asked for.
 */
export function parseCsv(text: string, delimiter = ','): { header: string[]; row: string[] } | null {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const first = rows[0];
  if (first === undefined) return null;
  const split = (l: string): string[] =>
    l.split(delimiter).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  const last = rows[rows.length - 1];
  return { header: split(first), row: last === undefined ? [] : split(last) };
}

const CSV_DELIMITERS: ReadonlyArray<readonly [string, string]> = [
  [',', ','],
  ['\t', '\t'],
  [';', ';'],
  ['|', '|'],
];

/**
 * A repeated column name is ambiguous, and picking one silently returns the wrong number.
 * `indexOf` used to pick the first, so `epoch,mAP,mAP` quietly read the first `mAP`.
 */
function ambiguousColumn(header: string[], name: string): boolean {
  return header.filter((h) => h === name).length > 1;
}

/**
 * Extract a metric from a machine-written artifact.
 *
 * Four formats, tried in order, because the shape of "a script writes its result" differs per
 * domain and a goal should not need a wrapper script just to be judged:
 *
 * - **JSON** — the declared format.
 * - **JSONL / NDJSON** — one object per line, the natural shape of a training log that is appended
 *   to per epoch. Read as an *array of records*, so `mAP` means "the last record's `mAP`" while
 *   `[0].mAP` and `[-1].mAP` mean the first and last explicitly. Without this, the most common
 *   long-run artifact on disk reported "path not found" — the metric shape was effectively
 *   unavailable to exactly the work it was designed for.
 * - **CSV / TSV / ; / |** — the delimiter is detected rather than assumed.
 *
 * Returns `found: false` rather than throwing: a typo in `done_when.file` must not take the session
 * down inside `agent_settled`.
 */
export function readMetric(text: string, dotted: string): { found: boolean; value: unknown; ambiguous?: string } {
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    // Plain JSON first; a multi-line JSONL file also starts with `{`, so the fallback is reachable.
    try {
      return readPath(JSON.parse(trimmed) as unknown, dotted);
    } catch {
      const records = parseJsonLines(trimmed);
      if (records !== null) return readJsonLines(records, dotted);
      return { found: false, value: undefined };
    }
  }

  for (const [delimiter] of CSV_DELIMITERS) {
    const csv = parseCsv(text, delimiter);
    if (csv === null || csv.header.length < 2) continue;
    if (ambiguousColumn(csv.header, dotted)) {
      return { found: false, value: undefined, ambiguous: `column "${dotted}" appears more than once` };
    }
    const idx = csv.header.findIndex((h) => h === dotted);
    if (idx === -1) continue;
    // A header with no cell behind it. A partially-written row (`epoch,mAP\n1`) is exactly the
    // mid-run artifact the format widening exists for, and returning `found: true, value: undefined`
    // made `!=` pass vacuously: `String(undefined) !== '0.0'`.
    const cell = csv.row[idx];
    if (cell === undefined) return { found: false, value: undefined, ambiguous: `row has no value for "${dotted}"` };
    return { found: true, value: cell };
  }
  return { found: false, value: undefined };
}

/** Every non-empty line parses as a JSON object, or `null` if any line does not. */
function parseJsonLines(text: string): unknown[] | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '');
  if (lines.length < 2) return null;
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as unknown);
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * Resolve a path against a JSONL log.
 *
 * A bare `mAP` means "the latest record" — the log is append-only, so that is the only reading that
 * matches what a human means. `[0]`/`[-1]` index the records explicitly.
 */
function readJsonLines(records: unknown[], dotted: string): { found: boolean; value: unknown } {
  const head = /^\[(-?\d+)\]\.?/.exec(dotted);
  if (head) {
    const i = Number.parseInt(head[1] ?? '', 10);
    const index = i < 0 ? records.length + i : i;
    const target = records[index];
    if (target === undefined) return { found: false, value: undefined };
    const rest = dotted.slice(head[0].length);
    return rest === '' ? { found: true, value: target } : readPath(target, rest);
  }
  const last = records[records.length - 1];
  if (last === undefined) return { found: false, value: undefined };
  return readPath(last, dotted);
}

const NUMERIC_OPS: ReadonlySet<MetricOp> = new Set(['>=', '<=', '>', '<']);

/** The engine owns the comparison, so the shape of the value decides which ops are legal. */
export function compareMetric(actual: unknown, op: MetricOp, expected: number | string): { passed: boolean; detail: string } {
  if (NUMERIC_OPS.has(op)) {
    const a = typeof actual === 'number' ? actual : Number(actual);
    const b = typeof expected === 'number' ? expected : Number(expected);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return { passed: false, detail: `${String(actual)} ${op} ${String(expected)} is not a numeric comparison` };
    }
    const ok = op === '>=' ? a >= b : op === '<=' ? a <= b : op === '>' ? a > b : a < b;
    return { passed: ok, detail: `${a} ${op} ${b}` };
  }
  const a = String(actual);
  const b = String(expected);
  return { passed: op === '==' ? a === b : a !== b, detail: `"${a}" ${op} "${b}"` };
}

async function evaluateMetric(
  root: string,
  doneWhen: Extract<DoneWhen, { kind: 'metric' }>,
  deps: EvalDeps,
): Promise<DoneVerdict> {
  const readFile = deps.readFile ?? defaultReadFile;
  const check = `${doneWhen.file}:${doneWhen.path} ${doneWhen.op} ${String(doneWhen.value)}`;

  const inside = staysInsideRoot(root, doneWhen.file);
  if (!inside.ok) {
    return {
      passed: false,
      shape: 'metric',
      detail: `${doneWhen.file} points outside the project`,
      checks: [{ check, passed: false, outcome: 'artifact outside the project' }],
    };
  }
  const file = inside.resolved;

  const text = await readFile(file);
  if (text === null) {
    return {
      passed: false,
      shape: 'metric',
      detail: `${doneWhen.file} is missing or unreadable`,
      checks: [{ check, passed: false, outcome: 'artifact not readable' }],
    };
  }

  const found = readMetric(text, doneWhen.path);
  if (!found.found) {
    return {
      passed: false,
      shape: 'metric',
      detail: found.ambiguous
        ? `${doneWhen.file}: ${found.ambiguous}`
        : `${doneWhen.path} not found in ${doneWhen.file}`,
      checks: [{ check, passed: false, outcome: found.ambiguous ?? 'path not found' }],
    };
  }

  const cmp = compareMetric(found.value, doneWhen.op, doneWhen.value);
  return {
    passed: cmp.passed,
    shape: 'metric',
    detail: cmp.passed ? `metric ${cmp.detail}` : `metric ${cmp.detail} did not hold`,
    checks: [{ check, passed: cmp.passed, outcome: cmp.detail }],
  };
}

export interface ChecklistItem {
  line: number;
  text: string;
  checked: boolean;
  /** A backticked span, or `evidence: …`. `null` means the item may not count as done. */
  evidence: string | null;
}

const CHECKBOX_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * Parse `- [x] item — evidence` lines, ignoring anything inside a fenced code block.
 *
 * A checklist item's evidence is a backticked command/artifact or an explicit `evidence:` clause.
 * That is the whole enforcement of "an item without evidence may not be added": the parser cannot
 * stop an agent from writing one, so the evaluator refuses to accept it as done.
 */
export function parseChecklist(markdown: string): ChecklistItem[] {
  const out: ChecklistItem[] = [];
  let fence = false;
  const lines = markdown.split('\n');
  for (const [i, raw] of lines.entries()) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (FENCE_RE.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = CHECKBOX_RE.exec(line);
    if (!m) continue;
    const text = (m[2] ?? '').trim();
    const backtick = /`([^`]+)`/.exec(text);
    const explicit = /\bevidence:\s*([^—|\n]+)/i.exec(text);
    out.push({
      line: i + 1,
      text,
      checked: (m[1] ?? '').toLowerCase() === 'x',
      // The **explicit** clause wins over a backticked span anywhere in the line. It exists to be
      // unambiguous, and the old precedence made it the weaker of the two: an item with a backticked path
      // *and* `evidence: cmd:npm test` resolved to the path, discarding the declaration the author wrote
      // for exactly this reason — so the verdict checked something nobody declared.
      evidence: (explicit?.[1] ?? backtick?.[1] ?? '').trim() || null,
    });
  }
  return out;
}

async function evaluateChecklist(root: string, file: string, deps: EvalDeps): Promise<DoneVerdict> {
  const readFile = deps.readFile ?? defaultReadFile;
  const inside = staysInsideRoot(root, file);
  if (!inside.ok) {
    return {
      passed: false,
      shape: 'checklist',
      detail: `${file} points outside the project`,
      checks: [{ check: file, passed: false, outcome: 'checklist outside the project' }],
    };
  }
  const abs = inside.resolved;
  const text = await readFile(abs);

  if (text === null) {
    return {
      passed: false,
      shape: 'checklist',
      detail: `${file} is missing or unreadable`,
      checks: [{ check: file, passed: false, outcome: 'checklist not readable' }],
    };
  }

  const items = parseChecklist(text);
  if (items.length === 0) {
    return {
      passed: false,
      shape: 'checklist',
      detail: `${file} has no checklist items — an empty list is not evidence`,
      checks: [{ check: file, passed: false, outcome: 'no items' }],
    };
  }

  const pathExists = deps.pathExists ?? defaultPathExists;
  const run = deps.run ?? defaultRun;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;

  const checks: EvalCheck[] = [];
  for (const item of items) {
    const label = `L${item.line} ${item.text}`;
    if (!item.checked) {
      checks.push({ check: label, passed: false, outcome: 'unchecked' });
      continue;
    }
    const spec = item.evidence === null ? null : parseEvidence(item.evidence);
    if (spec === null) {
      checks.push({ check: label, passed: false, outcome: 'no evidence' });
      continue;
    }
    if (spec.kind === 'path') {
      const inside = staysInsideRoot(root, spec.value);
      if (!inside.ok) {
        checks.push({
          check: label,
          passed: false,
          outcome: `evidence points outside the project: ${spec.value}`,
        });
        continue;
      }
      const exists = await pathExists(inside.resolved);
      checks.push({
        check: label,
        passed: exists,
        outcome: exists ? `path exists: ${spec.value}` : `path missing: ${spec.value}`,
      });
      continue;
    }
    const result = await run(spec.value, root, timeoutMs);
    const passed = result.code === 0;
    checks.push({
      check: label,
      passed,
      outcome: passed
        ? `exit 0: ${spec.value}`
        : result.timedOut
          ? `timed out: ${spec.value}`
          : `exit ${result.code ?? 'null'}: ${spec.value}`,
    });
  }

  const failed = checks.filter((c) => !c.passed);
  return {
    passed: failed.length === 0,
    shape: 'checklist',
    detail:
      failed.length === 0
        ? `${checks.length}/${checks.length} checklist items carry verified evidence`
        : `${failed.length}/${checks.length} checklist item(s) incomplete: ${failed
            .map((c) => `${c.check} (${c.outcome})`)
            .join('; ')}`,
    checks,
  };
}
