import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMemory, parseCurrentTask, decisionStatus } from '../src/core/memory.js';
import { buildFingerprint, trimTo } from '../src/core/fingerprint.js';
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
  // Regression: Blockers supports bullets *and* Markdown tables. The shipped template used a table
  // while the parser skipped table rows, making `blocked:` permanently dead for every repository
  // scaffolded from the template.
  assert.deepEqual(parsed.blockers, ['schema review — platform — soon', 'waiting on platform team']);
});

test('a Blockers table header or separator row is never counted as a blocker', () => {
  const content = ['## Blockers', '', '| Blocker | Waiting on | Unblock by |', '| --- | --- | --- |', '| | | |', ''].join('\n');
  assert.deepEqual(parseCurrentTask(content).blockers, [], 'an empty table means no blockers');
});

test('a wrapped goal is joined, not cut at the first physical line', () => {
  const content = [
    '# Current task',
    '**Status:** 🟡 active',
    '',
    '## Goal',
    '',
    'Ship the parser rewrite behind a flag and prove it',
    'with a fixture that reproduces last week drift.',
    '',
    '## Next action',
    '',
    '- [ ] Wire the legacy flag into',
    '      the CLI entry point',
    '',
  ].join('\n');
  const parsed = parseCurrentTask(content);
  assert.equal(
    parsed.goal,
    'Ship the parser rewrite behind a flag and prove it with a fixture that reproduces last week drift.',
  );
  assert.equal(parsed.nextAction, 'Wire the legacy flag into the CLI entry point');
});

test('heading decoration does not defeat section lookup', () => {
  for (const heading of ['## Goal', '## Goal: parser', '### Goal', '## GOAL']) {
    assert.equal(
      parseCurrentTask(`# Current task\n\n${heading}\n\nreal content here\n`).goal,
      'real content here',
      `heading: ${heading}`,
    );
  }
});

test('a #### subsection does not leak into its parent section', () => {
  const content = ['## Blockers', '', '- real blocker', '', '#### Notes', '', '- escalated yesterday', ''].join('\n');
  assert.deepEqual(parseCurrentTask(content).blockers, ['real blocker']);
});

test('a ratified decision is never reported as an open proposal', () => {
  // Regression: status was the leftmost emoji token anywhere in the file, so a Context paragraph
  // mentioning "originally filed as 💭 PROPOSAL" inverted a binding decision.
  const ratified = [
    '# Use Redis for the session cache',
    '',
    '**Status:** ✅ ACCEPTED · **Date:** 2026-10-01',
    '',
    '## Context',
    '',
    'Originally filed as 💭 PROPOSAL. Ratified on 2026-10-01.',
    '',
  ].join('\n');
  assert.equal(decisionStatus(ratified), 'ACCEPTED');
  assert.equal(decisionStatus('**Status:** 🪦 REJECTED'), 'REJECTED');
  assert.equal(decisionStatus('**Status:** 💭 PROPOSAL'), 'PROPOSAL');
  assert.equal(decisionStatus('**Status:** ✅ Accepted'), 'ACCEPTED', 'status words are case-insensitive');
  assert.equal(decisionStatus('no status here'), 'UNKNOWN');
});

