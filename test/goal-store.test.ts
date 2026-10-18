import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeGoal,
  damagedGoals,
  listGoalIds,
  newGoalId,
  parseBrief,
  parseDoneWhen,
  parseGoalRecord,
  readGoalBrief,
  readGoalRecord,
  serializeGoalRecord,
  writeGoalRecord,
} from '../src/core/goal-store.js';
import {
  compareMetric,
  evaluateDoneWhen,
  parseChecklist,
  parseEvidence,
  readMetric,
  staysInsideRoot,
  readPath,
} from '../src/core/goal-eval.js';
import { newGoalRecord, type DoneWhen, type GoalRecord } from '../src/core/goal.js';
import { sandbox } from './helpers.js';

/**
 * The goal store and the `done_when` evaluator.
 *
 * Two properties matter more than the happy path: a malformed project-owned file must produce a
 * *specific* error instead of an exception (the engine runs inside `agent_settled`), and the
 * evaluator must never pass vacuously — an empty command list, an empty checklist and a missing
 * artifact all have to read as "not done".
 */

const T0 = '2026-10-18T10:00:00.000Z';

const record = (over: Partial<GoalRecord> = {}): GoalRecord => ({
  ...newGoalRecord({ id: 'g', goal: 'ship it', now: T0 }),
  ...over,
});

// ---------------------------------------------------------------- parseDoneWhen

test('parseDoneWhen accepts the three shapes and rejects the near-misses', () => {
  assert.deepEqual(parseDoneWhen({ kind: 'cmd', commands: ['npm test', 'npm run typecheck'] }), {
    doneWhen: { kind: 'cmd', commands: ['npm test', 'npm run typecheck'] },
    error: null,
  });
  assert.match(parseDoneWhen({ kind: 'cmd', commands: [] }).error ?? '', /non-empty/);
  assert.match(parseDoneWhen({ kind: 'cmd' }).error ?? '', /non-empty/);

  assert.deepEqual(parseDoneWhen({ kind: 'metric', file: 'out.json', path: 'a.b', op: '>=', value: 0.8 }), {
    doneWhen: { kind: 'metric', file: 'out.json', path: 'a.b', op: '>=', value: 0.8 },
    error: null,
  });
  assert.match(parseDoneWhen({ kind: 'metric', file: 'f', path: 'a', op: '~=', value: 1 }).error ?? '', /op/);
  assert.match(parseDoneWhen({ kind: 'metric', file: 'f', path: 'a', op: '>=', value: '' }).error ?? '', /value/);
  assert.match(parseDoneWhen({ kind: 'metric', path: 'a', op: '>=', value: 1 }).error ?? '', /file/);

  assert.deepEqual(parseDoneWhen({ kind: 'checklist' }), {
    doneWhen: { kind: 'checklist', file: 'TASKS.md' },
    error: null,
  });
  assert.deepEqual(parseDoneWhen({ kind: 'checklist', file: 'MY.md' }).doneWhen, { kind: 'checklist', file: 'MY.md' });
  assert.match(parseDoneWhen({ kind: 'vibes' }).error ?? '', /kind/);
  assert.match(parseDoneWhen(null).error ?? '', /object/);
});

// ---------------------------------------------------------------- parseBrief

test('parseBrief reads the first fenced JSON block under a "Done when" heading', () => {
  const md = [
    '# Ship the thing',
    '',
    'Some prose with a ```json block that is not under the heading.',
    '',
    '## Done when',
    '',
    '```json',
    '{ "kind": "cmd", "commands": ["npm test"] }',
    '```',
    '',
    '## Notes',
    '',
    'Other things.',
  ].join('\n');
  assert.deepEqual(parseBrief(md).doneWhen, { kind: 'cmd', commands: ['npm test'] });
  assert.equal(parseBrief(md).error, null);
});

test('parseBrief distinguishes "not declared yet" from "broken"', () => {
  assert.deepEqual(parseBrief('# Goal\n\nnothing here\n'), {
    doneWhen: null,
    error: 'BRIEF.md has no "## Done when" section',
  });
  // A heading with no block is "not declared yet", which is exactly what `engram goal new`
  // scaffolds: the first run is meant to classify it. Reporting a parse error there put a ⚠ in the
  // fingerprint of every fresh goal.
  assert.deepEqual(parseBrief('## Done when\n\nno fence here\n'), { doneWhen: null, error: null });
  assert.match(parseBrief('## Done when\n\n```json\n{ oops }\n```\n').error ?? '', /not valid JSON/);
  assert.match(parseBrief('## Done when\n\n```json\n{"kind":"cmd","commands":[]}\n```\n').error ?? '', /non-empty/);
});

