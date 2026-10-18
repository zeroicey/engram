import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runCli, sandbox, seedBank, type Sandbox } from './helpers.js';
import { identityFromEnv, resolveEngramCommand, runGoalUnit, runGoalWake } from '../src/commands/goal.js';
import { readGoalRecord } from '../src/core/goal-store.js';
import {
  engramCommand,
  goalUnitName,
  goalUnitSource,
  systemdWord,
  unitOutcome,
} from '../src/templates/systemd.js';
import { herdrPromptArgs, paneForSession, promptPane, type HerdrRun } from '../src/core/herdr.js';

/**
 * L3 of the wake transport: the systemd unit that runs a long job and wakes the goal when it exits.
 *
 * Two promises are worth testing separately, because they fail independently and one of them fails
 * *silently*:
 *
 * 1. the unit is correct — `ExecStopPost` (every exit path, not just success), an absolute engram
 *    path (a user unit has no login `PATH`), and no argument whose meaning depends on a quoting rule;
 * 2. the wake is actually delivered — a latched token that nobody is told about releases nothing,
 *    which is exactly what the goal engine looked like before this milestone.
 */

const unitCtx = {
  id: '2026-10-18-m3',
  goal: 'ship M3',
  root: '/repo',
  job: 'python train.py --epochs 40',
  engram: ['/opt/engram'],
  path: '/usr/bin:/bin',
};

// ------------------------------------------------------------------ the unit file itself

test('the unit is named after the goal, so a user can type it', () => {
  assert.equal(goalUnitName('2026-10-18-m3'), 'engram-goal-2026-10-18-m3.service');
});

test('the wake fires from ExecStopPost, which runs on every exit path', () => {
  const src = goalUnitSource(unitCtx);
  // `OnSuccess` would leave a crashed or OOM-killed job silent — the failure the wake exists for.
  assert.match(src, /^ExecStopPost=\/opt\/engram goal wake --id 2026-10-18-m3 --deliver --reason /m);
  assert.ok(!/^OnSuccess=/m.test(src), 'a failed job must still reach the goal');
  assert.match(src, /^Type=simple$/m);
  assert.match(src, /^Restart=no$/m);
});

test('the unit is absolute and self-sufficient: no PATH, no shell, no expansion', () => {
  const src = goalUnitSource(unitCtx);
  // A systemd user unit does not inherit a login PATH, and engram is usually installed outside
  // /usr/bin (npm global prefix). Without both lines the unit starts and the wake resolves to ENOENT.
  assert.match(src, /^WorkingDirectory=\/repo$/m);
  assert.match(src, /^Environment=PATH=\/usr\/bin:\/bin$/m);
  assert.match(src, /^ExecStart=python train\.py --epochs 40$/m);
  // Directives only: the header comments explain the `$SERVICE_RESULT` contract, and prose is not a
  // contract. What must not appear is a `$` in a line systemd would expand.
  const directives = src.split('\n').filter((l) => l !== '' && !l.startsWith('#'));
  assert.deepEqual(directives.filter((l) => l.includes('$')), [], 'nothing may be expanded by systemd');
  assert.ok(!src.includes('/bin/sh'), 'no shell, so no quoting rule can create a second command');
});

test('a goal text cannot inject a directive or a specifier', () => {
  const src = goalUnitSource({
    ...unitCtx,
    goal: 'reach 90%\nExecStart=/bin/rm -rf /',
  });
  // The newline must not start a directive, and `%` is a systemd specifier that would be rewritten
  // before engram ever saw the file.
  assert.match(src, /^Description=engram goal 2026-10-18-m3: reach 90%% ExecStart=\/bin\/rm -rf \/$/m);
  const execLines = src.split('\n').filter((l) => l.startsWith('ExecStart='));
  assert.deepEqual(execLines, ['ExecStart=python train.py --epochs 40']);
});

test('a project root containing a space stays one argument', () => {
  const src = goalUnitSource({ ...unitCtx, root: '/home/me/my repo' });
  assert.match(src, /^WorkingDirectory="\/home\/me\/my repo"$/m);
  assert.equal(systemdWord('/plain/path'), '/plain/path');
  assert.equal(systemdWord('two words'), '"two words"');
});

