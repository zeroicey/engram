import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli, sandbox, seedBank, type Sandbox } from './helpers.js';
import { handoffPrompt, runGoalHandoff } from '../src/commands/goal.js';
import { readGoalRecord } from '../src/core/goal-store.js';
import {
  createdPaneId,
  herdrAgentStartArgs,
  herdrPaneSplitArgs,
  startedSessionPath,
  stringAt,
  type HerdrRun,
} from '../src/core/herdr.js';

/**
 * M4: the handoff — open a successor pane through herdr and move the baton into it.
 *
 * The risky parts are the *ordering* and the failure edges, not the happy path: a handoff that
 * transfers the baton before the successor can receive a brief orphans the goal, and one that prompts
 * before transferring gets the successor's first turn refused as an intruder's. Both are asserted
 * here, along with the rule that nothing opens a pane outside herdr.
 */

// The real shapes, captured from herdr 0.8.2 on 2026-10-18 (a probe pane was split, started and
// closed for exactly this). A hand-written fixture would have encoded my guess instead.
const SPLIT_REPLY = {
  id: 'cli:pane:split',
  result: {
    pane: {
      agent_status: 'unknown',
      cwd: '/data/dev/engram',
      focused: false,
      pane_id: 'wN:p1M',
      tab_id: 'wN:t1C',
      workspace_id: 'wN',
    },
    type: 'pane_info',
  },
};

const START_REPLY = {
  id: 'cli:agent:start',
  result: {
    agent: {
      agent: 'pi',
      agent_session: {
        agent: 'pi',
        kind: 'path',
        source: 'herdr:pi',
        value: '/home/oicey/.pi/agent/sessions/--data-dev-engram--/2026-10-18T13-39-49-337Z_01a14f3d.jsonl',
      },
      agent_status: 'idle',
      interactive_ready: true,
      name: 'probe',
      pane_id: 'wN:p1M',
    },
    argv: ['pi'],
    type: 'agent_started',
  },
};

// ------------------------------------------------------------------ the runtime contract

test('the split names its target pane, because herdr otherwise splits whatever was focused', () => {
  assert.deepEqual(herdrPaneSplitArgs('w13:p1', '/data/dev/engram'), [
    'pane',
    'split',
    'w13:p1',
    '--direction',
    'right',
    '--cwd',
    '/data/dev/engram',
    '--no-focus',
  ]);
  assert.deepEqual(herdrAgentStartArgs('goal-x', 'pi', 'wN:p1M', 60_000), [
    'agent',
    'start',
    'goal-x',
    '--kind',
    'pi',
    '--pane',
    'wN:p1M',
    '--timeout',
    '60000',
  ]);
});

test('the successor pane and its session file come out of herdr’s own answers', () => {
  assert.equal(createdPaneId(SPLIT_REPLY), 'wN:p1M');
  assert.equal(startedSessionPath(START_REPLY), '/home/oicey/.pi/agent/sessions/--data-dev-engram--/2026-10-18T13-39-49-337Z_01a14f3d.jsonl');
  // An unexpected shape is `null`, not a thrown TypeError that reads as "engram is broken".
  assert.equal(createdPaneId({ result: { type: 'pane_info' } }), null);
  assert.equal(startedSessionPath(null), null);
  assert.equal(stringAt({ result: { pane_id: '' } }, 'result.pane_id'), null, 'an empty id is not an id');
});

test('the successor’s brief names the files it must read, not a summary of them', () => {
  const text = handoffPrompt({ id: '2026-10-18-m4', goal: 'ship M4', paneId: 'w9:p2', reason: 'context at 88%' });
  assert.match(text, /baton for the long-running goal 2026-10-18-m4/);
  assert.match(text, /context at 88%/);
  // A summary would be a second, staler copy of the bank.
  assert.match(text, /\.ai\/CURRENT_TASK\.md/);
  assert.match(text, /\.ai\/sessions\/\*-handoff\.md/);
  assert.match(text, /\.ai\/goal\/2026-10-18-m4\/BRIEF\.md/);
  assert.doesNotMatch(handoffPrompt({ id: 'x', goal: 'g', paneId: 'p' }), /handed off because/);
});

// ------------------------------------------------------------------ the command

