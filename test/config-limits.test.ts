import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readConfig, writeConfig, setGoalEnabled, goalEnabled, CONFIG_PATH } from '../src/core/config.js';
import { runCli, sandbox, seedBank } from './helpers.js';

/**
 * The `limits` block: the one knob the waiting decision promised and nothing read.
 *
 * "A liveness deadline bounds every wait (default 24h **configurable**)" — and until this existed the
 * number was a constant with a decision pointing at it. A day is right for a training run and wrong for
 * anything that wants to notice a dead wait sooner, and it is untestable without waiting a day.
 */

test('limits are read, and each field is optional', async () => {
  const sb = await sandbox('engram-limits-');
  try {
    await writeConfig(sb.root, true, { livenessMs: 90_000 });
    const config = await readConfig(sb.root);
    assert.deepEqual(config?.limits, { livenessMs: 90_000 });
    assert.equal(goalEnabled(config), true, 'the opt-in survives next to the limits');

    await writeConfig(sb.root, false, { livenessMs: 90_000, stuckRounds: 2 });
    const both = await readConfig(sb.root);
    assert.deepEqual(both?.limits, { livenessMs: 90_000, stuckRounds: 2 });
  } finally {
    await sb.cleanup();
  }
});

test('a nonsense limit is dropped, not used', async () => {
  const sb = await sandbox('engram-limits-bad-');
  try {
    // `livenessMs: 0` would expire every wait instantly and `NaN` would expire none — both are worse
    // than ignoring the value. A string is a typo, and a fractional count would compare one round late.
    await sb.write(
      CONFIG_PATH,
      JSON.stringify({ version: 2, goal: { enabled: true }, limits: { livenessMs: 0, stuckRounds: -3, blockedRepeats: 'x', silentSettles: 2.7 } }),
    );
    const config = await readConfig(sb.root);
    assert.deepEqual(config?.limits, { silentSettles: 2 }, 'only the usable value survives, floored');
  } finally {
    await sb.cleanup();
  }
});

test('a config whose limits are all unusable reads as no limits at all', async () => {
  const sb = await sandbox('engram-limits-empty-');
  try {
    await sb.write(CONFIG_PATH, JSON.stringify({ version: 2, goal: { enabled: true }, limits: { livenessMs: -1 } }));
    const config = await readConfig(sb.root);
    assert.equal(config?.limits, undefined, 'an empty block must not look like a deliberate one');
  } finally {
    await sb.cleanup();
  }
});

test('toggling the goal does not delete the limits it does not own', async () => {
  // The old `setGoalEnabled` rewrote the whole document, which was harmless while the opt-in was the
  // only key. With `limits` present, turning the goal off and on would silently drop a project's tuned
  // deadline — a write that discards a field it does not own, the same shape as the `clear-wake` leaks.
  const sb = await sandbox('engram-limits-preserve-');
  try {
    await seedBank(sb);
    await sb.write(CONFIG_PATH, JSON.stringify({ version: 2, goal: { enabled: true }, limits: { livenessMs: 60_000 } }));

    const off = await runCli(['config', '--goal', 'off', '--root', sb.root]);
    assert.equal(off.code, 0, off.out);
    const afterOff = JSON.parse(await sb.read(CONFIG_PATH)) as Record<string, unknown>;
    assert.deepEqual(afterOff.limits, { livenessMs: 60_000 }, 'the limits survive the opt-in being turned off');
    // Off is encoded by *omitting* the key — absent config means no — so the assertion is absence, not
    // `enabled: false`.
    assert.equal(afterOff.goal, undefined);

    const on = await runCli(['config', '--goal', 'on', '--root', sb.root]);
    assert.equal(on.code, 0, on.out);
    const afterOn = JSON.parse(await sb.read(CONFIG_PATH)) as Record<string, unknown>;
    assert.deepEqual(afterOn.limits, { livenessMs: 60_000 });
    assert.equal((afterOn.goal as { enabled: boolean }).enabled, true);
  } finally {
    await sb.cleanup();
  }
});

test('a configured liveness deadline is what actually expires a wait', async () => {
  // The point of the knob: a wait whose deadline has passed escalates instead of staying silent, and a
  // short configured deadline makes that testable in a second rather than in a day.
  const sb = await sandbox('engram-limits-expire-');
  try {
    await seedBank(sb);
    await sb.write(CONFIG_PATH, JSON.stringify({ version: 2, goal: { enabled: true }, limits: { livenessMs: 1000 } }));
    await runCli(['goal', 'new', 'wait for nothing', '--cmd', 'true', '--root', sb.root]);

    const armed = JSON.parse(
      (await runCli(['goal', 'event', '--type', 'report', '--report', '{"status":"wait","wakeOnType":"process","wakeOnPid":1}', '--root', sb.root])).out.trim(),
    ) as { status: string; effects: { kind: string; deadlineAt?: string }[] };
    assert.equal(armed.status, 'waiting');
    const scheduled = armed.effects.find((e) => e.kind === 'schedule-wake');
    // A `process` wait has no plan, so its deadline is the configured liveness — not 24h.
    const deadline = Date.parse(scheduled?.deadlineAt ?? '');
    assert.ok(
      deadline - Date.now() < 10_000,
      `the configured 1s liveness must be used, not the 24h default (deadline ${scheduled?.deadlineAt})`,
    );

    // Past the deadline, `reconcile` escalates instead of re-arming.
    await new Promise((r) => setTimeout(r, 1200));
    const dead = JSON.parse((await runCli(['goal', 'event', '--type', 'reconcile', '--root', sb.root])).out.trim()) as {
      status: string;
      notify: string | null;
    };
    assert.equal(dead.status, 'blocked');
    assert.match(dead.notify ?? '', /never woke and passed its deadline/);
  } finally {
    await sb.cleanup();
  }
});

test('config --limits prints the effective values and where they came from', async () => {
  const sb = await sandbox('engram-limits-show-');
  try {
    await seedBank(sb);
    const dflt = await runCli(['config', '--limits', '--root', sb.root]);
    assert.match(dflt.out, /livenessMs\s+86400000 ms/);
    assert.match(dflt.out, /source: defaults/);

    await writeConfig(sb.root, true, { livenessMs: 120_000 });
    const tuned = await runCli(['config', '--limits', '--root', sb.root]);
    assert.match(tuned.out, /livenessMs\s+120000 ms \(configured\)/);
    assert.match(tuned.out, /stuckRounds\s+5$|stuckRounds\s+5\n/, 'untouched fields keep the default');
    assert.match(tuned.out, /source: \.engram\/config\.json/);
  } finally {
    await sb.cleanup();
  }
});