test('the unit outcome is read from the environment, not from a flag', () => {
  assert.equal(unitOutcome({}), null);
  assert.equal(unitOutcome({ SERVICE_RESULT: '  ', EXIT_CODE: '' }), null);
  assert.equal(unitOutcome({ SERVICE_RESULT: 'success', EXIT_STATUS: '0' }), 'unit result=success status=0');
  // 137 is SIGKILL, usually the OOM killer: the reader must be able to tell it from success.
  assert.equal(
    unitOutcome({ SERVICE_RESULT: 'exit-code', EXIT_CODE: '1', EXIT_STATUS: '137' }),
    'unit result=exit-code code=1 status=137',
  );
});

test('an executable engram is used directly, a tsc-emitted one through node', () => {
  assert.deepEqual(engramCommand('/usr/bin/engram', true, '/usr/bin/node'), ['/usr/bin/engram']);
  // `tsc` emits build/src/cli.js as 0644, so spawning it directly fails with EACCES.
  assert.deepEqual(engramCommand('/repo/build/src/cli.js', false, '/usr/bin/node'), [
    '/usr/bin/node',
    '/repo/build/src/cli.js',
  ]);
});

test('the emitted engram command is resolvable, and an explicit one wins', async () => {
  const notExecutable = async (): Promise<boolean> => false;
  assert.deepEqual(
    await resolveEngramCommand({ env: {}, argv1: '/repo/build/src/cli.js', node: '/usr/bin/node', isExecutable: notExecutable }),
    ['/usr/bin/node', '/repo/build/src/cli.js'],
  );
  assert.deepEqual(
    await resolveEngramCommand({ env: {}, argv1: '/usr/bin/engram', node: '/usr/bin/node', isExecutable: async () => true }),
    ['/usr/bin/engram'],
  );
  assert.deepEqual(await resolveEngramCommand({ env: { ENGRAM_BIN: '/opt/engram' }, argv1: '/x/cli.js' }), ['/opt/engram']);
  assert.deepEqual(await resolveEngramCommand({ env: {}, argv1: '' }), ['engram']);
  // Absolute, because the unit's WorkingDirectory is the goal's project rather than the one that
  // emitted the unit: a relative CLI path would silently point at a different checkout.
  assert.deepEqual(
    await resolveEngramCommand({ env: {}, argv1: 'build/src/cli.js', node: '/usr/bin/node', isExecutable: notExecutable }),
    ['/usr/bin/node', path.join(process.cwd(), 'build/src/cli.js')],
  );
});

// ------------------------------------------------------------------ herdr, the last hop

test('herdr is called with argv, never a shell string', () => {
  assert.deepEqual(herdrPromptArgs('w13:p1', 'Wake: unit exited'), ['agent', 'prompt', 'w13:p1', 'Wake: unit exited']);
});

test('a session file resolves to its pane, by exact match only', () => {
  const list = JSON.stringify({
    result: {
      agents: [
        { pane_id: 'w1:p1', agent_session: { value: '/sessions/other.jsonl' } },
        { pane_id: 'w13:p1', agent_session: { value: '/sessions/mine.jsonl' } },
      ],
    },
  });
  assert.equal(paneForSession(list, '/sessions/mine.jsonl'), 'w13:p1');
  // A prefix match would deliver a wake into a different project's pane.
  assert.equal(paneForSession(list, '/sessions/min'), null);
  assert.equal(paneForSession('not json', '/sessions/mine.jsonl'), null);
  assert.equal(paneForSession(JSON.stringify({ result: { agents: [{ agent_session: { value: '/s' } }] } }), '/s'), null);
});

test('every delivery failure is a distinct, loud state', async () => {
  const ok = await promptPane('w13:p1', 'hi', { run: async () => ({ status: 0, stdout: '{"result":{}}', error: null }) });
  assert.equal(ok.ok, true);
  assert.match(ok.detail, /delivered to w13:p1/);

  // Spawn failure: herdr missing, or no PATH inside the unit.
  const missing = await promptPane('w13:p1', 'hi', {
    run: async (): Promise<HerdrRun> => ({ status: null, stdout: '', error: 'ENOENT: spawn herdr' }),
    bin: 'herdr',
  });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /cannot run herdr/);
  assert.match(missing.detail, /nothing was delivered/);

  // Refused by the runtime, which reports it as a field rather than an exit code.
  const refused = await promptPane('w13:p1', 'hi', {
    run: async () => ({ status: 0, stdout: '{"error":{"code":"agent_blocked"}}', error: null }),
  });
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /refused the prompt/);

  const failed = await promptPane('w13:p1', 'hi', {
    run: async () => ({ status: 2, stdout: '', error: 'boom' }),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /exited 2: boom/);
});

