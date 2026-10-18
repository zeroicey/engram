import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EFFECT_DISPOSITIONS,
  HOST_ACTION_EFFECTS,
  parseReportArgs,
  responseFromEffects,
  idleResponse,
} from '../src/core/goal-host.js';
import { goalExtensionSource, GOAL_EXTENSION_PATH } from '../src/templates/goal-extension.js';
import { newGoalRecord, type GoalEffect } from '../src/core/goal.js';
import { runCli, sandbox, seedBank } from './helpers.js';

/**
 * The pi adapter, tested without pi.
 *
 * Two halves, and the split matters:
 *
 * - The **wire format** (`parseReportArgs`, `responseFromEffects`) is what the generated extension
 *   depends on, so a mistake here silently changes agent behaviour. It is pure, so it is tested
 *   directly.
 * - The **generated file** is user-visible source in their repository. It is checked by
 *   `node --check`, because a syntax error in a generated extension is a broken session with no
 *   useful error message — pi's loader reports it far from the file that caused it.
 */

const T0 = '2026-10-18T10:00:00.000Z';
const record = newGoalRecord({ id: 'g', goal: 'ship it', now: T0 });

/**
 * `main()` in-process. The runtime identity variables are deleted by `runCli`: a goal created while
 * they are set is already owned by the developer's session, and every event below drives the goal
 * without claiming a baton.
 */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return runCli(args);
}

// ---------------------------------------------------------------- wire format

test('every report status parses, and each missing argument is named', () => {
  assert.deepEqual(parseReportArgs({ status: 'progress', note: 'x' }), {
    report: { status: 'progress', note: 'x' },
    error: null,
  });
  assert.deepEqual(parseReportArgs({ status: 'wait', wakeOnType: 'process', wakeOnPid: 42 }), {
    report: { status: 'wait', wakeOn: { kind: 'process', pid: 42 } },
    error: null,
  });
  assert.deepEqual(parseReportArgs({ status: 'wait', wakeOnType: 'artifact', wakeOnPath: 'out/m.json' }).report, {
    status: 'wait',
    wakeOn: { kind: 'artifact', path: 'out/m.json' },
  });
  assert.deepEqual(parseReportArgs({ status: 'blocked', reason: 'no creds', needs: 'ops' }).report, {
    status: 'blocked',
    reason: 'no creds',
    needs: 'ops',
  });
  assert.deepEqual(parseReportArgs({ status: 'done', claim: 'green' }).report, { status: 'done', claim: 'green' });
  assert.deepEqual(parseReportArgs({ status: 'handoff' }).report, { status: 'handoff' });
});

test('a wait without a wake condition is refused with a message that teaches the shape', () => {
  const bare = parseReportArgs({ status: 'wait' });
  assert.equal(bare.report, null);
  assert.match(bare.error ?? '', /wakeOnType/);
  assert.match(bare.error ?? '', /human.*blocked/i, 'the message must route a human wait to blocked');

  assert.match(parseReportArgs({ status: 'wait', wakeOnType: 'time' }).error ?? '', /wakeOnSeconds/);
  assert.match(parseReportArgs({ status: 'wait', wakeOnType: 'time', wakeOnSeconds: 0 }).error ?? '', /positive/);
  assert.match(parseReportArgs({ status: 'wait', wakeOnType: 'process' }).error ?? '', /wakeOnPid/);
  assert.match(parseReportArgs({ status: 'wait', wakeOnType: 'artifact' }).error ?? '', /wakeOnPath/);
});

test('a blocked report without a reason, and an unknown status, are refused', () => {
  assert.match(parseReportArgs({ status: 'blocked' }).error ?? '', /reason/);
  const unknown = parseReportArgs({ status: 'paused' });
  assert.equal(unknown.report, null);
  assert.match(unknown.error ?? '', /progress.*wait.*blocked.*done.*handoff/);
  assert.match(parseReportArgs({ status: '' }).error ?? '', /goal_report needs status/);
});