async function goalWithBaton(): Promise<{ sb: Sandbox; id: string; holder: string; pane: string }> {
  const sb = await sandbox('engram-goal-handoff-');
  await seedBank(sb);
  const holder = '/sessions/predecessor.jsonl';
  const pane = 'w13:p1';
  const created = await runCli(['goal', 'new', 'ship M4', '--cmd', 'true', '--root', sb.root], {
    PI_SESSION_FILE: holder,
    HERDR_PANE_ID: pane,
  });
  assert.equal(created.code, 0, created.out);
  const id = ((await sb.list('.ai/goal'))[0] ?? '').replace(/\/+$/, '');
  return { sb, id, holder, pane };
}

/** A herdr whose two JSON verbs answer with the captured shapes. */
function fakeHerdr(): { calls: string[][]; deps: { run: (argv: string[]) => Promise<HerdrRun> } } {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      run: async (argv: string[]): Promise<HerdrRun> => {
        calls.push(argv);
        if (argv[0] === 'pane' && argv[1] === 'split') return { status: 0, stdout: JSON.stringify(SPLIT_REPLY), error: null };
        if (argv[0] === 'agent' && argv[1] === 'start') return { status: 0, stdout: JSON.stringify(START_REPLY), error: null };
        return { status: 0, stdout: '{"result":{}}', error: null };
      },
    },
  };
}

test('a handoff opens a pane, starts pi, transfers the baton, then prompts', async () => {
  const { sb, id, holder, pane } = await goalWithBaton();
  try {
    const herdr = fakeHerdr();
    const r = await runGoalHandoff({
      root: sb.root,
      id,
      reason: 'context is filling',
      sessionPath: holder,
      env: { HERDR_ENV: '1' },
      herdr: herdr.deps,
    });
    assert.equal(r.exitCode, 0, r.lines.join('\n'));

    // The order is the design: baton before prompt, or the successor's first turn is refused.
    assert.deepEqual(
      herdr.calls.map((c) => c.slice(0, 2).join(' ')),
      ['pane split', 'agent start', 'agent prompt'],
    );
    assert.equal(herdr.calls[0]?.[2], pane, 'it splits beside the pane that holds the baton');
    assert.equal(herdr.calls[1]?.[2], 'goal-2026-10-18-ship-m4');
    assert.equal(herdr.calls[2]?.[2], 'wN:p1M', 'the brief goes to the pane that was just created');
    assert.match(herdr.calls[2]?.[3] ?? '', /taking the baton for the long-running goal/);

    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.baton?.paneId, 'wN:p1M');
    assert.match(after.record?.baton?.sessionPath ?? '', /13-39-49-337Z/);
    // A taken handoff is not pending: leaving it set would silence the successor's loop and later
    // escalate "requested but never taken" about a handoff that was taken.
    assert.equal(after.record?.pendingHandoff, null);
    assert.match(r.lines.join('\n'), /this session must stop driving/);
  } finally {
    await sb.cleanup();
  }
});

test('outside herdr nothing is opened, and nothing is recorded as pending', async () => {
  const { sb, id, holder } = await goalWithBaton();
  try {
    const herdr = fakeHerdr();
    const r = await runGoalHandoff({ root: sb.root, id, sessionPath: holder, env: {}, herdr: herdr.deps });
    assert.equal(r.exitCode, 1);
    assert.match(r.lines.join('\n'), /a handoff needs herdr/);
    assert.deepEqual(herdr.calls, [], 'the runtime is never touched');
    // Refused *before* the record: a pending handoff that can never be taken would escalate falsely.
    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.pendingHandoff, null);
    assert.equal(after.record?.baton?.sessionPath, holder, 'the baton does not move on a refusal');
  } finally {
    await sb.cleanup();
  }
});

test('a failed split keeps the request on the record, so the stale escalation still applies', async () => {
  const { sb, id, holder } = await goalWithBaton();
  try {
    const calls: string[][] = [];
    const r = await runGoalHandoff({
      root: sb.root,
      id,
      sessionPath: holder,
      env: { HERDR_ENV: '1' },
      herdr: {
        run: async (argv) => {
          calls.push(argv);
          return { status: 2, stdout: '', error: 'no space for a new pane' };
        },
      },
    });
    assert.equal(r.exitCode, 1);
    assert.match(r.lines.join('\n'), /could not open a successor pane/);
    assert.match(r.lines.join('\n'), /stale-handoff escalation still applies/);
    assert.deepEqual(calls.map((c) => c.slice(0, 2).join(' ')), ['pane split'], 'no agent is started with nowhere to put it');
    const after = await readGoalRecord(sb.root, id);
    assert.notEqual(after.record?.pendingHandoff, null, 'the request is the evidence');
    assert.equal(after.record?.baton?.sessionPath, holder);
  } finally {
    await sb.cleanup();
  }
});

