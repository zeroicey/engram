import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runCli, sandbox, seedBank, type Sandbox } from './helpers.js';
import { handoffPrompt, runGoalHandoff, successorWorkspace, successorLabel } from '../src/commands/goal.js';
import { readGoalRecord } from '../src/core/goal-store.js';
import {
  createdPaneId,
  createdTabId,
  herdrAgentStartArgs,
  herdrPaneGetArgs,
  herdrTabCreateArgs,
  paneWorkspaceId,
  startedSessionPath,
  stringAt,
  type HerdrRun,
} from '../src/core/herdr.js';

/**
 * M4: the handoff — open a successor *window* through herdr and move the baton into it.
 *
 * The risky parts are the *ordering* and the failure edges, not the happy path: a handoff that
 * transfers the baton before the successor can receive a brief orphans the goal, and one that prompts
 * before transferring gets the successor's first turn refused as an intruder's. Both are asserted
 * here, along with the rule that nothing opens a pane outside herdr.
 */

// The real shapes, captured from herdr on 2026-10-18. The tab one is from an actual
// `herdr tab create --no-focus` probe that was closed immediately after; a hand-written fixture would
// have encoded my guess instead of the runtime's answer.
const TAB_REPLY = {
  id: 'cli:tab:create',
  result: {
    root_pane: {
      agent_status: 'unknown',
      cwd: '/data/dev/engram',
      focused: false,
      foreground_cwd: '/data/dev/engram',
      pane_id: 'wN:p1M',
      revision: 0,
      tab_id: 'wN:t1C',
      workspace_id: 'wN',
    },
    tab: {
      agent_status: 'unknown',
      focused: false,
      label: 'goal-2026-10-18-ship-m4',
      number: 2,
      pane_count: 1,
      tab_id: 'wN:t1C',
      workspace_id: 'wN',
    },
    type: 'tab_created',
  },
};