// ---------------------------------------------------------------- parseGoalRecord

test('a record survives a serialize/parse round trip', () => {
  const r = record({
    status: 'waiting',
    wake: { token: 'wake-2', condition: { kind: 'artifact', path: 'out/x.json' }, requestedAt: T0, deadlineAt: T0, handled: false },
    wakeSeq: 2,
    blocker: null,
    lastNote: 'waiting on the eval',
    rounds: 4,
  });
  const parsed = parseGoalRecord(serializeGoalRecord(r));
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.record, r);
});

test('a hand-edited record is repaired, not rejected', () => {
  const parsed = parseGoalRecord('{"id":"g","goal":"x","status":"running","createdAt":"2026-10-18T10:00:00.000Z"}');
  assert.equal(parsed.error, null);
  assert.equal(parsed.record?.rounds, 0);
  assert.equal(parsed.record?.pendingWakes.length, 0);
  assert.equal(parsed.record?.baton, null);
});

test('an unreadable record says which field is wrong', () => {
  assert.match(parseGoalRecord('{ nope').error ?? '', /not valid JSON/);
  assert.match(parseGoalRecord('[]').error ?? '', /JSON object/);
  assert.match(parseGoalRecord('{"goal":"x","status":"running"}').error ?? '', /"id"/);
  assert.match(parseGoalRecord('{"id":"g","status":"running"}').error ?? '', /"goal"/);
  assert.match(parseGoalRecord('{"id":"g","goal":"x","status":"paused"}').error ?? '', /"status"/);
});

test('a BOM does not make the record unreadable', () => {
  const parsed = parseGoalRecord(`\uFEFF${serializeGoalRecord(record())}`);
  assert.equal(parsed.error, null);
  assert.equal(parsed.record?.id, 'g');
});

// ---------------------------------------------------------------- filesystem

test('the store creates the goal directory and reads back what it wrote', async () => {
  const sb = await sandbox();
  try {
    assert.equal(await writeGoalRecord(sb.root, record({ id: '2026-10-18-ship-it' })), true);
    const read = await readGoalRecord(sb.root, '2026-10-18-ship-it');
    assert.equal(read.error, null);
    assert.equal(read.record?.goal, 'ship it');
    assert.equal(await sb.exists('.ai/goal/2026-10-18-ship-it/goal.json'), true);
  } finally {
    await sb.cleanup();
  }
});

test('a missing brief means "not declared yet", not an error', async () => {
  const sb = await sandbox();
  try {
    assert.deepEqual(await readGoalBrief(sb.root, 'nope'), { doneWhen: null, error: null });
    await sb.write('.ai/goal/nope/BRIEF.md', '## Done when\n\n```json\n{"kind":"checklist"}\n```\n');
    assert.deepEqual((await readGoalBrief(sb.root, 'nope')).doneWhen, { kind: 'checklist', file: 'TASKS.md' });
  } finally {
    await sb.cleanup();
  }
});

test('activeGoal returns the open goal and damagedGoals names the broken ones', async () => {
  const sb = await sandbox();
  try {
    await writeGoalRecord(sb.root, record({ id: '2026-10-01-old', goal: 'old', closedAt: T0, closeReason: 'completed' }));
    await writeGoalRecord(sb.root, record({ id: '2026-10-18-new', goal: 'new' }));
    await sb.write('.ai/goal/2026-10-19-broken/goal.json', '{ nope');
    await sb.write('.ai/goal/_TEMPLATE/goal.json', '{}');

    assert.deepEqual(await listGoalIds(sb.root), ['2026-10-19-broken', '2026-10-18-new', '2026-10-01-old']);
    assert.equal((await activeGoal(sb.root))?.record.goal, 'new', 'a closed goal is not the active one');
    assert.equal((await damagedGoals(sb.root)).length, 1);
    assert.match((await damagedGoals(sb.root))[0] ?? '', /2026-10-19-broken/);
  } finally {
    await sb.cleanup();
  }
});

test('a goal id is dated like every other bank entry', () => {
  assert.equal(newGoalId('Ship the thing', '2026-10-18'), '2026-10-18-ship-the-thing');
});

// ---------------------------------------------------------------- evaluator: cmd