test('only the first nudge continues a run, and escalations become notifications', () => {
  const nudge: GoalEffect = { kind: 'nudge', reason: 'continue', message: 'go on' };
  const escalate: GoalEffect = { kind: 'escalate', severity: 'stuck', message: 'stuck' };

  const continued = responseFromEffects([nudge, nudge], record);
  assert.equal(continued.continue, true);
  assert.equal(continued.message, 'go on');

  const escalated = responseFromEffects([escalate, { kind: 'silent', reason: 'blocked' }], record);
  assert.equal(escalated.continue, false, 'escalation must never continue the run');
  assert.equal(escalated.notify, 'stuck');

  const handoff = responseFromEffects([{ kind: 'handoff', message: 'x' }], record);
  assert.equal(handoff.continue, false);
  assert.equal(handoff.reason, 'handoff requested');

  const observed = responseFromEffects([{ kind: 'done-observed', message: 'ok' }], record);
  assert.equal(observed.reason, 'done observed');
});

test('an idle response says why and continues nothing', () => {
  const idle = idleResponse('no active goal');
  assert.equal(idle.ok, true);
  assert.equal(idle.continue, false);
  assert.equal(idle.reason, 'no active goal');
});

// ---------------------------------------------------------------- the generated file

test('the generated extension is valid JavaScript and names its own provenance', async () => {
  const src = goalExtensionSource({ engramBin: 'engram', version: '9.9.9' });
  assert.match(src.split('\n')[0] ?? '', /^\/\/ generated by engram /);
  assert.match(src, /9\.9\.9/, 'the version is stamped so a reader can tell what wrote it');
  assert.match(src, /engram-goal/);

  // `node --check` on the emitted string: it is written as JS-valid TS on purpose, so this is a real
  // syntax check rather than a proxy for one.
  const file = path.join(os.tmpdir(), `engram-goal-ext-${process.pid}.mjs`);
  await fs.writeFile(file, src);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('the generated extension reports an unreachable binary instead of silently doing nothing', () => {
  const src = goalExtensionSource({ engramBin: 'engram', version: '0.5.0' });
  // `spawnSync` reports ENOENT as `res.error` with `status: null`; treating that as "no answer" is
  // how the engine looks installed while recording nothing (pitfalls/cases/generated-extension-not-executable.md).
  assert.match(src, /res\.error \|\| res\.status === null/);
  assert.match(src, /cannot run/);
  assert.match(src, /ENGRAM_BIN/, 'a development checkout must be able to override the path');
});

test('the extension carries no rule of its own', () => {
  const src = goalExtensionSource({ engramBin: 'engram', version: '0.5.0' });
  // The rules live in core/. If any of these strings appear here, a second implementation exists.
  for (const rule of ['stuckRounds', 'livenessMs', 'blockedRepeats', 'closedAt', 'unchangedRounds']) {
    assert.ok(!src.includes(rule), `the extension must not encode the rule "${rule}"`);
  }
  // It must also never pass a shell string: one argv array per call.
  assert.match(src, /spawnSync\(ENGRAM, args,/);
  assert.ok(!src.includes('execSync'), 'no shell-string execution');
});

test('the generated extension has an opinion about every effect the engine can emit', () => {
  // The defect this exists for: the extension could only ever *see* an effect list, so nothing forced it
  // to handle a new kind — and two real bugs shipped from that gap (`responseFromEffects` ignoring
  // `ignore`, and `/goal wake` dropping the message its own claim returned). The disposition table is
  // exhaustive at compile time; this asserts the generated source agrees with it.
  const src = goalExtensionSource({ engramBin: 'engram', version: '0.5.0' });
  // `nudge` is the continuation: the extension never names it because it applies the *answer*
  // (`res.continue` + `res.message`), which `agent_before_settle` consumes. That is a real exception
  // rather than a gap, so it is stated here instead of being silently skipped by the loop.
  const viaResponse = new Set(['nudge', 'escalate', 'handoff', 'done-observed']);
  for (const kind of HOST_ACTION_EFFECTS) {
    if (viaResponse.has(kind)) {
      assert.match(src, /res\.continue|res\.notify|handoff requested/, `"${kind}" must reach the host`);
      continue;
    }
    assert.ok(
      src.includes(`"${kind}"`),
      `the host is declared responsible for "${kind}" but the generated extension never names it`,
    );
  }
  // And the reverse direction: a kind marked informational must not be acted on as if it were an
  // instruction. `ignore` in particular is a *refusal* — handling it as a wake is the bug that made a
  // refused poll look like success.
  assert.equal(EFFECT_DISPOSITIONS['evaluate'], 'cli-internal', 'the CLI resolves it before answering');
  assert.equal(EFFECT_DISPOSITIONS.ignore, 'informational');
  assert.equal(EFFECT_DISPOSITIONS['wake-ready'], 'host-action', 'a peek nobody delivers is a lost wake');
});

test('the extension maps every lifecycle event the engine expects', () => {
  const src = goalExtensionSource({ engramBin: 'engram', version: '0.5.0' });
  for (const hook of ['agent_start', 'session_start', 'agent_before_settle', 'turn_end']) {
    assert.ok(src.includes(`pi.on("${hook}"`), `missing ${hook}`);
  }
  for (const ev of ['run-started', 'reconcile', 'settled', 'report']) {
    assert.ok(src.includes(`"${ev}"`), `missing the ${ev} event`);
  }
  assert.ok(src.includes('registerTool'), 'the model needs goal_report');
  assert.ok(src.includes('registerCommand'), 'a human needs /goal');
  // Exactly one continuation per settlement is pi's contract.
  assert.equal(src.match(/continue: true/g)?.length, 1);
});

// ---------------------------------------------------------------- carrier materialisation

test('sync writes the carrier only when the project opted in', async () => {
  const sb = await sandbox('engram-goal-carrier-');
  try {
    await seedBank(sb);
    await sb.write('.engram/config.json', JSON.stringify({ version: 1, tools: ['pi'] }));
    const off = await run(['sync', '--root', sb.root]);
    assert.equal(off.code, 0);
    assert.equal(await sb.exists(GOAL_EXTENSION_PATH), false, 'opt-in means off by default');

    const on = await run(['config', '--goal', 'on', '--root', sb.root]);
    assert.equal(on.code, 0);
    const synced = await run(['sync', '--root', sb.root]);
    assert.match(synced.out, /written\s+\.pi\/extensions\/engram-goal\.ts/);
    assert.equal(await sb.exists(GOAL_EXTENSION_PATH), true);

    const again = await run(['sync', '--root', sb.root]);
    assert.ok(!again.out.includes('written'), 'a second sync must not rewrite an identical file');
  } finally {
    await sb.cleanup();
  }
});

test('disabling the goal removes the generated carrier', async () => {
  const sb = await sandbox('engram-goal-off-');
  try {
    await seedBank(sb);
    await sb.write('.engram/config.json', JSON.stringify({ version: 1, tools: ['pi'], goal: { enabled: true } }));
    await run(['sync', '--root', sb.root]);
    assert.equal(await sb.exists(GOAL_EXTENSION_PATH), true);

    await run(['config', '--goal', 'off', '--root', sb.root]);
    const r = await run(['sync', '--root', sb.root]);
    assert.match(r.out, /removed\s+\.pi\/extensions\/engram-goal\.ts/);
    assert.equal(await sb.exists(GOAL_EXTENSION_PATH), false);
  } finally {
    await sb.cleanup();
  }
});

test('a dry run reports a planned removal without performing it', async () => {
  const sb = await sandbox('engram-goal-dry-');
  try {
    await seedBank(sb);
    await sb.write('.engram/config.json', JSON.stringify({ version: 1, tools: ['pi'], goal: { enabled: true } }));
    await run(['sync', '--root', sb.root]);
    const before = await sb.read(GOAL_EXTENSION_PATH);

    await run(['config', '--goal', 'off', '--root', sb.root]);
    const dry = await run(['sync', '--dry-run', '--root', sb.root]);
    assert.match(dry.out, /removed \(dry run\)/, 'the report must say it is a plan');
    assert.equal(await sb.read(GOAL_EXTENSION_PATH), before, 'and must not have removed anything');
  } finally {
    await sb.cleanup();
  }
});

test('.pi/extensions being a file is refused, not written through', async () => {
  const sb = await sandbox('engram-goal-notdir-');
  try {
    await seedBank(sb);
    await sb.write('.engram/config.json', JSON.stringify({ version: 1, tools: ['pi'], goal: { enabled: true } }));
    await sb.write('.pi/extensions', 'this is a file, not a directory\n');
    const r = await run(['sync', '--root', sb.root]);
    assert.match(r.err, /is not a directory/);
    assert.equal(await sb.read('.pi/extensions'), 'this is a file, not a directory\n', 'untouched');
  } finally {
    await sb.cleanup();
  }
});

test('a foreign file that merely mentions the header is not treated as generated', async () => {
  // The header match must be narrow. `startsWith('// generated by engram')` accepted a hand-written
  // file whose first line was "// generated by engram is a lie — this is mine", and `--goal off` then
  // deleted user code. The old foreign-file test used a file that did not contain the string at all,
  // so it could not catch that.
  const sb = await sandbox('engram-goal-mention-');
  try {
    await seedBank(sb);
    const mine = '// generated by engram is a lie — this is mine\nexport default function () {}\n';
    await sb.write(GOAL_EXTENSION_PATH, mine);
    await sb.write('.engram/config.json', JSON.stringify({ version: 1, tools: ['pi'], goal: { enabled: true } }));
    assert.match((await run(['sync', '--root', sb.root])).err, /hand-written file already exists/);

    await run(['config', '--goal', 'off', '--root', sb.root]);
    await run(['sync', '--root', sb.root]);
    assert.equal(await sb.read(GOAL_EXTENSION_PATH), mine, 'user code survives both directions');
  } finally {
    await sb.cleanup();
  }
});

test('enabling the goal is the only opt-in left, so sync always writes the carrier', async (t) => {
  // The carrier used to need `pi` in a recorded tool set as well as `goal.enabled`. With one client
  // that conjunction had one reachable branch, so it was deleted rather than kept as a guard nothing
  // could fail.
  const sb = await sandbox('engram-goal-only-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  await sb.write('.engram/config.json', JSON.stringify({ version: 2, goal: { enabled: true } }));
  const r = await run(['sync', '--root', sb.root]);
  assert.match(r.out, /written\s+\.pi\/extensions\/engram-goal\.ts/);
  assert.equal(await sb.exists(GOAL_EXTENSION_PATH), true);
});

test('the extension actually notifies when the CLI is unreachable', async () => {
  // The three regex assertions above pin source text; deleting every `warnUnreachable(pi)` call site
  // kept them green while nothing ever told the human. This loads the emitted module against a stub
  // `pi` and nothing on PATH.
  const src = goalExtensionSource({ engramBin: '/nonexistent/engram-does-not-exist', version: '0.5.0' });
  const file = path.join(os.tmpdir(), `engram-goal-live-${process.pid}.mjs`);
  await fs.writeFile(file, src);
  try {
    const mod = (await import(`file://${file}`)) as { default: (pi: unknown) => void };
    const handlers = new Map<string, () => unknown>();
    const notes: string[] = [];
    mod.default({
      on(hook: string, fn: () => unknown) {
        handlers.set(hook, fn);
      },
      registerCommand() {},
      registerTool() {},
      sendMessage(msg: { content: string }) {
        notes.push(msg.content);
      },
    });
    handlers.get('agent_start')?.();
    assert.equal(notes.length, 1, 'the human must be told once');
    assert.match(notes[0] ?? '', /cannot run/);
    // Once per session, not once per settlement.
    handlers.get('agent_before_settle')?.();
    handlers.get('session_start')?.();
    assert.equal(notes.length, 1, 'and not again for every event');
  } finally {
    await fs.rm(file, { force: true });
  }
});

test('a hand-written file at the carrier path is never overwritten or deleted', async () => {
  const sb = await sandbox('engram-goal-foreign-');
  try {
    await seedBank(sb);
    await sb.write('.engram/config.json', JSON.stringify({ version: 1, tools: ['pi'], goal: { enabled: true } }));
    const mine = '// my own extension\nexport default function () {}\n';
    await sb.write(GOAL_EXTENSION_PATH, mine);

    const r = await run(['sync', '--root', sb.root]);
    assert.match(r.err, /hand-written file already exists/, 'the refusal must be reported');
    assert.equal(await sb.read(GOAL_EXTENSION_PATH), mine, 'user code is untouched');

    await run(['config', '--goal', 'off', '--root', sb.root]);
    const removed = await run(['sync', '--root', sb.root]);
    assert.ok(!removed.out.includes('removed'), 'a foreign file is never pruned');
    assert.equal(await sb.read(GOAL_EXTENSION_PATH), mine);
  } finally {
    await sb.cleanup();
  }
});

test('the goal opt-in survives a sync and is readable from config --json', async () => {
  const sb = await sandbox('engram-goal-config-');
  try {
    await seedBank(sb);
    await sb.write('.engram/config.json', JSON.stringify({ version: 1, tools: ['pi', 'claude'] }));
    await run(['config', '--goal', 'on', '--root', sb.root]);
    const read = await run(['config', '--json', '--root', sb.root]);
    const parsed = JSON.parse(read.out) as { version: number; goal: { enabled: boolean } };
    assert.equal(parsed.version, 2);
    assert.equal(parsed.goal.enabled, true);
    assert.equal((parsed as Record<string, unknown>).tools, undefined, 'there is no tool list to keep');

    const sync = await run(['sync', '--root', sb.root]);
    assert.match(sync.out, /written\s+\.pi\/extensions\/engram-goal\.ts/);
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------- the event wire surface

test('goal event --type report answers one JSON document', async () => {
  const sb = await sandbox('engram-goal-event-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'ship', '--cmd', 'true', '--root', sb.root]);

    const progress = await run(['goal', 'event', '--type', 'report', '--report', '{"status":"progress"}', '--root', sb.root]);
    assert.equal(progress.code, 0);
    const parsed = JSON.parse(progress.out.trim()) as { ok: boolean; continue: boolean; status: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.continue, true);
    assert.equal(parsed.status, 'running');

    const invalid = await run(['goal', 'event', '--type', 'report', '--report', '{"status":"nope"}', '--root', sb.root]);
    assert.equal(invalid.code, 1);
    const bad = JSON.parse(invalid.out.trim()) as { ok: boolean; reason: string };
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /goal_report needs status/);
  } finally {
    await sb.cleanup();
  }
});

test('a done claim resolves its own verdict, so the extension never runs a gate', async () => {
  const sb = await sandbox('engram-goal-verdict-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'ship', '--cmd', 'true', '--root', sb.root]);
    const done = await run(['goal', 'event', '--type', 'report', '--report', '{"status":"done"}', '--root', sb.root]);
    const parsed = JSON.parse(done.out.trim()) as { status: string; notify: string; continue: boolean };
    assert.equal(parsed.status, 'done');
    assert.equal(parsed.continue, false);
    assert.match(parsed.notify, /Goal complete/);
  } finally {
    await sb.cleanup();
  }
});

test('a failed gate comes back as a nudge, not as an escalation', async () => {
  const sb = await sandbox('engram-goal-fail-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'never', '--cmd', 'false', '--root', sb.root]);
    const done = await run(['goal', 'event', '--type', 'report', '--report', '{"status":"done"}', '--root', sb.root]);
    const parsed = JSON.parse(done.out.trim()) as { status: string; continue: boolean; message: string; notify: string | null };
    assert.equal(parsed.status, 'running');
    assert.equal(parsed.continue, true, 'the model must be told to keep working');
    assert.match(parsed.message, /done_when did not pass/);
    assert.equal(parsed.notify, null, 'a failing gate is not a human notification');
  } finally {
    await sb.cleanup();
  }
});

test('goal event --type status answers a summary instead of "unknown event"', async () => {
  // The generated extension calls `event("status")` for `/goal`. The verb existed in the extension
  // and not in the CLI, so `/goal` printed `unknown goal event "status"` — a dead code path that no
  // test covered because the extension is only exercised by string assertions.
  const sb = await sandbox('engram-goal-status-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'ship', '--cmd', 'npm test', '--root', sb.root]);
    const r = await run(['goal', 'event', '--type', 'status', '--root', sb.root]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.out.trim()) as { ok: boolean; message: string; status: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status, 'running');
    assert.match(parsed.message, /ship/, 'the summary names the goal');
    assert.match(parsed.message, /npm test/, 'and how it will be judged');
    assert.doesNotMatch(parsed.message, /unknown goal event/);
  } finally {
    await sb.cleanup();
  }
});

test('goal event on a repo with no goal says so instead of failing hard', async () => {
  const sb = await sandbox('engram-goal-none-');
  try {
    await seedBank(sb);
    const r = await run(['goal', 'event', '--type', 'settled', '--root', sb.root]);
    assert.equal(r.code, 0, 'an absent goal is a normal state, not an error');
    const parsed = JSON.parse(r.out.trim()) as { ok: boolean; continue: boolean; reason: string };
    assert.equal(parsed.ok, true);
    assert.equal(parsed.continue, false);
    assert.equal(parsed.reason, 'no active goal');
  } finally {
    await sb.cleanup();
  }
});

test('every lifecycle call carries the session identity, so the baton rule can be enforced', async () => {
  // The tightened baton rule refuses an event with no identity when the goal has a holder. The shipped
  // adapter sent none, so once the rule was correct the goal became undrivable *by its own holder* —
  // a live pi run reported `waiting` after a `goal_report(done)` and nothing moved.
  const src = goalExtensionSource({ engramBin: 'engram', version: '0.5.0' });
  assert.match(src, /function identity\(ctx\)/);
  assert.match(src, /ctx\.sessionManager\.getSessionFile\(\)/);
  // Every event() call site must pass ctx, and the tool must push --session itself.
  const callSites = [...src.matchAll(/event\("([a-z-]+)"(?:, ([^)]*))?\)/g)];
  assert.ok(callSites.length >= 4, 'the lifecycle events go through event()');
  for (const [, name, rest] of callSites) {
    if (name === undefined || rest === undefined) continue;
    assert.match(rest, /ctx/, `event("${name}") must pass ctx for the baton check`);
  }
  assert.match(src, /args\.push\("--session", session\)/, 'the tool identifies itself too');
});

// ---------------------------------------------------------------- the L2 timer, live

/**
 * The generated extension, loaded against a stub `pi` and a **real** CLI in a real project.
 *
 * The string assertions above pass whether or not the timer works, and a timer is the one part of
 * this file that cannot be proved by reading it: whether `schedule-wake` becomes a live handle, whether
 * a release really cancels it, and whether a satisfied wake starts a turn are all runtime facts. So
 * the emitted module is imported and driven, with `engram` reached through a shim that `cd`s into the
 * sandbox — which is also how an installed bin behaves.
 */
async function loadExtension(
  sb: Awaited<ReturnType<typeof sandbox>>,
  session: string,
  options: { throwOnFirstDelivery?: boolean } = {},
): Promise<{
  handlers: Map<string, (event?: unknown, ctx?: unknown) => unknown>;
  messages: { content: string; triggerTurn: boolean }[];
  report: (params: Record<string, unknown>) => Promise<unknown>;
  goal: (args: string) => Promise<void>;
  ctx: Record<string, unknown>;
}> {
  const cli = new URL('../src/cli.js', import.meta.url).pathname;
  const shim = await sb.write('.engram/test-engram', `#!/bin/sh\ncd ${sb.root} || exit 1\nexec node ${cli} "$@"\n`);
  await fs.chmod(shim, 0o755);

  const src = goalExtensionSource({ engramBin: shim, version: '0.5.0' });
  const file = path.join(os.tmpdir(), `engram-goal-timer-${process.pid}-${path.basename(sb.root)}.mjs`);
  await fs.writeFile(file, src);
  delete process.env.ENGRAM_BIN;
  const mod = (await import(`file://${file}`)) as { default: (pi: unknown) => void };
  await fs.rm(file, { force: true });

  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => unknown>();
  const messages: { content: string; triggerTurn: boolean }[] = [];
  let tool: { execute: (id: string, params: Record<string, unknown>, s: unknown, u: unknown, ctx: unknown) => Promise<unknown> } | null = null;
  let command: { handler: (args: string, ctx: unknown) => Promise<void> } | null = null;
  const ctx = {
    sessionManager: { getSessionFile: () => session },
    ui: { notify: () => {} },
    getContextUsage: () => undefined,
  };
  mod.default({
    on(hook: string, fn: (event?: unknown, ctx?: unknown) => unknown) {
      handlers.set(hook, fn);
    },
    registerCommand(_name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = def;
    },
    registerTool(def: typeof tool) {
      tool = def;
    },
    sendMessage(msg: { content: string }, callOptions?: { triggerTurn?: boolean }) {
      messages.push({ content: msg.content, triggerTurn: callOptions?.triggerTurn === true });
      // The runtime a timer fires into can be stale (a reload, a session replacement, a shutdown) and
      // `sendMessage` throws. A throw from a timer callback is an uncaught exception in *this* process
      // too, so the test would fail loudly — which is the point.
      if (options.throwOnFirstDelivery === true && callOptions?.triggerTurn === true) {
        options.throwOnFirstDelivery = false;
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }
    },
  });
  assert.ok(tool !== null, 'the tool must be registered');
  assert.ok(command !== null, 'the human needs /goal');
  return {
    handlers,
    messages,
    ctx,
    report: (params: Record<string, unknown>) => (tool as NonNullable<typeof tool>).execute('id', params, undefined, undefined, ctx),
    goal: (args: string) => (command as NonNullable<typeof command>).handler(args, ctx),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a wait of a second really fires: the timer asks the engine and starts a turn', async () => {
  const sb = await sandbox('engram-goal-timer-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'timer proof', '--cmd', 'true', '--root', sb.root]);
    const ext = await loadExtension(sb, '/sessions/timer.jsonl');

    await ext.report({ status: 'wait', wakeOnType: 'time', wakeOnSeconds: 1 });
    const armed = await sb.read(`.ai/goal/${(await sb.list('.ai/goal'))[0] ?? ''}/goal.json`);
    assert.equal((JSON.parse(armed) as { status: string }).status, 'waiting', 'the report parked the goal');
    assert.equal(ext.messages.length, 0, 'and nothing has been said yet');

    await sleep(1400);
    const fired = ext.messages.filter((m) => m.triggerTurn);
    assert.equal(fired.length, 1, 'exactly one turn, started by the timer');
    assert.match(fired[0]?.content ?? '', /1s elapsed/, 'the message names what ended');
    assert.match(fired[0]?.content ?? '', /done_when/, 'and asks for a judgment');

    const after = JSON.parse(await sb.read(`.ai/goal/${(await sb.list('.ai/goal'))[0] ?? ''}/goal.json`)) as { status: string; wake: unknown };
    assert.equal(after.status, 'running', 'the engine released the wait, and it was the engine');
    assert.equal(after.wake, null, 'the consumed timer is cleared, not left handled');
  } finally {
    await sb.cleanup();
  }
});

test('a released wait cancels the timer, so no turn arrives for a wait that is over', async () => {
  const sb = await sandbox('engram-goal-timer-cancel-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'timer cancel', '--cmd', 'true', '--root', sb.root]);
    const ext = await loadExtension(sb, '/sessions/timer.jsonl');

    await ext.report({ status: 'wait', wakeOnType: 'time', wakeOnSeconds: 1 });
    // Any new run releases the latch — here `agent_start`, which is what a background-task completion
    // or a herdr prompt looks like. The engine answers with `clear-wake`, and that is what must stop
    // the handle: a timer left armed for a released token asks the engine about a wait it no longer
    // has, and a spurious turn is the cheapest possible outcome.
    ext.handlers.get('agent_start')?.({}, ext.ctx);
    await sleep(1400);
    assert.deepEqual(
      ext.messages.filter((m) => m.triggerTurn),
      [],
      'the timer fired after the goal had already moved on',
    );
  } finally {
    await sb.cleanup();
  }
});

test('a restart re-arms the wait from the record, not from the report', async () => {
  const sb = await sandbox('engram-goal-timer-reconcile-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'timer restart', '--cmd', 'true', '--root', sb.root]);
    // The wait is latched by a *different process* — the predecessor that has since restarted, or the
    // pane that handed the baton away. So this extension has never seen a `schedule-wake`, and the only
    // thing that can give it a timer is the reconcile on session start. Without that, a wait exists
    // only in the process that latched it, and a handoff parks the goal in a pane nobody is watching.
    await run(['goal', 'event', '--type', 'report', '--report', '{"status":"wait","wakeOnType":"time","wakeOnSeconds":1}', '--root', sb.root]);
    const ext = await loadExtension(sb, '/sessions/successor.jsonl');
    assert.equal(ext.messages.length, 0, 'nothing armed yet');

    ext.handlers.get('session_start')?.({}, ext.ctx);
    await sleep(1400);
    const fired = ext.messages.filter((m) => m.triggerTurn);
    assert.equal(fired.length, 1, 'the wait recovered from goal.json alone, and fired once');
    assert.match(fired[0]?.content ?? '', /1s elapsed/);
  } finally {
    await sb.cleanup();
  }
});

test('an observed condition is polled, and only the engine can turn it into a turn', async () => {
  const sb = await sandbox('engram-goal-timer-artifact-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'wait for the artifact', '--cmd', 'true', '--root', sb.root]);
    const ext = await loadExtension(sb, '/sessions/timer.jsonl');
    const id = (await sb.list('.ai/goal'))[0] ?? '';
    const record = async (): Promise<{ status: string }> =>
      JSON.parse(await sb.read(`.ai/goal/${id}/goal.json`)) as { status: string };

    // The artifact is not there. The host asks — that is the only in-process way to know — and the
    // engine answers "still waiting", which the host reads as "ask again". Nothing starts a turn, which
    // is the property that matters: an unanswered poll is not a wake.
    await ext.report({ status: 'wait', wakeOnType: 'artifact', wakeOnPath: 'out/ready.json' });
    await sleep(1400);
    assert.equal(ext.messages.length, 0, 'a poll that is not satisfied must start nothing');
    assert.equal((await record()).status, 'waiting');

    // Now it exists. The same question gets the opposite answer, and this time the engine's message is
    // what starts the turn.
    await sb.write('out/ready.json', '{"ok":true}\n');
    ext.handlers.get('session_start')?.({}, ext.ctx);
    await sleep(1400);
    const fired = ext.messages.filter((m) => m.triggerTurn);
    assert.equal(fired.length, 1, 'the observed condition woke the goal');
    assert.match(fired[0]?.content ?? '', /out\/ready\.json appeared/);
    assert.equal((await record()).status, 'running');
  } finally {
    await sb.cleanup();
  }
});

test('a wake that cannot be delivered is not claimed, and the next session recovers it', async () => {
  const sb = await sandbox('engram-goal-timer-stale-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'stale runtime', '--cmd', 'true', '--root', sb.root]);
    const ext = await loadExtension(sb, '/sessions/timer.jsonl', { throwOnFirstDelivery: true });
    const id = (await sb.list('.ai/goal'))[0] ?? '';
    const status = async (): Promise<{ status: string; wake: unknown }> =>
      JSON.parse(await sb.read(`.ai/goal/${id}/goal.json`)) as { status: string; wake: unknown };

    await ext.report({ status: 'wait', wakeOnType: 'time', wakeOnSeconds: 1 });

    // The timer fires, the engine answers `wake-ready`, and the delivery throws (a stale runtime — a
    // reload or a session replacement). Because the poll was a *peek*, the latch is untouched: this is
    // the assertion that separates delivery-then-claim from a version that consumed first and left a
    // `running` goal nobody was watching.
    await sleep(1400);
    const after = await status();
    assert.equal(after.status, 'waiting', 'a delivery that failed must not have consumed the wait');
    assert.notEqual(after.wake, null, 'and the token is still latched');
    assert.ok(
      ext.messages.some((m) => /could not be delivered/.test(m.content)),
      'and the host said so instead of dying silently',
    );

    // No retry: a stale runtime never comes back, and a pending timer would hold a shutting-down
    // process open until the deadline. One attempt, then it stops.
    await sleep(1500);
    assert.equal((await status()).status, 'waiting');
    assert.equal(
      ext.messages.filter((m) => m.triggerTurn).length,
      1,
      'the dead runtime must not be retried: a hop that can only fail also keeps the process alive',
    );

    // The recovery is the real one: a fresh instance reconciles from `goal.json`, re-arms, delivers,
    // and only then claims.
    const fresh = await loadExtension(sb, '/sessions/timer.jsonl');
    fresh.handlers.get('session_start')?.({}, fresh.ctx);
    await sleep(1400);
    assert.equal((await status()).status, 'running');
    assert.equal((await status()).wake, null);
    assert.equal(fresh.messages.filter((m) => m.triggerTurn).length, 1);
  } finally {
    await sb.cleanup();
  }
});

test('/goal wake delivers the engine message, because the claim releases the latch', async () => {
  const sb = await sandbox('engram-goal-command-wake-');
  try {
    await seedBank(sb);
    await run(['goal', 'new', 'human escape hatch', '--cmd', 'true', '--root', sb.root]);
    const ext = await loadExtension(sb, '/sessions/timer.jsonl');
    const id = (await sb.list('.ai/goal'))[0] ?? '';
    const status = async (): Promise<{ status: string; wake: unknown }> =>
      JSON.parse(await sb.read(`.ai/goal/${id}/goal.json`)) as { status: string; wake: unknown };

    await ext.report({ status: 'wait', wakeOnType: 'time', wakeOnSeconds: 3600 });
    assert.equal((await status()).status, 'waiting');

    // The human escape hatch. `event --type wake` is a *claim*: it releases the latch, so the message it
    // returns IS the delivery. This handler used to throw it away — a wake consumed with nobody told,
    // and the goal left `running` and parked forever, because `waiting` is the only state with a deadline.
    await ext.goal('wake a human said go');
    const fired = ext.messages.filter((m) => m.triggerTurn);
    assert.equal(fired.length, 1, 'the model must be told the goal was woken');
    assert.match(fired[0]?.content ?? '', /Wake: a human said go/);
    assert.equal((await status()).status, 'running');
    assert.equal((await status()).wake, null);
  } finally {
    await sb.cleanup();
  }
});