// ------------------------------------------------------------------ goal unit, through the CLI

/** A sandbox holding one goal, with its id. */
async function goalSandbox(): Promise<{ sb: Sandbox; id: string }> {
  const sb = await sandbox('engram-goal-unit-');
  await seedBank(sb);
  const created = await runCli(['goal', 'new', 'ship M3', '--cmd', 'true', '--root', sb.root]);
  assert.equal(created.code, 0, created.out);
  // `Sandbox.list` marks directories with a trailing slash; an id with one would build
  // `.ai/goal/<id>//…` paths and a symlink target Node refuses to create.
  const id = ((await sb.list('.ai/goal'))[0] ?? '').replace(/\/+$/, '');
  return { sb, id };
}

test('goal unit prints the unit and writes nothing', async () => {
  const { sb, id } = await goalSandbox();
  try {
    const r = await runCli(['goal', 'unit', id, '--job', 'sleep 3600', '--engram', '/opt/engram', '--root', sb.root]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^# generated by engram/m);
    assert.match(r.out, /ExecStopPost=\/opt\/engram goal wake --id /);
    assert.equal(await sb.exists(`.ai/goal/${id}/${goalUnitName(id)}`), false, 'printing must not write');
  } finally {
    await sb.cleanup();
  }
});

test('goal unit refuses an empty job instead of emitting a unit systemd rejects', async () => {
  const { sb, id } = await goalSandbox();
  try {
    const missing = await runCli(['goal', 'unit', id, '--root', sb.root]);
    assert.equal(missing.code, 1);
    assert.match(missing.err, /needs the job to run/);

    const blank = await runCli(['goal', 'unit', id, '--job', '   ', '--root', sb.root]);
    assert.equal(blank.code, 1);
    assert.match(blank.out, /needs the job to run/);
  } finally {
    await sb.cleanup();
  }
});

test('goal unit --write lands in the goal directory and names the install steps', async () => {
  const { sb, id } = await goalSandbox();
  try {
    const printed = await runCli(['goal', 'unit', id, '--job', 'sleep 5', '--engram', '/opt/engram', '--root', sb.root]);
    const written = await runCli([
      'goal', 'unit', id, '--job', 'sleep 5', '--engram', '/opt/engram', '--write', '--root', sb.root,
    ]);
    assert.equal(written.code, 0, written.out);
    assert.match(written.out, new RegExp(`wrote \\.ai/goal/${id}/engram-goal-${id}\\.service`));
    assert.match(written.out, /systemctl --user start/);
    const onDisk = await sb.read(`.ai/goal/${id}/${goalUnitName(id)}`);
    assert.equal(onDisk, printed.out, 'the written unit is exactly the printed one');
  } finally {
    await sb.cleanup();
  }
});

test('goal unit refuses to write through a symlinked goal directory', async () => {
  const { sb, id } = await goalSandbox();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-goal-outside-'));
  try {
    const goalDir = path.join(sb.root, '.ai', 'goal', id);
    // The realistic shape: the goal directory itself is redirected elsewhere. The record is still
    // *readable* through the link, so a guard that only refused unreadable goals would write the unit
    // outside the project.
    await fs.cp(goalDir, outside, { recursive: true });
    await fs.rm(goalDir, { recursive: true, force: true });
    await fs.symlink(outside, goalDir, 'dir');

    const r = await runCli(['goal', 'unit', id, '--job', 'sleep 5', '--engram', '/opt/engram', '--write', '--root', sb.root]);
    assert.equal(r.code, 1);
    assert.match(r.out, /resolves outside/);
    assert.deepEqual(await fs.readdir(outside), ['BRIEF.md', 'goal.json'], 'nothing may be written outside the project');
  } finally {
    await fs.rm(outside, { recursive: true, force: true });
    await sb.cleanup();
  }
});

// ------------------------------------------------------------------ wake --deliver

/** Park a goal in `waiting` the way the adapter does after a `wait` report. */
async function latchWait(sb: Sandbox, id: string, baton: { sessionPath: string; paneId: string | null } | null): Promise<void> {
  const recordPath = `.ai/goal/${id}/goal.json`;
  const record = JSON.parse(await sb.read(recordPath)) as Record<string, unknown>;
  record.status = 'waiting';
  record.baton = baton === null ? null : { ...baton, startedAt: '2026-10-18T09:00:00.000Z' };
  record.wake = {
    token: 'wake-1',
    condition: { kind: 'process', pid: 42 },
    requestedAt: '2026-10-18T10:00:00.000Z',
    deadlineAt: '2026-10-19T10:00:00.000Z',
    handled: false,
  };
  await sb.write(recordPath, `${JSON.stringify(record, null, 2)}\n`);
}

test('a deliverable wake reaches the baton holder with the engine’s own message', async () => {
  const { sb, id } = await goalSandbox();
  try {
    await latchWait(sb, id, { sessionPath: '/sessions/mine.jsonl', paneId: 'w13:p1' });
    const calls: string[][] = [];
    const r = await runGoalWake({
      root: sb.root,
      id,
      reason: 'training exited',
      deliver: true,
      env: { SERVICE_RESULT: 'exit-code', EXIT_STATUS: '137' },
      herdr: {
        run: async (argv) => {
          calls.push(argv);
          return { status: 0, stdout: '{"result":{}}', error: null };
        },
      },
    });

    assert.equal(r.exitCode, 0, r.lines.join('\n'));
    assert.match(r.lines.join('\n'), /deliver: delivered to w13:p1/);
    assert.deepEqual(calls[0]?.slice(0, 3), ['agent', 'prompt', 'w13:p1']);
    // The unit's outcome is in the message because "a process exiting is not success" is the whole
    // point of waking a parked goal on an exit rather than on a success.
    const text = calls[0]?.[3] ?? '';
    assert.match(text, /Wake: training exited \(unit result=exit-code status=137\)/);
    assert.match(text, /judge it against done_when before reporting done/);
    // The latch is released as part of the same transition, not by the delivery.
    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.status, 'running');
    assert.equal(after.record?.wake, null);
  } finally {
    await sb.cleanup();
  }
});

