import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli, sandbox, seedBank } from './helpers.js';

/**
 * `engram goal …` end to end, through `main()`.
 *
 * These are the tests that would have caught M1 shipping as a library with no verbs: the reducer was
 * green, the evaluator was green, and nothing could create a goal, declare a verdict, or deliver a
 * wake. Every case here drives the CLI the way a human or an adapter would.
 *
 * `runCli` deletes the runtime identity variables unless a test passes them, so a goal created here
 * is unowned unless the test says otherwise — see the helper for why that matters.
 */

async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return runCli(args);
}

/** A sandbox with a bank, so `dump` has something to read. */
async function bank(): Promise<Awaited<ReturnType<typeof sandbox>>> {
  const sb = await sandbox('engram-goal-');
  await seedBank(sb);
  return sb;
}

test('goal new creates the directory, the brief and the record', async () => {
  const sb = await bank();
  try {
    const r = await run(['goal', 'new', 'migrate', 'the', 'api', '--root', sb.root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /created \.ai\/goal\/\d{4}-\d{2}-\d{2}-migrate-the-api\//);
    const ids = await sb.list('.ai/goal');
    assert.equal(ids.length, 1);
    // Date-agnostic, and not `x || true`: the literal date this used to name was wrong (the id is
    // dated *today*) and `|| true` is tautologically true, so deleting the brief scaffold entirely
    // would still have passed this line.
    const id = ids[0] ?? '';
    assert.equal(await sb.exists(`.ai/goal/${id}/BRIEF.md`), true, 'the brief is scaffolded');
    assert.match(await sb.read(`.ai/goal/${id}/BRIEF.md`), /## Done when/);
  } finally {
    await sb.cleanup();
  }
});

test('a second goal is refused while one is open', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'first', '--root', sb.root]);
    const second = await run(['goal', 'new', 'second', '--root', sb.root]);
    assert.equal(second.code, 1);
    assert.match(second.out, /one goal per project/);
    assert.equal((await sb.list('.ai/goal')).length, 1, 'nothing was created');
  } finally {
    await sb.cleanup();
  }
});

test('--cmd declares a verdict and check runs it', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'keep green', '--cmd', 'true', '--root', sb.root]);
    const r = await run(['goal', 'check', '--root', sb.root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /✅/);
    assert.match(r.out, /exit 0/);
  } finally {
    await sb.cleanup();
  }
});

test('a failing gate exits non-zero and records the failed verdict', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'never passes', '--cmd', 'false', '--root', sb.root]);
    const r = await run(['goal', 'check', '--root', sb.root]);
    assert.equal(r.code, 1);
    assert.match(r.out, /❌/);
    assert.match(r.err, /verdict-failed/);
    const ids = await sb.list('.ai/goal');
    const record = JSON.parse(await sb.read(`.ai/goal/${ids[0]}/goal.json`)) as { lastVerdict: { passed: boolean } };
    assert.equal(record.lastVerdict.passed, false);
  } finally {
    await sb.cleanup();
  }
});

test('--metric reads a JSONL log and closes the goal when the threshold holds', async () => {
  const sb = await bank();
  try {
    await sb.write('logs/train.jsonl', '{"epoch":1,"mAP":0.5}\n{"epoch":2,"mAP":0.91}\n');
    await run(['goal', 'new', 'train', '--metric', 'logs/train.jsonl:mAP:>=:0.85', '--root', sb.root]);
    const r = await run(['goal', 'check', '--root', sb.root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /0\.91 >= 0\.85/);
    const status = await run(['goal', 'status', '--root', sb.root]);
    assert.match(status.out, /most recent one .* is completed/);
  } finally {
    await sb.cleanup();
  }
});

test('--checklist creates TASKS.md and verifies evidence', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'write docs', '--checklist', '--root', sb.root]);
    const ids = await sb.list('.ai/goal');
    const tasks = `.ai/goal/${ids[0]}/TASKS.md`;
    assert.equal(await sb.exists(tasks), true);

    const pending = await run(['goal', 'check', '--root', sb.root]);
    assert.equal(pending.code, 1, 'the scaffolded item is unchecked');

    await sb.write('docs/goal.md', '# goal\n');
    await sb.write(tasks, '- [x] wrote the docs — `docs/goal.md`\n');
    const done = await run(['goal', 'check', '--root', sb.root]);
    assert.equal(done.code, 0);
    assert.match(done.out, /path exists: docs\/goal\.md/);
  } finally {
    await sb.cleanup();
  }
});