test('cmd passes only when every command exits 0', async () => {
  const seen: string[] = [];
  const deps = {
    run: async (command: string) => {
      seen.push(command);
      if (command === 'npm test') return { code: 1, stdout: '', stderr: '3 tests failed', timedOut: false };
      return { code: 0, stdout: 'ok', stderr: '', timedOut: false };
    },
  };
  const bad = await evaluateDoneWhen('/tmp', { kind: 'cmd', commands: ['npm test', 'npm run typecheck'] }, deps);
  assert.equal(bad.passed, false);
  assert.match(bad.detail, /3 tests failed/);
  assert.equal(bad.checks.length, 2);
  assert.deepEqual(seen, ['npm test', 'npm run typecheck'], 'every command runs, so one failure does not hide another');

  const good = await evaluateDoneWhen('/tmp', { kind: 'cmd', commands: ['npm run typecheck'] }, deps);
  assert.equal(good.passed, true);
});

test('an empty command list is not a free pass, and a timeout is a failure', async () => {
  const empty = await evaluateDoneWhen('/tmp', { kind: 'cmd', commands: [] }, { run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }) });
  assert.equal(empty.passed, false);
  assert.match(empty.detail, /no commands/);

  const slow = await evaluateDoneWhen('/tmp', { kind: 'cmd', commands: ['sleep 1'] }, {
    run: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
  });
  assert.equal(slow.passed, false);
  assert.match(slow.checks[0]?.outcome ?? '', /timed out/);
});

// ---------------------------------------------------------------- evaluator: metric

test('readPath walks objects and array indices in either spelling', () => {
  const doc = { metrics: { mAP: 0.87, perClass: [{ name: 'a', ap: 0.5 }] } };
  assert.equal(readPath(doc, 'metrics.mAP').value, 0.87);
  assert.equal(readPath(doc, 'metrics.perClass[0].ap').value, 0.5);
  assert.equal(readPath(doc, 'metrics.perClass.0.ap').value, 0.5);
  assert.equal(readPath(doc, 'metrics.nope').found, false);
  assert.equal(readPath(doc, 'metrics.perClass[4]').found, false);
});

test('a metric reads from JSON, JSONL, and CSV', () => {
  assert.deepEqual(readMetric('{"eval":{"mAP":0.87}}', 'eval.mAP'), { found: true, value: 0.87 });
  assert.deepEqual(readMetric('epoch,mAP\n1,0.5\n2,0.87\n', 'mAP'), { found: true, value: '0.87' });
  assert.equal(readMetric('epoch,mAP\n1,0.5\n', 'auroc').found, false);
  assert.equal(readMetric('not json or csv', 'mAP').found, false);
});

test('a JSONL training log resolves a bare metric to the latest record', () => {
  const log = ['{"epoch":1,"mAP":0.5}', '{"epoch":2,"mAP":0.87}'].join('\n');
  assert.deepEqual(readMetric(log, 'mAP'), { found: true, value: 0.87 }, 'the appended log is the common shape');
  assert.deepEqual(readMetric(log, 'epoch'), { found: true, value: 2 });
  assert.deepEqual(readMetric(log, '[0].mAP'), { found: true, value: 0.5 });
  assert.deepEqual(readMetric(log, '[-1].mAP'), { found: true, value: 0.87 });
  assert.deepEqual(readMetric(log, 'eval.mAP'), { found: false, value: undefined });
});

test('a CSV delimiter is detected, and a duplicated column is refused rather than guessed', () => {
  assert.deepEqual(readMetric('epoch\tmAP\n1\t0.9\n', 'mAP'), { found: true, value: '0.9' });
  assert.deepEqual(readMetric('epoch;mAP\n1;0.9\n', 'mAP'), { found: true, value: '0.9' });
  const ambiguous = readMetric('epoch,mAP,mAP\n1,0.1,0.9\n', 'mAP');
  assert.equal(ambiguous.found, false);
  assert.match(ambiguous.ambiguous ?? '', /more than once/);
});

test('the engine owns the comparison and refuses to compare non-numbers', () => {
  assert.equal(compareMetric(0.87, '>=', 0.8).passed, true);
  assert.equal(compareMetric('0.87', '>=', 0.8).passed, true, 'a CSV value arrives as a string');
  assert.equal(compareMetric(0.7, '>=', 0.8).passed, false);
  assert.equal(compareMetric('done', '==', 'done').passed, true);
  assert.equal(compareMetric('done', '!=', 'done').passed, false);
  assert.equal(compareMetric('abc', '>=', 0.8).passed, false);
  assert.match(compareMetric('abc', '>=', 0.8).detail, /not a numeric comparison/);
});