test('unreachable herdr leaves the wait latched, so the wake can still be delivered', async () => {
  const { sb, id } = await goalSandbox();
  try {
    await latchWait(sb, id, { sessionPath: '/sessions/mine.jsonl', paneId: 'w13:p1' });
    const r = await runGoalWake({
      root: sb.root,
      id,
      reason: 'training exited',
      deliver: true,
      herdr: { run: async () => ({ status: null, stdout: '', error: 'ENOENT: spawn herdr' }), bin: 'herdr' },
    });
    assert.equal(r.exitCode, 1, 'nothing was delivered, so the command did not succeed');
    assert.match(r.lines.join('\n'), /NOT DELIVERED/);
    assert.match(r.lines.join('\n'), /still waiting/);
    // The wake must **not** be consumed. This test used to assert the opposite (`status: running`) with
    // a comment saying "the token is still consumed, so a replay cannot double-charge; the deadline is
    // what recovers it" — false twice over. A wake nobody received had released the latch, and the
    // liveness deadline only covers a goal that is still `waiting`, so `onReconcile` never looked at it.
    // A plausible reason in a test is how a defect gets locked in.
    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.status, 'waiting');
    assert.equal(after.record?.wake?.token, 'wake-1');

    // Which is what makes a retry meaningful: the same command, with herdr reachable, wakes the goal.
    const calls: string[][] = [];
    const retry = await runGoalWake({
      root: sb.root,
      id,
      reason: 'training exited',
      token: 'wake-1',
      deliver: true,
      herdr: {
        run: async (argv) => {
          calls.push(argv);
          return { status: 0, stdout: '{"result":{}}', error: null };
        },
      },
    });
    assert.equal(retry.exitCode, 0, retry.lines.join('\n'));
    assert.match(retry.lines.join('\n'), /deliver: delivered to w13:p1/);
    assert.deepEqual(calls[0]?.slice(0, 3), ['agent', 'prompt', 'w13:p1']);
    const done = await readGoalRecord(sb.root, id);
    assert.equal(done.record?.status, 'running');
    assert.equal(done.record?.wake, null);
  } finally {
    await sb.cleanup();
  }
});