test('a successor that never received the brief does not keep the baton', async () => {
  const { sb, id, holder, pane } = await goalWithBaton();
  try {
    const r = await runGoalHandoff({
      root: sb.root,
      id,
      sessionPath: holder,
      env: { HERDR_ENV: '1' },
      herdr: {
        run: async (argv): Promise<HerdrRun> => {
          if (argv[0] === 'pane') return { status: 0, stdout: JSON.stringify(SPLIT_REPLY), error: null };
          if (argv[0] === 'agent' && argv[1] === 'start') return { status: 0, stdout: JSON.stringify(START_REPLY), error: null };
          // `agent prompt` refuses, as it does when the target is already blocked.
          return { status: 0, stdout: '{"error":{"code":"agent_blocked"}}', error: null };
        },
      },
    });
    assert.equal(r.exitCode, 1);
    assert.match(r.lines.join('\n'), /prompt NOT delivered/);
    const after = await readGoalRecord(sb.root, id);
    // An orphaned goal is worse than a failed handoff: the baton goes back to the predecessor, which
    // is why the transfer happens before the prompt and is reversible.
    assert.equal(after.record?.baton?.sessionPath, holder);
    assert.equal(after.record?.baton?.paneId, pane);
    // …but the *request* is deliberately not cleared by the rollback: it was not taken, and that is
    // the evidence the human and the stale escalation need.
    assert.notEqual(after.record?.pendingHandoff, null);
    assert.deepEqual(r.warnings, ['wN:p1M holds the baton but never received the brief']);
  } finally {
    await sb.cleanup();
  }
});

test('a session that does not hold the baton cannot hand the goal off', async () => {
  const { sb, id } = await goalWithBaton();
  try {
    const calls: string[][] = [];
    const r = await runGoalHandoff({
      root: sb.root,
      id,
      sessionPath: '/sessions/intruder.jsonl',
      env: { HERDR_ENV: '1' },
      herdr: {
        run: async (argv) => {
          calls.push(argv);
          return { status: 0, stdout: '{}', error: null };
        },
      },
    });
    assert.equal(r.exitCode, 1);
    assert.match(r.lines.join('\n'), /not the baton holder/);
    assert.deepEqual(calls, [], 'a refused handoff must not open a pane');
    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.pendingHandoff, null);
  } finally {
    await sb.cleanup();
  }
});

test('taking the baton clears a pending handoff, and says so', async () => {
  const { sb, id, holder } = await goalWithBaton();
  try {
    // Park the record the way a stale request looks: asked for, never taken.
    const path = `.ai/goal/${id}/goal.json`;
    const record = JSON.parse(await sb.read(path)) as Record<string, unknown>;
    record.pendingHandoff = { requestedAt: '2026-10-18T10:00:00.000Z', reason: 'context' };
    await sb.write(path, `${JSON.stringify(record, null, 2)}\n`);

    const r = await runCli(['goal', 'baton', '--session', '/sessions/successor.jsonl', '--pane', 'w9:p9', '--root', sb.root], {
      PI_SESSION_FILE: holder,
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /pending handoff cleared/);
    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.pendingHandoff, null);
    assert.equal(after.record?.baton?.sessionPath, '/sessions/successor.jsonl');
  } finally {
    await sb.cleanup();
  }
});

test('the extension acts on a handoff request, and reports the outcome in the tool result', async () => {
  // The generated file must call the `handoff` verb: a request the host cannot act on is the M3
  // "nothing emits it" gap in a different costume.
  const { goalExtensionSource } = await import('../src/templates/goal-extension.js');
  const src = goalExtensionSource({ engramBin: 'engram', version: '0.5.0' });
  assert.match(src, /res\.reason === "handoff requested"/);
  assert.match(src, /"goal",\s*"handoff",\s*"--json"/);
  assert.match(src, /handoff was NOT taken/);
});