test('a metric verdict fails loudly when the artifact or the path is missing', async () => {
  const missing = await evaluateDoneWhen('/r', { kind: 'metric', file: 'out.json', path: 'mAP', op: '>=', value: 0.8 }, {
    readFile: async () => null,
  });
  assert.equal(missing.passed, false);
  assert.match(missing.detail, /missing or unreadable/);

  const absent = await evaluateDoneWhen('/r', { kind: 'metric', file: 'out.json', path: 'mAP', op: '>=', value: 0.8 }, {
    readFile: async () => '{"other":1}',
  });
  assert.equal(absent.passed, false);
  assert.match(absent.detail, /not found/);
});

// ---------------------------------------------------------------- evaluator: checklist

test('parseChecklist finds items, ignores fenced examples, and needs evidence', () => {
  const md = [
    '# Tasks',
    '',
    '- [x] wire the CLI — `npm test`',
    '- [ ] add the docs — evidence: docs/goal.md',
    '- [x] no evidence here',
    '',
    '```md',
    '- [x] an example inside a fence — `not evidence`',
    '```',
  ].join('\n');
  const items = parseChecklist(md);
  assert.equal(items.length, 3, 'the fenced example is not an item');
  assert.equal(items[0]?.evidence, 'npm test');
  assert.equal(items[1]?.evidence, 'docs/goal.md');
  assert.equal(items[2]?.evidence, null);
});

test('a checklist passes only when every item is checked and its evidence verifies', async () => {
  // Evidence is now checked, not merely present: a path must exist, a command must exit 0.
  const deps = (text: string, opts: { exists?: string[]; failCmd?: string[] } = {}) => ({
    readFile: async () => text,
    pathExists: async (f: string) => (opts.exists ?? ['/r/docs/x.md']).includes(f),
    run: async (cmd: string) => ({
      code: (opts.failCmd ?? []).includes(cmd) ? 1 : 0,
      stdout: '',
      stderr: '',
      timedOut: false,
    }),
  });

  const good = await evaluateDoneWhen('/r', { kind: 'checklist', file: 'TASKS.md' }, deps('- [x] a — `npm test`\n- [x] b — `docs/x.md`\n'));
  assert.equal(good.passed, true);

  const unchecked = await evaluateDoneWhen('/r', { kind: 'checklist', file: 'TASKS.md' }, deps('- [x] a — `npm test`\n- [ ] b — `docs/x.md`\n'));
  assert.equal(unchecked.passed, false);
  assert.match(unchecked.detail, /unchecked/);

  const noEvidence = await evaluateDoneWhen('/r', { kind: 'checklist', file: 'TASKS.md' }, deps('- [x] a\n'));
  assert.equal(noEvidence.passed, false);
  assert.match(noEvidence.detail, /no evidence/);

  const empty = await evaluateDoneWhen('/r', { kind: 'checklist', file: 'TASKS.md' }, deps('# Tasks\n\nnothing\n'));
  assert.equal(empty.passed, false);
  assert.match(empty.detail, /no checklist items/);

  const unreadable = await evaluateDoneWhen('/r', { kind: 'checklist', file: 'TASKS.md' }, { readFile: async () => null });
  assert.equal(unreadable.passed, false);
  assert.match(unreadable.detail, /missing or unreadable/);
});

test('a backticked claim that cannot be verified does not count as evidence', async () => {
  const text = '- [x] refactored everything — `echo hi`\n';
  // The command runs and exits 0, so this one legitimately passes — but the *path* case must fail.
  const lying = await evaluateDoneWhen('/r', { kind: 'checklist', file: 'TASKS.md' }, {
    readFile: async () => text,
    run: async () => ({ code: 1, stdout: '', stderr: 'nope', timedOut: false }),
  });
  assert.equal(lying.passed, false, 'a command that exits non-zero is not evidence');
  assert.match(lying.checks[0]?.outcome ?? '', /exit 1/);

  const missing = await evaluateDoneWhen('/r', { kind: 'checklist', file: 'TASKS.md' }, {
    readFile: async () => '- [x] wrote the docs — `docs/never-written.md`\n',
    pathExists: async () => false,
  });
  assert.equal(missing.passed, false);
  assert.match(missing.checks[0]?.outcome ?? '', /path missing/);
});

test('an evidence string is classified deterministically', () => {
  assert.deepEqual(parseEvidence('npm test'), { kind: 'cmd', value: 'npm test' });
  assert.deepEqual(parseEvidence('docs/goal.md'), { kind: 'path', value: 'docs/goal.md' });
  assert.deepEqual(parseEvidence('path:out/eval.json'), { kind: 'path', value: 'out/eval.json' });
  assert.deepEqual(parseEvidence('cmd:git diff --quiet'), { kind: 'cmd', value: 'git diff --quiet' });
  assert.equal(parseEvidence('   '), null);
});