test('check refuses to guess when the brief has no verdict', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'unclassified', '--root', sb.root]);
    const r = await run(['goal', 'check', '--root', sb.root]);
    assert.equal(r.code, 1);
    assert.match(r.out, /no ```json block|no done_when/);
  } finally {
    await sb.cleanup();
  }
});

test('a wake is addressed to the goal and names the delivery', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'wait for training', '--cmd', 'true', '--root', sb.root]);
    const ids = await sb.list('.ai/goal');
    const id = ids[0] ?? '';

    // Latch a wait by writing the record the way the adapter would after a `wait` report.
    const recordPath = `.ai/goal/${id}/goal.json`;
    const record = JSON.parse(await sb.read(recordPath)) as Record<string, unknown>;
    record.status = 'waiting';
    record.wake = {
      token: 'wake-1',
      condition: { kind: 'process', pid: 42 },
      requestedAt: '2026-10-18T10:00:00.000Z',
      deadlineAt: '2026-10-19T10:00:00.000Z',
      handled: false,
    };
    await sb.write(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const r = await run(['goal', 'wake', '--reason', 'pid 42 exited', '--root', sb.root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /wake wake-1 accepted/);
    assert.match(r.out, /herdr agent prompt/, 'the wake says how to deliver itself');

    const again = await run(['goal', 'wake', '--reason', 'pid 42 exited', '--root', sb.root]);
    assert.match(again.out, /ignored/, 'a duplicate wake must not double-charge');
  } finally {
    await sb.cleanup();
  }
});

test('baton transfers and status names the holder', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'handoff me', '--cmd', 'true', '--root', sb.root]);
    const r = await run(['goal', 'baton', '--session', '/sessions/two.jsonl', '--pane', 'pane-7', '--root', sb.root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /baton none → \/sessions\/two\.jsonl/);
    const status = await run(['goal', 'status', '--root', sb.root]);
    assert.match(status.out, /\/sessions\/two\.jsonl @ pane-7/);
  } finally {
    await sb.cleanup();
  }
});

test('close is explicit and completed is unreachable from the CLI', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'stop me', '--cmd', 'true', '--root', sb.root]);
    const closed = await run(['goal', 'close', '--abandoned', '--root', sb.root]);
    assert.equal(closed.code, 0);
    assert.match(closed.out, /\(abandoned\)/);
    const ids = await sb.list('.ai/goal');
    const record = JSON.parse(await sb.read(`.ai/goal/${ids[0]}/goal.json`)) as { closeReason: string };
    assert.equal(record.closeReason, 'abandoned', 'only an observed verdict may claim completed');
  } finally {
    await sb.cleanup();
  }
});

test('an active goal reaches the fingerprint, above the binding decisions', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'ship the goal engine', '--cmd', 'npm test', '--root', sb.root]);
    const r = await run(['dump', '--root', sb.root]);
    assert.equal(r.code, 0);
    assert.match(r.out, /^GOAL$/m);
    assert.match(r.out, /verdict: cmd: npm test/);
    // A fresh session must see the goal before it sees what it is bound by.
    assert.ok(r.out.indexOf('GOAL') < r.out.indexOf('BINDING'), 'GOAL outranks BINDING');
  } finally {
    await sb.cleanup();
  }
});

test('an unclassified goal is visible in the fingerprint as a warning, not silence', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'no verdict yet', '--root', sb.root]);
    const r = await run(['dump', '--root', sb.root]);
    // Both halves, not an alternation that any "not declared" text satisfies. And NOT the ⚠ branch:
    // a freshly scaffolded brief is unclassified by design, not broken.
    assert.match(r.out, /^GOAL$/m);
    assert.match(r.out, /verdict: not declared — classify before working/);
    assert.doesNotMatch(r.out, /verdict: ⚠/);
  } finally {
    await sb.cleanup();
  }
});

test('goal status names the most recent closed goal instead of pretending there is none', async () => {
  const sb = await bank();
  try {
    await run(['goal', 'new', 'one', '--cmd', 'true', '--root', sb.root]);
    await run(['goal', 'close', '--root', sb.root]);
    const r = await run(['goal', 'status', '--root', sb.root]);
    assert.equal(r.code, 1);
    assert.match(r.out, /is cancelled since/);
  } finally {
    await sb.cleanup();
  }
});

test('the goal verbs appear in --help', async () => {
  const r = await run(['--help']);
  assert.match(r.out, /engram goal <verb>/);
  assert.match(r.out, /A goal is judged, not asserted/);
});
