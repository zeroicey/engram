import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDoctor } from '../src/commands/doctor.js';
import { runChecks, hasErrors, tally, CURRENT_TASK_WARN_LINES } from '../src/core/doctor.js';
import { loadMemory } from '../src/core/memory.js';
import { runCli, sandbox, seedBank } from './helpers.js';

/**
 * `engram doctor`, tested against the shapes real repositories have.
 *
 * Every fixture below is a state found in one of the seven repositories that adopted the bank — not an
 * invented broken file. That is the point of the command: the same checks were run by hand as shell
 * loops, and everything they found was invisible to `engram` itself (three repositories had lost their
 * `CURRENT_TASK` headings, two held untouched templates, one had orphan carriers, and `sync` reported
 * "clean" for all of them).
 */

async function doctor(root: string): Promise<{ code: number; out: string; json: unknown }> {
  const text = await runCli(['doctor', '--root', root]);
  const parsed = await runCli(['doctor', '--json', '--root', root]);
  return { code: text.code, out: text.out, json: JSON.parse(parsed.out) as unknown };
}

const rules = (json: unknown): string[] =>
  ((json as { findings: Array<{ rule: string }> }).findings ?? []).map((f) => f.rule);

test('a healthy bank reports nothing and exits 0', async () => {
  const sb = await sandbox('engram-doctor-ok-');
  try {
    await seedBank(sb);
    // A filled CURRENT_TASK, because an unwritten one is an `info`, not health.
    await sb.write(
      '.ai/CURRENT_TASK.md',
      [
        '# Current task',
        '',
        '**Status:** 🟡 active · **Updated:** 2026-10-19',
        '',
        '## Goal',
        '',
        'Ship it',
        '',
        '## Code state',
        '',
        'one module',
        '',
        '## Next action',
        '',
        'Do the thing',
        '',
      ].join('\n'),
    );
    const r = await doctor(sb.root);
    assert.equal(r.code, 0, r.out);
    assert.deepEqual(rules(r.json), []);
    assert.match(r.out, /bank is healthy/);
  } finally {
    await sb.cleanup();
  }
});

test('a CURRENT_TASK without the contract headings is an error, and names them', async () => {
  // `clip`, `research` and `teleport` are all in this state: the file was rewritten as prose, so the
  // fingerprint silently lost `project:` / `next:` / `branch:`.
  const sb = await sandbox('engram-doctor-headings-');
  try {
    await seedBank(sb);
    await sb.write('.ai/CURRENT_TASK.md', '# Current task\n\n**Status:** 🟡 active\n\n## 我们在做什么\n\n散文。\n');
    const r = await doctor(sb.root);
    assert.equal(r.code, 1, 'an error finding must exit non-zero');
    assert.ok(rules(r.json).includes('current-task/missing-headings'));
    assert.match(r.out, /has no Goal \/ Next action \/ Code state heading/);
  } finally {
    await sb.cleanup();
  }
});

test('an unwritten CURRENT_TASK is a note, not a problem', async () => {
  // `skybrain` and `skyeye` are byte-identical `init` templates, one untouched for 16 days. A checker
  // that called that an error would teach people to ignore it — the state is new, not broken.
  const sb = await sandbox('engram-doctor-fresh-');
  try {
    await seedBank(sb);
    await sb.write(
      '.ai/CURRENT_TASK.md',
      ['# Current task', '', '**Status:** 🟡 active · **Updated:** 2026-10-19', '', '## Goal', '', '## Code state', '', '## Next action', '', ''].join('\n'),
    );
    const r = await doctor(sb.root);
    assert.equal(r.code, 0, 'a note must not fail the command');
    assert.ok(rules(r.json).includes('current-task/unwritten'));
    assert.ok(!rules(r.json).includes('current-task/missing-headings'), 'the headings are there');
  } finally {
    await sb.cleanup();
  }
});

test('a CURRENT_TASK longer than the threshold is reported with its cost', async () => {
  // The template says ~60 lines; the reference set ran 144–536, and this file is read on *every*
  // session start, so the cost is per session.
  const sb = await sandbox('engram-doctor-long-');
  try {
    await seedBank(sb);
    const long = ['# Current task', '', '**Status:** 🟡 active', '', '## Goal', '', 'g', '', '## Code state', '', 'c', '', '## Next action', '', 'n', ''];
    while (long.length <= CURRENT_TASK_WARN_LINES + 5) long.push(`- line ${long.length}`);
    await sb.write('.ai/CURRENT_TASK.md', long.join('\n'));

    const r = await doctor(sb.root);
    assert.equal(r.code, 0, 'length is a warning, not a blocker');
    assert.ok(rules(r.json).includes('current-task/long'));
    assert.match(r.out, /read on every session start|guidance: ~60/);
  } finally {
    await sb.cleanup();
  }
});

test('a decision with no readable status is reported, because it never reaches the fingerprint', async () => {
  const sb = await sandbox('engram-doctor-decisions-');
  try {
    await seedBank(sb);
    await sb.write('.ai/decisions/2026-10-01-unlabelled.md', '# A decision with no status line\n\nprose only\n');
    const r = await doctor(sb.root);
    assert.ok(rules(r.json).includes('decisions/unclassified'));
    assert.match(r.out, /no readable status/);
  } finally {
    await sb.cleanup();
  }
});