test('a declared path may not point outside the project', async () => {
  // `done_when.file` and checklist evidence are project-owned text, but a typo — or a model that has
  // been talked into it — can name ../../../etc/passwd. The engine judges the project, it does not
  // read the machine: before this guard, `readFile` was called with `/etc/passwd` and a checklist item
  // pointing there PASSED on any machine where the file exists.
  const touched: string[] = [];
  const deps = {
    readFile: async (f: string) => {
      touched.push(f);
      return null;
    },
    pathExists: async (f: string) => {
      touched.push(f);
      return true;
    },
  };

  const metric = await evaluateDoneWhen('/repo', { kind: 'metric', file: '../../../etc/passwd', path: 'root', op: '==', value: 'x' }, deps);
  assert.equal(metric.passed, false);
  assert.match(metric.detail, /outside the project/);
  // `.length`, not `deepEqual(touched, [])`: the assertion signature narrows `touched` to `never[]`,
  // so the later `touched.push(...)` stops compiling.
  assert.equal(touched.length, 0, 'nothing outside the root may be read at all');

  const checklist = await evaluateDoneWhen('/repo', { kind: 'checklist', file: 'T.md' }, {
    readFile: async () => '- [x] escape — `../../../../etc/passwd`\n',
    pathExists: async (f: string) => {
      touched.push(f);
      return true;
    },
  });
  assert.equal(checklist.passed, false, 'a path outside the project is not evidence');
  assert.match(checklist.checks[0]?.outcome ?? '', /outside the project/);
});

test('staysInsideRoot accepts a subdirectory and refuses a sibling with the same prefix', () => {
  assert.equal(staysInsideRoot('/repo', 'out/eval.json').ok, true);
  assert.equal(staysInsideRoot('/repo', './out/../docs/x.md').ok, true, 'normalisation runs before the check');
  assert.equal(staysInsideRoot('/repo', '../repo-evil/x.md').ok, false, 'a shared prefix is not containment');
  assert.equal(staysInsideRoot('/repo', '/etc/passwd').ok, false, 'an absolute path outside the root is refused');
  assert.equal(staysInsideRoot('/repo', '/repo/out/x.json').ok, true, 'an absolute path inside the root is fine');
});

test('a whitespace-only command is not a free pass', async () => {
  // `['   ']` reached the shell, exited 0, and passed — an empty verdict by accident.
  const v = await evaluateDoneWhen('/r', { kind: 'cmd', commands: ['   ', '\t'] }, {
    run: async () => {
      throw new Error('nothing should be executed');
    },
  });
  assert.equal(v.passed, false);
  assert.match(v.detail, /no commands/);
});

test('a metric path cannot reach Object.prototype', () => {
  // `a.__proto__` and `constructor` must not resolve; a prototype walk is not a metric.
  const doc = { a: { b: 1 } };
  assert.equal(readPath(doc, 'a.__proto__').found, false);
  assert.equal(readPath(doc, 'constructor').found, false);
});

test('every shape reports the same verdict surface', async () => {
  const shapes: DoneWhen[] = [
    { kind: 'cmd', commands: ['true'] },
    { kind: 'metric', file: 'm.json', path: 'x', op: '==', value: 1 },
    { kind: 'checklist', file: 'TASKS.md' },
  ];
  for (const shape of shapes) {
    const v = await evaluateDoneWhen('/r', shape, {
      run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      readFile: async (f) => (f.endsWith('m.json') ? '{"x":1}' : '- [x] a — `npm test`\n'),
    });
    assert.equal(v.shape, shape.kind);
    assert.equal(typeof v.detail, 'string');
    assert.ok(v.checks.length > 0);
  }
});

test('a short CSV row is a failed verdict, not an undefined value', async () => {
  // `epoch,mAP\n1` is a partially written row — the mid-run artifact the JSONL widening exists for.
  // Returning `found: true, value: undefined` made `!=` pass vacuously: `String(undefined) !== '0.0'`.
  const v = await evaluateDoneWhen('/r', { kind: 'metric', file: 'o.csv', path: 'mAP', op: '!=', value: '0.0' }, {
    readFile: async () => 'epoch,mAP\n1\n',
  });
  assert.equal(v.passed, false);
  assert.match(v.detail, /row has no value/);

  // An empty cell is a real value (`0`), so it is judged, not skipped.
  const empty = await evaluateDoneWhen('/r', { kind: 'metric', file: 'o.csv', path: 'mAP', op: '>=', value: 0.8 }, {
    readFile: async () => 'epoch,mAP\n1,\n',
  });
  assert.equal(empty.passed, false);
  assert.match(empty.detail, /0 >= 0.8/);
});
