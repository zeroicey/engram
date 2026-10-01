import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMemory, parseCurrentTask } from '../src/core/memory.js';
import { buildFingerprint } from '../src/core/fingerprint.js';
import { sandbox, seedBank } from './helpers.js';

test('parseCurrentTask extracts goal, next action and skips table noise', () => {
  const content = [
    '# Current task',
    '',
    '**Status:** 🟡 active · **Updated:** 2026-10-01',
    '',
    '## Goal',
    '',
    'Ship the **parser** rewrite',
    '',
    '## Blockers',
    '',
    '| Blocker | Waiting on | Unblock by |',
    '| --- | --- | --- |',
    '| schema review | platform | soon |',
    '- waiting on platform team',
    '',
    '## Next action',
    '',
    '- [ ] Wire `--legacy` into the CLI',
    '',
  ].join('\n');

  const parsed = parseCurrentTask(content);
  assert.equal(parsed.status, '🟡 active');
  assert.equal(parsed.goal, 'Ship the parser rewrite');
  assert.equal(parsed.nextAction, 'Wire --legacy into the CLI', 'inline code marks are stripped for compactness');
  assert.deepEqual(parsed.blockers, ['waiting on platform team']);
});

test('parseCurrentTask survives a missing section', () => {
  const parsed = parseCurrentTask('# Current task\n\nnothing useful here\n');
  assert.equal(parsed.goal, '');
  assert.equal(parsed.nextAction, '');
  assert.deepEqual(parsed.blockers, []);
});

test('loadMemory classifies decisions, ignores templates, sorts by date', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);

  const bank = await loadMemory(sb.root);
  assert.equal(bank.exists, true);
  assert.deepEqual(
    bank.decisions.map((d) => d.status),
    ['PROPOSAL', 'ACCEPTED', 'REJECTED'],
  );
  assert.deepEqual(
    bank.sessions.map((s) => s.file),
    ['2026-10-01-parser-handoff.md', '2026-09-20-old-handoff.md'],
  );
  assert.equal(bank.pitfalls.length, 1, '_TEMPLATE.md is inert');
  assert.deepEqual(bank.skills, ['handoff.md']);
});

test('loadMemory on a repo without .ai/ reports non-existence, not an error', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  const bank = await loadMemory(sb.root);
  assert.equal(bank.exists, false);
  assert.equal(bank.decisions.length, 0);
  assert.equal(bank.currentTask, null);
});

test('fingerprint stays within the default 1500 byte budget', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);

  const fp = buildFingerprint(await loadMemory(sb.root));
  const bytes = Buffer.byteLength(fp.markdown, 'utf8');
  assert.ok(bytes <= 1500, `expected ≤1500 bytes, got ${bytes}`);
  assert.ok(fp.truncated === false, 'seeded bank should not hit the ceiling');
});

test('fingerprint honours a custom budget by dropping low-value sections', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  await sb.write(
    '.ai/decisions/2026-10-02-another-proposal.md',
    '# Use a queue for exports\n\n**Status:** 💭 PROPOSAL\n',
  );

  const bank = await loadMemory(sb.root);
  const tight = buildFingerprint(bank, { maxBytes: 420 });
  const bytes = Buffer.byteLength(tight.markdown, 'utf8');
  assert.ok(bytes <= 420, `expected ≤420 bytes, got ${bytes}`);
  assert.match(tight.markdown, /^# engram v1/);
  assert.match(tight.markdown, /NOW/);
  assert.match(tight.markdown, /POINTERS/);
});

test('fingerprint degrades on a large bank instead of truncating mid-line', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  for (let i = 0; i < 12; i++) {
    const day = `2026-10-${String(i + 1).padStart(2, '0')}`;
    await sb.write(
      `.ai/decisions/${day}-proposal-number-${i}.md`,
      `# Proposal ${i}: ${'a very long descriptive title '.repeat(3)}\n\n**Status:** 💭 PROPOSAL\n`,
    );
  }

  const fp = buildFingerprint(await loadMemory(sb.root), { maxBytes: 700 });
  const text = fp.markdown;
  assert.ok(Buffer.byteLength(text, 'utf8') <= 700);
  assert.ok(!text.includes('\n…'), 'no orphaned ellipsis line');
  for (const line of text.split('\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 200, `line too long: ${line}`);
  }
});

test('fingerprint surfaces proposals explicitly as needing a verdict', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  const fp = buildFingerprint(await loadMemory(sb.root));
  assert.match(fp.markdown, /💭 2026-10-01 Stream responses/);
  assert.match(fp.markdown, /needs verdict/);
  assert.match(fp.markdown, /✅ 2026-09-01 Adopt zod/);
});

test('fingerprint json view carries the same facts', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  const fp = buildFingerprint(await loadMemory(sb.root));
  assert.equal(fp.data.goal, 'Ship the parser rewrite behind a flag');
  assert.equal(fp.data.skills[0], '/handoff');
  assert.equal(fp.data.sessions[0]?.file, '.ai/sessions/2026-10-01-parser-handoff.md');
  assert.equal(fp.data.bytes, Buffer.byteLength(fp.markdown, 'utf8'));
});