test('a carrier with no canonical skill is reported as an orphan', async () => {
  // `research` has two of these: `.agents/skills/net-access` and `paper-corpus` exist with no
  // `.ai/skills/*.md` source, so `sync` can never regenerate or prune them.
  const sb = await sandbox('engram-doctor-orphan-');
  try {
    await seedBank(sb);
    await sb.write('.agents/skills/net-access/SKILL.md', '# net-access\n');
    const r = await doctor(sb.root);
    assert.ok(rules(r.json).includes('skills/orphan-carrier'));
    assert.match(r.out, /net-access has no \.ai\/skills\/net-access\.md/);
  } finally {
    await sb.cleanup();
  }
});

test('a goal that cannot be judged is reported, and a damaged brief is an error', async () => {
  const sb = await sandbox('engram-doctor-goal-');
  try {
    await seedBank(sb);
    // No `--cmd`: this is the state `goal new` scaffolds on purpose, where the first run is supposed to
    // classify the goal. It is judgeable-in-principle and unjudged, which is a warning.
    await runCli(['goal', 'new', 'an unjudgeable goal', '--root', sb.root]);
    const unjudgeable = await doctor(sb.root);
    assert.ok(rules(unjudgeable.json).includes('goal/not-judgeable'));

    // Now a *declared* verdict that does not parse. A typo must not read as "not declared" — it is a hard
    // error, because the goal can never finish and nothing else will say so.
    const id = ((await sb.list('.ai/goal'))[0] ?? '').replace(/\/+$/, '');
    await sb.write(
      `.ai/goal/${id}/BRIEF.md`,
      ['# g', '', '## Goal', '', 'g', '', '## Done when', '', '```json', '{ "kind": "cmd", }', '```', ''].join('\n'),
    );
    const broken = await doctor(sb.root);
    assert.equal(broken.code, 1, 'an unreadable brief is an error');
    assert.ok(rules(broken.json).includes('goal/brief-unreadable'));
  } finally {
    await sb.cleanup();
  }
});

test('a latched wake that was already consumed is an error: the wait can never fire', async () => {
  interface Rec {
    status: string;
    wake: unknown;
  }
  const sb = await sandbox('engram-doctor-wake-');
  try {
    await seedBank(sb);
    await runCli(['goal', 'new', 'a stuck wait', '--cmd', 'true', '--root', sb.root]);
    await runCli([
      'goal', 'event', '--type', 'report',
      '--report', '{"status":"wait","wakeOnType":"time","wakeOnSeconds":600}',
      '--root', sb.root,
    ]);
    const id = (await sb.list('.ai/goal'))[0] ?? '';
    const path = `.ai/goal/${id}/goal.json`;
    const record = JSON.parse(await sb.read(path)) as Rec;
    // The shape a crash between "consume" and "clear" leaves behind.
    (record.wake as { handled: boolean }).handled = true;
    await sb.write(path, `${JSON.stringify(record, null, 2)}\n`);

    const r = await doctor(sb.root);
    assert.equal(r.code, 1);
    assert.ok(rules(r.json).includes('goal/handled-wake-latched'));
    assert.match(r.out, /can never fire/);
  } finally {
    await sb.cleanup();
  }
});

test('a missing bank is one clear error, not a pile of them', async () => {
  const sb = await sandbox('engram-doctor-none-');
  try {
    const r = await doctor(sb.root);
    assert.equal(r.code, 1);
    assert.deepEqual(rules(r.json), ['bank/absent']);
    assert.match(r.out, /engram init/);
  } finally {
    await sb.cleanup();
  }
});

test('a stale proposal is reported once, at the threshold', () => {
  // Pure, so the clock is injected: waiting two weeks to test this is not a test.
  const bank = {
    root: '/x',
    dir: '.ai',
    exists: true,
    currentTask: null,
    decisions: [
      { file: '2026-01-01-old-proposal.md', date: '2026-01-01', topic: 'old', title: 'old', status: 'PROPOSAL' as const },
      { file: '2026-01-01-old-accepted.md', date: '2026-01-01', topic: 'ok', title: 'ok', status: 'ACCEPTED' as const },
      { file: '2026-10-18-fresh-proposal.md', date: '2026-10-18', topic: 'fresh', title: 'fresh', status: 'PROPOSAL' as const },
    ],
    sessions: [],
    pitfalls: [],
    runbooks: [],
    skills: [],
    sections: [],
    goal: null,
    goalErrors: [],
    readErrors: [],
    warnings: [],
  };
  return runChecks({ bank, now: '2026-10-19T00:00:00.000Z' }).then((findings) => {
    const stale = findings.filter((f) => f.rule === 'decisions/stale-proposal');
    assert.equal(stale.length, 1, 'one finding, not one per file');
    assert.match(stale[0]?.hint ?? '', /2026-01-01-old-proposal\.md/);
    assert.ok(!stale[0]?.hint?.includes('fresh'), 'a proposal filed yesterday is not stale');
  });
});

test('--json is one JSON document and the text rendering agrees with it', async () => {
  const sb = await sandbox('engram-doctor-json-');
  try {
    await seedBank(sb);
    const r = await doctor(sb.root);
    const parsed = r.json as { summary: Record<string, number>; findings: unknown[] };
    assert.equal(typeof parsed.summary, 'object');
    assert.equal(parsed.findings.length, (r.out.match(/^[✗⚠·] /gm) ?? []).length, 'same findings in both renderings');
  } finally {
    await sb.cleanup();
  }
});

test('hasErrors and tally read only the severity, never the text', () => {
  assert.equal(hasErrors([{ rule: 'r', severity: 'warn', message: 'error' }]), false);
  assert.equal(hasErrors([{ rule: 'r', severity: 'error', message: 'fine' }]), true);
  assert.deepEqual(tally([{ rule: 'a', severity: 'error', message: '' }, { rule: 'b', severity: 'info', message: '' }]), {
    error: 1,
    warn: 0,
    info: 1,
  });
});