test('a pane-less baton is resolved through herdr’s own session table', async () => {
  const { sb, id } = await goalSandbox();
  try {
    await latchWait(sb, id, { sessionPath: '/sessions/mine.jsonl', paneId: null });
    const calls: string[][] = [];
    const r = await runGoalWake({
      root: sb.root,
      id,
      reason: 'training exited',
      deliver: true,
      herdr: {
        run: async (argv) => {
          calls.push(argv);
          if (argv[0] === 'agent' && argv[1] === 'list') {
            return {
              status: 0,
              stdout: JSON.stringify({ result: { agents: [{ pane_id: 'w9:p2', agent_session: { value: '/sessions/mine.jsonl' } }] } }),
              error: null,
            };
          }
          return { status: 0, stdout: '{"result":{}}', error: null };
        },
      },
    });
    assert.equal(r.exitCode, 0, r.lines.join('\n'));
    assert.deepEqual(calls[0], ['agent', 'list']);
    assert.equal(calls[1]?.[2], 'w9:p2', 'the wake goes to the pane herdr says holds this session');
  } finally {
    await sb.cleanup();
  }
});

test('a goal with no baton says why nothing was delivered', async () => {
  const { sb, id } = await goalSandbox();
  try {
    await latchWait(sb, id, null);
    const r = await runGoalWake({ root: sb.root, id, reason: 'training exited', deliver: true, herdr: { run: async () => {
      throw new Error('herdr must not be consulted when there is no address');
    } } });
    assert.equal(r.exitCode, 1, 'no address means nothing was delivered, so this is a failure');
    assert.match(r.lines.join('\n'), /NOT DELIVERED — the goal has no baton holder/);
    // And the wait is untouched: an undeliverable wake must not release the latch it could not use.
    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.status, 'waiting');
    assert.equal(after.record?.wake?.token, 'wake-1');
  } finally {
    await sb.cleanup();
  }
});

// ------------------------------------------------------------------ identity from the runtime

test('the baton identity comes from the runtime, and only when it is really there', () => {
  assert.deepEqual(
    identityFromEnv({ PI_SESSION_FILE: '/sessions/mine.jsonl', HERDR_PANE_ID: 'w13:p1' }),
    { sessionPath: '/sessions/mine.jsonl', paneId: 'w13:p1' },
  );
  // Absent, not empty: a goal created outside a pane must stay recognisably unclaimed rather than
  // claim a holder named after nothing.
  assert.deepEqual(identityFromEnv({}), {});
  assert.deepEqual(identityFromEnv({ PI_SESSION_FILE: '  ', HERDR_PANE_ID: '' }), {});
  assert.deepEqual(identityFromEnv({ PI_SESSION_FILE: '/s.jsonl' }), { sessionPath: '/s.jsonl' });
});

test('goal new records the holder pi and herdr report, and a flag still wins', async () => {
  const sb = await sandbox('engram-goal-identity-');
  try {
    await seedBank(sb);
    const env = { PI_SESSION_FILE: '/sessions/mine.jsonl', HERDR_PANE_ID: 'w13:p1' };
    assert.equal((await runCli(['goal', 'new', 'owned', '--cmd', 'true', '--root', sb.root], env)).code, 0);
    const status = await runCli(['goal', 'status', '--root', sb.root]);
    assert.match(status.out, /baton:\s+\/sessions\/mine\.jsonl @ w13:p1/);

    // A second goal is refused; close the first so the override case has a clean run.
    await runCli(['goal', 'close', '--root', sb.root]);
    assert.equal(
      (await runCli(['goal', 'new', 'overridden', '--cmd', 'true', '--session', '/sessions/other.jsonl', '--root', sb.root], env)).code,
      0,
    );
    const second = await runCli(['goal', 'status', '--root', sb.root]);
    assert.match(second.out, /baton:\s+\/sessions\/other\.jsonl @ w13:p1/);
  } finally {
    await sb.cleanup();
  }
});