/** `pane get` on the pane that holds the baton — read only for its workspace. */
const PANE_GET_REPLY = {
  id: 'cli:pane:get',
  result: {
    pane: {
      agent: 'pi',
      pane_id: 'w13:p1',
      tab_id: 'w13:t1',
      workspace_id: 'w13',
      cwd: '/data/dev/engram',
      focused: false,
      label: 'engram',
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

test('the successor opens as a tab, not a split, and the tab names its goal', () => {
  // The reason is the human's experience, measured: a handoff used to split the holder's pane to the
  // right, so every handoff made that window one column narrower and dropped the successor beside a
  // transcript it shares no context with. A tab is a window of its own in the same workspace.
  assert.deepEqual(herdrTabCreateArgs('w13', '/data/dev/engram', 'goal-ship-m4'), [
    'tab',
    'create',
    '--workspace',
    'w13',
    '--cwd',
    '/data/dev/engram',
    '--label',
    'goal-ship-m4',
    '--no-focus',
  ]);
  assert.deepEqual(herdrPaneGetArgs('w13:p1'), ['pane', 'get', 'w13:p1']);
  // `-- --approve` is pi's project-trust grant: a successor's directory is fresh to pi, and its first
  // run otherwise stops at "Trust project folder?" and never becomes ready (measured: `agent start`
  // times out and the handoff fails with no session).
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
    '--',
    '--approve',
  ]);
});

test('the successor window, its pane, its tab and the session file come out of herdr’s own answers', () => {
  assert.equal(createdPaneId(TAB_REPLY), 'wN:p1M', 'the root pane of the new tab is where the agent goes');
  assert.equal(createdTabId(TAB_REPLY), 'wN:t1C');
  assert.equal(paneWorkspaceId(PANE_GET_REPLY), 'w13');
  assert.equal(startedSessionPath(START_REPLY), '/home/oicey/.pi/agent/sessions/--data-dev-engram--/2026-10-18T13-39-49-337Z_01a14f3d.jsonl');
  // An unexpected shape is `null`, not a thrown TypeError that reads as "engram is broken".
  assert.equal(createdPaneId({ result: { type: 'pane_info' } }), null);
  assert.equal(createdTabId({ result: {} }), null);
  assert.equal(paneWorkspaceId({ result: { pane: {} } }), null);
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

/** A herdr whose JSON verbs answer with the captured shapes. */
function fakeHerdr(): { calls: string[][]; deps: { run: (argv: string[]) => Promise<HerdrRun> } } {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      run: async (argv: string[]): Promise<HerdrRun> => {
        calls.push(argv);
        if (argv[0] === 'pane' && argv[1] === 'get') return { status: 0, stdout: JSON.stringify(PANE_GET_REPLY), error: null };
        if (argv[0] === 'tab' && argv[1] === 'create') return { status: 0, stdout: JSON.stringify(TAB_REPLY), error: null };
        if (argv[0] === 'agent' && argv[1] === 'start') return { status: 0, stdout: JSON.stringify(START_REPLY), error: null };
        return { status: 0, stdout: '{"result":{}}', error: null };
      },
    },
  };
}

test('a handoff opens a window, starts pi, transfers the baton, then prompts', async () => {
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
      ['pane get', 'tab create', 'agent start', 'agent prompt'],
    );
    assert.equal(herdr.calls[0]?.[2], pane, 'the holder\'s pane is read for its workspace');
    assert.deepEqual(herdr.calls[1]?.slice(2, 4), ['--workspace', 'w13'], 'the successor lands in the same workspace');
    assert.deepEqual(herdr.calls[1]?.slice(4, 6), ['--cwd', sb.root]);
    // Date-agnostic: the goal id is dated *today*, and the fixture's `2026-10-18` made this test fail on
    // the 19th. Assert the shape, not the calendar.
    assert.match(
      herdr.calls[1]?.join(' ') ?? '',
      /--label goal-\d{4}-\d{2}-\d{2}-ship-m4/,
      'a window with no name is a number in the tab bar',
    );
    assert.ok(herdr.calls[1]?.includes('--no-focus'), 'a handoff must not steal the keyboard');
    assert.match(String(herdr.calls[2]?.[2]), /^goal-\d{4}-\d{2}-\d{2}-ship-m4$/, 'the agent name matches the tab label');
    assert.equal(herdr.calls[3]?.[2], 'wN:p1M', 'the brief goes to the pane that was just created');
    assert.match(herdr.calls[3]?.[3] ?? '', /taking the baton for the long-running goal/);

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

test('a window that cannot be opened keeps the request on the record, so the stale escalation still applies', async () => {
  const { sb, id, holder } = await goalWithBaton();
  try {
    const calls: string[][] = [];
    const r = await runGoalHandoff({
      root: sb.root,
      id,
      sessionPath: holder,
      env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w13' },
      herdr: {
        run: async (argv) => {
          calls.push(argv);
          if (argv[0] === 'pane' && argv[1] === 'get') return { status: 0, stdout: JSON.stringify(PANE_GET_REPLY), error: null };
          return { status: 2, stdout: '', error: 'no space for a new window' };
        },
      },
    });
    assert.equal(r.exitCode, 1);
    assert.match(r.lines.join('\n'), /could not open a successor window/);
    assert.match(r.lines.join('\n'), /stale-handoff escalation still applies/);
    assert.deepEqual(
      calls.map((c) => c.slice(0, 2).join(' ')),
      ['pane get', 'tab create'],
      'no agent is started with nowhere to put it',
    );
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
          if (argv[0] === 'pane' && argv[1] === 'get') return { status: 0, stdout: JSON.stringify(PANE_GET_REPLY), error: null };
          if (argv[0] === 'tab') return { status: 0, stdout: JSON.stringify(TAB_REPLY), error: null };
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
  const src = goalExtensionSource({ engramBin: 'engram', engramFallback: [], version: '0.5.0', reminderPercent: 85 });
  assert.match(src, /res\.reason === "handoff requested"/);
  assert.match(src, /"goal",\s*"handoff",\s*"--json"/);
  assert.match(src, /handoff was NOT taken/);
});

// ------------------------------------------------------------------ the workspace rule

test('the successor window is pinned to this project’s space, from three sources', () => {
  // One herdr space is one project (`successorWorkspace`), so this is the rule that keeps a handoff from
  // opening a window in another project. The environment wins because it is *this session's* space.
  assert.deepEqual(
    successorWorkspace({ env: { HERDR_WORKSPACE_ID: 'w13' }, paneWorkspace: 'w13' }),
    { workspace: 'w13', detail: 'workspace w13 (from the pane environment)' },
  );
  // No environment (an older herdr, a hand-driven call): the baton's own pane is read instead.
  assert.deepEqual(successorWorkspace({ env: {}, paneWorkspace: 'w14' }), {
    workspace: 'w14',
    detail: "workspace w14 (from the baton's pane)",
  });
  // Neither: REFUSE. `tab create` without `--workspace` targets the *focused* space, and a goal whose
  // successor appears in whatever project the human last clicked is the failure this rule exists for.
  const none = successorWorkspace({ env: {}, paneWorkspace: null });
  assert.equal(none.workspace, null);
  assert.match(none.detail, /cannot tell which herdr workspace/);
  // A disagreement is reported, not buried: it means the goal was created in a different window.
  const split = successorWorkspace({ env: { HERDR_WORKSPACE_ID: 'w13' }, paneWorkspace: 'w14' });
  assert.equal(split.workspace, 'w13', 'this session decides where its own successor goes');
  assert.match(split.detail, /this session is in w13 but the baton's pane is in w14/);
});

test('a handoff never opens a window when the workspace cannot be determined', async () => {
  const { sb, id, holder } = await goalWithBaton();
  try {
    const calls: string[][] = [];
    const r = await runGoalHandoff({
      root: sb.root,
      id,
      sessionPath: holder,
      // The environment says nothing, and the pane cannot be read: nothing may be opened.
      env: { HERDR_ENV: '1' },
      herdr: {
        run: async (argv): Promise<HerdrRun> => {
          calls.push(argv);
          return { status: 1, stdout: '', error: 'pane not found' };
        },
      },
    });
    assert.equal(r.exitCode, 1);
    assert.match(r.lines.join('\n'), /could not place the successor window/);
    assert.match(r.lines.join('\n'), /another project/);
    assert.deepEqual(
      calls.map((c) => c.slice(0, 2).join(' ')),
      ['pane get'],
      'tab create must never run without a workspace: it would use the focused one',
    );
    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.baton?.sessionPath, holder, 'the baton does not move on a refusal');
    assert.notEqual(after.record?.pendingHandoff, null, 'the request stays, so the stale escalation applies');
  } finally {
    await sb.cleanup();
  }
});

test('a window whose agent never started is closed again, so no empty window is left behind', async () => {
  const { sb, id, holder } = await goalWithBaton();
  try {
    const calls: string[][] = [];
    const r = await runGoalHandoff({
      root: sb.root,
      id,
      sessionPath: holder,
      env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w13' },
      herdr: {
        run: async (argv): Promise<HerdrRun> => {
          calls.push(argv);
          if (argv[0] === 'pane' && argv[1] === 'get') return { status: 0, stdout: JSON.stringify(PANE_GET_REPLY), error: null };
          if (argv[0] === 'tab' && argv[1] === 'create') return { status: 0, stdout: JSON.stringify(TAB_REPLY), error: null };
          // `agent start` answers without a session path — what a first run in an untrusted directory
          // does, because pi stops at "Trust project folder?" and never becomes ready.
          if (argv[0] === 'agent' && argv[1] === 'start') return { status: 0, stdout: '{"result":{}}', error: null };
          return { status: 0, stdout: '{"result":{"type":"ok"}}', error: null };
        },
      },
    });
    assert.equal(r.exitCode, 1);
    assert.deepEqual(
      calls.map((c) => c.slice(0, 2).join(' ')),
      ['pane get', 'tab create', 'agent start', 'tab close'],
      'the window is undone rather than left in the tab bar',
    );
    assert.equal(calls[3]?.[2], 'wN:t1C', 'the tab that was just created is the one closed');
    assert.match(r.lines.join('\n'), /window wN:t1C closed again/);
    assert.match(r.lines.join('\n'), /Trust project folder/);
    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.baton?.sessionPath, holder, 'the baton never moved');
  } finally {
    await sb.cleanup();
  }
});

test('a pinned workspace overrides the environment, for a human fixing a mismatch', async () => {
  const { sb, id, holder } = await goalWithBaton();
  try {
    const herdr = fakeHerdr();
    const r = await runGoalHandoff({
      root: sb.root,
      id,
      sessionPath: holder,
      workspaceId: 'w99',
      env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w13' },
      herdr: herdr.deps,
    });
    assert.equal(r.exitCode, 0, r.lines.join('\n'));
    assert.deepEqual(herdr.calls[1]?.slice(2, 4), ['--workspace', 'w99']);
    assert.match(r.lines.join('\n'), /workspace w99 \(pinned by --workspace\)/);
  } finally {
    await sb.cleanup();
  }
});