test('the word Status in prose is not mistaken for the status header', () => {
  const content = [
    '# Current task',
    '',
    '## Goal',
    '',
    'Rewrite the Status page renderer',
    '',
    '**Status:** 🟡 active · **Updated:** 2026-10-01',
    '',
  ].join('\n');
  assert.equal(parseCurrentTask(content).status, '🟡 active');
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

// ── byte budget: the documented ceiling must actually be a ceiling ──────────

test('REGRESSION trimTo respects the byte budget, not the character count', () => {
  // CJK is 3 bytes per char: a "120 char" trim used to emit a 360-byte line.
  const cjk = '缓存策略与失效重试策略'.repeat(40);
  const out = trimTo(cjk, 100);
  assert.ok(Buffer.byteLength(out, 'utf8') <= 100, `got ${Buffer.byteLength(out, 'utf8')} bytes`);
  assert.ok(out.endsWith('…'));
});

test('REGRESSION trimTo never splits an emoji surrogate pair', () => {
  const emoji = '🎉🧠🚀'.repeat(60);
  for (const limit of [8, 10, 12, 13, 20]) {
    const out = trimTo(emoji, limit);
    assert.ok(!out.includes('\uFFFD'), `limit ${limit} produced a replacement char`);
    assert.ok(Buffer.byteLength(out, 'utf8') <= limit, `limit ${limit} overran`);
  }
});

test('REGRESSION the byte ceiling holds even when absurdly small', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  const bank = await loadMemory(sb.root);
  for (const limit of [0, 1, 50, 200, 400, 700]) {
    const fp = buildFingerprint(bank, { maxBytes: limit });
    const bytes = Buffer.byteLength(fp.markdown, 'utf8');
    assert.ok(bytes <= limit, `maxBytes=${limit} produced ${bytes} bytes`);
  }
});

test('REGRESSION a cut fingerprint reports truncated honestly', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  const bank = await loadMemory(sb.root);
  assert.equal(buildFingerprint(bank, { maxBytes: 1500 }).truncated, false);
  assert.equal(buildFingerprint(bank, { maxBytes: 400 }).truncated, true);
  assert.equal(buildFingerprint(bank, { maxBytes: 40 }).data.truncated, true);
});

test('REGRESSION json decisions are exactly the ones markdown rendered', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  for (let i = 1; i <= 6; i++) {
    await sb.write(`.ai/decisions/2026-09-0${i}-rejected-${i}.md`, `# Rejected idea ${i}\n\n**Status:** 🪦 REJECTED\n`);
  }
  const fp = buildFingerprint(await loadMemory(sb.root));
  // Decision lines are indented, carry a status glyph before the date, and live under BINDING.
  // Anchoring on the date alone also matches the header, blockers and session lines.
  const decisionRe = /^ {2}(?!\d{4}-\d{2}-\d{2})(\S+) (\d{4}-\d{2}-\d{2}) (.+?)(?:\s*\[proposal.*)?$/;
  const rendered = fp.markdown
    .split('\n')
    .map((l) => decisionRe.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => `${m[2]} ${m[3]}`.trim());
  const json = fp.data.decisions.map((d) => `${d.date} ${d.title}`);
  assert.ok(rendered.length > 0, 'the seeded bank has decisions to render');
  for (const line of rendered) {
    assert.ok(json.some((j) => j.endsWith(line)), `markdown rendered "${line}" but json omitted it`);
  }
  assert.equal(fp.data.decisions.length, rendered.length, 'json must not list extra decisions');
  assert.ok(
    fp.data.decisions.every((d) => d.status === 'ACCEPTED' || d.status === 'PROPOSAL'),
    'json must not list rejected decisions the fingerprint never renders',
  );
});

test('the current branch reaches the fingerprint', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write(
    '.ai/CURRENT_TASK.md',
    '# Current task\n\n**Status:** 🟡 active\n\n## Code state\n\nBranch `feature/x`, mid-refactor\n\n## Goal\n\nship it\n',
  );
  const fp = buildFingerprint(await loadMemory(sb.root));
  assert.match(fp.markdown, /branch: Branch feature\/x, mid-refactor/);
});

test('an over-long skill list is bounded rather than eating the budget', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  for (let i = 0; i < 40; i++) await sb.write(`.ai/skills/skill-${i}.md`, '# s\n');
  const fp = buildFingerprint(await loadMemory(sb.root));
  assert.ok(Buffer.byteLength(fp.markdown, 'utf8') <= 1500);
  assert.match(fp.markdown, /skills: \/handoff/, 'canonical names are kept');
});