test('goal baton falls back to the environment, and still requires an identity', async () => {
  const { sb, id } = await goalSandbox();
  try {
    const bare = await runCli(['goal', 'baton', '--root', sb.root]);
    assert.equal(bare.code, 1);
    assert.match(bare.err, /needs --session/);

    const fromEnv = await runCli(['goal', 'baton', '--root', sb.root], {
      PI_SESSION_FILE: '/sessions/successor.jsonl',
      HERDR_PANE_ID: 'w9:p3',
    });
    assert.equal(fromEnv.code, 0, fromEnv.out);
    const record = await readGoalRecord(sb.root, id);
    assert.deepEqual(record.record?.baton, {
      sessionPath: '/sessions/successor.jsonl',
      paneId: 'w9:p3',
      startedAt: record.record?.baton?.startedAt,
    });
  } finally {
    await sb.cleanup();
  }
});

test('a hand-driven event carries the runtime identity, and a stranger is still refused', async () => {
  const sb = await sandbox('engram-goal-event-identity-');
  try {
    await seedBank(sb);
    const mine = { PI_SESSION_FILE: '/sessions/mine.jsonl', HERDR_PANE_ID: 'w13:p1' };
    await runCli(['goal', 'new', 'owned', '--cmd', 'true', '--root', sb.root], mine);

    // No `--session`: refusing this refused the one caller whose identity was never in doubt, and the
    // extension (which always passes it) was the only caller that worked.
    const event = ['goal', 'event', '--type', 'report', '--report', '{"status":"progress"}', '--root', sb.root];
    const accepted = await runCli(event, mine);
    assert.equal(JSON.parse(accepted.out.trim()).ok, true, accepted.out);

    const stranger = await runCli(event, { PI_SESSION_FILE: '/sessions/other.jsonl', HERDR_PANE_ID: 'w9:p9' });
    // `ok` stays true: it means "the call was well formed", and the extension turns `ok:false` into
    // an error. The refusal is the effect, which is also where a reader must look for it.
    const refused = JSON.parse(stranger.out.trim()) as { ok: boolean; effects: { kind: string; reason?: string }[] };
    assert.equal(refused.ok, true);
    assert.match(refused.effects[0]?.reason ?? '', /not the baton holder/);
    assert.equal(refused.effects[0]?.kind, 'ignore');
  } finally {
    await sb.cleanup();
  }
});

test('a wake that arrives while blocked is delivered as well as recorded', async () => {
  const { sb, id } = await goalSandbox();
  try {
    const recordPath = `.ai/goal/${id}/goal.json`;
    const record = JSON.parse(await sb.read(recordPath)) as Record<string, unknown>;
    record.status = 'blocked';
    record.baton = { sessionPath: '/sessions/mine.jsonl', paneId: 'w13:p1', startedAt: '2026-10-18T09:00:00.000Z' };
    record.blocker = { reason: 'needs a decision', repeats: 1, needs: 'human', raisedAt: '2026-10-18T10:00:00.000Z' };
    record.wake = {
      token: 'wake-1',
      condition: { kind: 'process', pid: 42 },
      requestedAt: '2026-10-18T10:00:00.000Z',
      deadlineAt: '2026-10-19T10:00:00.000Z',
      handled: false,
    };
    await sb.write(recordPath, `${JSON.stringify(record, null, 2)}\n`);

    const calls: string[][] = [];
    const r = await runGoalWake({
      root: sb.root,
      id,
      reason: 'training exited',
      deliver: true,
      herdr: {
        run: async (argv) => {
          calls.push(argv);
          return { status: 0, stdout: '{"result":{}}', error: null };
        },
      },
    });
    assert.equal(r.exitCode, 0, r.lines.join('\n'));
    // The human is the blocker, and a finished job is news for them: a wake during `blocked` must
    // reach them, not just sit in `pendingWakes`.
    assert.match(calls[0]?.[3] ?? '', /Wake while blocked: training exited/);
    const after = await readGoalRecord(sb.root, id);
    assert.equal(after.record?.pendingWakes.length, 1);
  } finally {
    await sb.cleanup();
  }
});
