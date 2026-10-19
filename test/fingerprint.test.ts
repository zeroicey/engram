import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadMemory, parseCurrentTask, decisionStatus } from '../src/core/memory.js';
import { buildFingerprint, trimTo } from '../src/core/fingerprint.js';
import { sandbox, seedBank, runCli } from './helpers.js';
import { aiCurrentTask } from '../src/templates/ai-files.js';

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

test('REGRESSION template placeholder prose never reaches the fingerprint', () => {
  // The shipped aiCurrentTask() template carries multi-line `<!-- ... -->` guidance under Goal,
  // Code state, Next action and Blockers. Only the opener line was skipped, so the prose leaked
  // in and every fresh `init` reported the template's own words as project state.
  const pristine = parseCurrentTask(aiCurrentTask({ projectName: 'demo', today: '2026-10-01' }));
  assert.equal(pristine.goal, '', 'template guidance is not a goal');
  assert.equal(pristine.codeState, '');
  assert.equal(pristine.nextAction, '');
  assert.deepEqual(pristine.blockers, []);
});

test('REGRESSION a comment opener line is skipped, not just its continuation', () => {
  const content = [
    '## Goal',
    '<!-- One sentence. It may wrap',
    '     across several lines. -->',
    '',
    'The real goal.',
    '',
  ].join('\n');
  assert.equal(parseCurrentTask(content).goal, 'The real goal.');
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

test('a decision with no status line is UNKNOWN, never classified from prose', () => {
  // `decisionStatus` fell back to the whole document when no status line matched (`header || content`),
  // which re-introduced the very bug the header lookup exists to fix. Measured: a decision titled "Pick A
  // over B" whose body says "We rejected option B because it was slower" loaded as REJECTED — a tombstone,
  // silently excluded from BINDING and from the live count — and "This was accepted after review" would
  // have promoted an unratified note into BINDING. A file with no status is UNKNOWN, which is exactly what
  // doctor's decisions/unclassified finding is for.
  assert.equal(decisionStatus('# Pick A over B\n\nWe rejected option B because it was slower.\n'), 'UNKNOWN');
  assert.equal(decisionStatus('# X\n\nThis was accepted after review.\n'), 'UNKNOWN');
});

test('a fenced example of the status line does not beat the real header', () => {
  // These regexes are `m`-anchored over the whole document and the first match wins, so a template-shaped
  // example *above* the real header won. Every project's own docs quote the template, so this is a
  // realistic file, not a fuzzed one. `titleOf` was already inert-aware; three more lookups were not.
  const fencedProposalThenAccepted = [
    '# X',
    '',
    '```md',
    '**Status:** 💭 PROPOSAL',
    '**Updated:** 1999-01-01',
    '```',
    '',
    '**Status:** ✅ ACCEPTED · **Updated:** 2026-10-19',
    '',
  ].join('\n');
  assert.equal(decisionStatus(fencedProposalThenAccepted), 'ACCEPTED');
  const task = parseCurrentTask(fencedProposalThenAccepted.replace('# X', '# Current task'));
  assert.equal(task.updated, '2026-10-19', 'and Updated is read from the real header too');
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

test('a fence that quotes an HTML comment opener does not swallow the rest of the file', async (t) => {
  // This repository's own docs quote `<!-- engram:contract:start` to talk *about* the marker, so a
  // CURRENT_TASK.md containing that text inside a fenced example is a realistic file, not a fuzzed one.
  // The inert-line tracker computed `opensComment` without checking whether the line was fence body, so
  // the quote started a real comment; that suppressed the fence-delimiter detection, so the closing ```
  // was never seen and `fence` stayed set forever. Every subsequent line was inert: `## Next action` and
  // `## Code state` became invisible, `doctor` reported them MISSING although both were present, and the
  // digest silently dropped `next:` — a state nothing could leave.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write(
    '.ai/CURRENT_TASK.md',
    [
      '# Current task',
      '',
      '**Status:** x',
      '',
      '## Goal',
      '',
      'the real goal',
      '',
      '```md',
      '<!-- engram:contract:start',
      '```',
      '',
      '## Next action',
      '',
      'do the thing',
      '',
      '## Code state',
      '',
      'branch main',
      '',
    ].join('\n'),
  );
  const bank = await loadMemory(sb.root);
  assert.equal(bank.currentTask?.nextAction, 'do the thing', 'the heading after the fence is still read');
  assert.notEqual(bank.currentTask?.codeState, undefined, 'and so is Code state');
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

test('REGRESSION the artefact names every drop its own record reports', async (t) => {
  // The `omitted:` line and the `dropped` list are the same claim in two places, and they disagreed
  // twice before. This is the sweep that catches it: for EVERY budget, whatever `dropped` says must
  // appear on the artefact with the same rendering.
  //
  // It found the `(hard cut)` case. The byte-cut record was pushed onto `dropped` AFTER the notice had
  // been rendered from it, so at budgets 1..419 the artefact listed only the sections while `--json`
  // also said `(hard cut)(all)` — a pasted digest reading as more complete than it was, which is the
  // exact failure the notice exists to prevent. A single-budget assertion cannot see a boundary.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  const bank = await loadMemory(sb.root);

  for (let limit = 1; limit <= 1800; limit++) {
    const fp = buildFingerprint(bank, { maxBytes: limit });
    assert.ok(Buffer.byteLength(fp.markdown, 'utf8') <= limit, `maxBytes=${limit} overran`);

    const line = /omitted: (.*) — full content/.exec(fp.markdown)?.[1] ?? '';
    // Nothing reported as dropped may go unnamed, above the floor where the notice itself cannot fit.
    if (fp.dropped.length > 0 && limit > 430) {
      assert.notEqual(line, '', `maxBytes=${limit} dropped ${fp.dropped.length} block(s) and named none`);
    }
    // And nothing may be named that was not dropped.
    if (fp.dropped.length === 0) assert.equal(line, '', `maxBytes=${limit} named a drop it did not make`);

    // Below the notice floor (a ceiling smaller than the sentence that reports the truncation) the
    // artefact is a cut fragment and `--max-bytes` keeps its promise that it is a ceiling. That tradeoff
    // is deliberate and documented; above the floor, naming is not optional.
    if (limit > 430) {
      for (const d of fp.dropped) {
        const want = `${d.section}(${d.how === 'dropped' ? 'all' : `${d.lines}L`})`;
        assert.ok(line.includes(want), `maxBytes=${limit}: ${want} is in dropped but not on the artefact (${line})`);
      }
    }
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
test('the project goal and the current run are distinguishable, not two things called a goal', async (t) => {
  // The goal engine added `.ai/goal/<id>/BRIEF.md`, which the fingerprint renders as the GOAL block —
  // so a project with an active goal had TWO lines labelled `goal` in one 1400-byte digest, and a fresh
  // session could not tell which one it was supposed to work on. They are different scopes, so they get
  // different words: `project:` is where the repository stands, the GOAL block is the current run.
  const sb = await sandbox('engram-fp-goalwords-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  await runCli(['goal', 'new', 'ship the timer', '--cmd', 'npm test', '--root', sb.root]);

  const fp = buildFingerprint(await loadMemory(sb.root));
  assert.match(fp.markdown, /^project: /m, 'the durable project goal says so');
  assert.match(fp.markdown, /^GOAL$/m);
  assert.match(fp.markdown, /^  run: ship the timer$/m, 'the run is a run');
  assert.equal(
    (fp.markdown.match(/^goal: /gm) ?? []).length,
    0,
    'no line may be labelled `goal` when the GOAL block means something else by it',
  );
});

test('a single-line HTML comment does not swallow the rest of the file', async (t) => {
  // The template opens with `<!-- ... -->` on ONE line. The state machine set `inComment = true` and
  // never checked that same line for the closer, so every heading after it was inert — which meant every
  // scaffolded repository's `## Goal` was invisible to the parser, and the new `missing:` report said so
  // about a file that was perfectly correct. Found by pointing the report at the seven real projects.
  const sb = await sandbox('engram-fp-comment-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  const task = aiCurrentTask({ projectName: 'x', today: '2026-10-19' });
  await sb.write('.ai/CURRENT_TASK.md', task);

  const parsed = parseCurrentTask(task);
  assert.deepEqual(parsed.missing, [], 'a fresh scaffold has every heading');
  assert.deepEqual(parsed.empty.sort(), ['Code state', 'Goal', 'Next action'], 'and they are empty, which is normal');
  // And the fingerprint reports the right diagnosis. A fresh scaffold obeys the contract, so it must NOT
  // be accused of missing headings — it says its state is unwritten, which is true and actionable.
  const fp = buildFingerprint(await loadMemory(sb.root)).markdown;
  assert.doesNotMatch(fp, /missing:/, 'the headings are there');
  assert.match(fp, /empty: no Goal \/ Next action \/ Code state recorded yet/);
});

test('a resolved blocker is not published as a live one', async (t) => {
  // `chime` keeps its history in place: `- ~~微信会话失效~~ ✅ 2026-10-18 已由用户解决`. `dump` published it
  // as a current blocker in every fresh session's fingerprint, competing for the three slots real
  // blockers need.
  const sb = await sandbox('engram-fp-blockers-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  // A whole file, not an appended section: `section()` reads the first `## Blockers` only, so appending a
  // second one to the seeded file would have tested nothing.
  const task = [
    '# Current task',
    '',
    '**Status:** 🟡 active',
    '',
    '## Goal',
    '',
    'Ship it',
    '',
    '## Blockers',
    '',
    '- real blocker — waiting on a human',
    '- ~~already fixed~~ ✅ 2026-10-18 resolved by the user',
    '- ✅ also done, no strikethrough',
    '',
    '## Next action',
    '',
    'Do the thing',
    '',
  ].join('\n');
  await sb.write('.ai/CURRENT_TASK.md', task);
  const parsed = parseCurrentTask(task);
  assert.deepEqual(parsed.blockers, ['real blocker — waiting on a human']);
  const fp = buildFingerprint(await loadMemory(sb.root)).markdown;
  assert.match(fp, /blocked: real blocker/);
  assert.doesNotMatch(fp, /already fixed/);
});

test('a CURRENT_TASK that lost its contract headings says so instead of going quiet', async (t) => {
  // Three of the seven adopted repositories (`clip`, `research`, `teleport`) rewrote `CURRENT_TASK.md`
  // into prose, so their fingerprints silently lost `project:`, `next:` and `branch:`. `research`'s NOW
  // block was **zero bytes**: the file that exists to say what to do said nothing, and nothing said so.
  const sb = await sandbox('engram-fp-missing-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  await sb.write(
    '.ai/CURRENT_TASK.md',
    '# Current task\n\n**Status:** 🟡 in progress\n\n## 我们在做什么\n\n一篇长散文，没有契约要求的标题。\n',
  );
  const parsed = parseCurrentTask(await sb.read('.ai/CURRENT_TASK.md'));
  assert.deepEqual(parsed.missing, ['Goal', 'Next action', 'Code state']);

  const fp = buildFingerprint(await loadMemory(sb.root)).markdown;
  assert.match(fp, /^NOW$/m);
  assert.match(fp, /missing: CURRENT_TASK has no Goal \/ Next action \/ Code state heading/);
  assert.match(fp, /state: 🟡 in progress/, 'the status line still renders');
});

test('an over-budget fingerprint names what it dropped, on the artefact itself', async (t) => {
  // `truncated: true` was the only signal before this, and it is useless to a reader: it says something
  // was left out without saying what, so the fix cannot be chosen. A fingerprint is pasted into a
  // session and its reader never sees stderr, so the omission has to be in the document.
  const sb = await sandbox('engram-fp-omitted-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  const fp = buildFingerprint(await loadMemory(sb.root), { maxBytes: 420 });

  assert.equal(fp.truncated, true);
  assert.ok(fp.dropped.length > 0, 'the drop is reported structurally');
  assert.match(fp.markdown, /^  omitted: /m, 'and on the artefact');
  for (const d of fp.dropped) {
    assert.ok(fp.markdown.includes(d.section), `${d.section} is named in the notice`);
  }
  assert.ok(Buffer.byteLength(fp.markdown, 'utf8') <= 420, 'the ceiling is still a ceiling');
});

test('a budget that only needs trimming keeps every section', async (t) => {
  // Shortening before dropping is the point: the same bytes buy one decision, one session *and* one
  // pitfall rather than three of one kind. This repository hit the failure mode — 11 bytes over after
  // PITFALLS was trimmed to one line — and the single-pass version gave up the entire pitfalls block
  // instead of finding 11 bytes in the recent-sessions block.
  const sb = await sandbox('engram-fp-trim-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  for (let i = 1; i <= 3; i++) await sb.write(`.ai/pitfalls/cases/case-${i}.md`, `# pitfall ${i}\n`);

  const full = buildFingerprint(await loadMemory(sb.root), { maxBytes: 5000 });
  const tight = buildFingerprint(await loadMemory(sb.root), { maxBytes: Buffer.byteLength(full.markdown, 'utf8') - 60 });

  const headingsOf = (md: string): string[] => md.split('\n').filter((l) => /^[A-Z]+$/.test(l));
  for (const heading of headingsOf(full.markdown)) {
    assert.ok(
      headingsOf(tight.markdown).includes(heading),
      `${heading} survived a trim — shortening must be tried before dropping`,
    );
  }
  assert.ok(tight.dropped.some((d) => d.how === 'shortened'), 'and the trim is reported');
  assert.ok(!tight.dropped.some((d) => d.how === 'dropped'), 'nothing was given up entirely');
});

test('a section is not reported as both shortened and dropped', async (t) => {
  // The first version of the shortening pass pushed a `shortened` note and then, when that was not
  // enough, a `dropped` note for the same section — so the notice read "PITFALLS(1L) PITFALLS(all)".
  const sb = await sandbox('engram-fp-both-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  for (let i = 1; i <= 4; i++) await sb.write(`.ai/pitfalls/cases/case-${i}.md`, `# pitfall ${i}\n`);
  const fp = buildFingerprint(await loadMemory(sb.root), { maxBytes: 380 });
  const sections = fp.dropped.map((d) => d.section);
  assert.equal(new Set(sections).size, sections.length, `one entry per section, got ${sections.join(', ')}`);
});

test('sweeping every budget: nothing dropped goes unnamed, and the ceiling never overflows', async (t) => {
  // The probe a reviewer asked for. `truncated`/`dropped` and the `omitted:` line are two statements about
  // one event, and a single-budget assertion cannot see them disagree: the first version of the notice loop
  // assigned `dropped` and then compared it with itself, so it never ran twice, and the notice named a
  // strictly smaller set than the report did at every budget whose slack was under the notice's size.
  const sb = await sandbox('engram-fp-sweep-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  for (let i = 1; i <= 4; i++) await sb.write(`.ai/pitfalls/cases/case-${i}.md`, `# pitfall ${i}\n`);
  const bank = await loadMemory(sb.root);

  const overBudget: number[] = [];
  const unnamed: number[] = [];
  for (let maxBytes = 1; maxBytes <= 1800; maxBytes++) {
    const fp = buildFingerprint(bank, { maxBytes });
    if (Buffer.byteLength(fp.markdown, 'utf8') > maxBytes) overBudget.push(maxBytes);
    // Below the ~87-byte notice there is no room for the sentence that names the loss, and the documented
    // contract is that the byte ceiling wins. Above it, every dropped section must be named.
    if (maxBytes >= 200 && fp.dropped.length > 0 && !fp.markdown.includes('  omitted:')) unnamed.push(maxBytes);
  }
  assert.deepEqual(overBudget, [], 'the ceiling is a ceiling at every value');
  assert.deepEqual(unnamed, [], 'above the notice floor, nothing dropped is unnamed');
});

test('a pitfall’s severity comes from its Severity header', async (t) => {
  // `STATUS_LINE_RE` matches `status:`/`state:` anywhere, and searching for the emoji only inside that one
  // captured line labelled a real pitfall `unknown`: `**Severity:** 🟠 medium` does not match that regex,
  // while a fenced `state: …` further down does. `SEV_RANK` sorts by severity, so a medium pitfall became
  // the first one evicted when PITFALLS is trimmed, and `--json`'s field was wrong.
  const sb = await sandbox('engram-fp-severity-');
  t.after(() => sb.cleanup());
  await seedBank(sb);
  await sb.write(
    '.ai/pitfalls/cases/2026-10-01-shape.md',
    ['# A pitfall whose severity is only in its header', '', '**Severity:** 🟠 medium · **Date:** 2026-10-01', '', '```', 'state: not a status line', '```', ''].join('\n'),
  );
  const bank = await loadMemory(sb.root);
  const entry = bank.pitfalls.find((p) => p.file === '2026-10-01-shape.md');
  assert.equal(entry?.severity, 'medium');
});

test('REGRESSION an identifier with an underscore survives the fingerprint verbatim', async (t) => {
  // `cleanInline` stripped every `*`, `_` and backtick as Markdown decoration, so a memory section
  // naming a real identifier rendered a name that does not exist: `watch_remote.sh` became
  // `watchremote.sh`, and `p_big` became `pbig`. The pitfall was written and its proposed guard was
  // not, so the workaround became "write the identifier without underscores" — which is an
  // instruction to write the wrong name, and on a queue-driven project that is a wrong command.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  await sb.write(
    '.ai/CURRENT_TASK.md',
    [
      '# Current task',
      '',
      '**Status:** 🟡 active · **Updated:** 2026-10-01',
      '',
      '## Goal',
      '',
      'Ship it',
      '',
      '## Next action',
      '',
      '1. Re-attach the watcher: `bash watch_remote.sh`, then check `p_big`',
      '',
      '## Blockers',
      '',
      'none',
    ].join('\n'),
  );
  const out = await runCli(['dump', '--root', sb.root]);
  const text = out.out;
  assert.match(text, /watch_remote\.sh/, 'an inline code span keeps its underscores');
  assert.match(text, /p_big/, 'and so does a bare identifier inside one');
  assert.ok(!/watchremote\.sh/.test(text), 'the mangled name must be gone');
  // Emphasis is still decoration and must still be stripped.
  assert.ok(!/\*/.test(text.split('POINTERS')[0] ?? ''), 'emphasis markers are still removed');
});

test('REGRESSION a pitfall count cap is named, not silently applied', async (t) => {
  // `pitfallN` defaults to 2 and rendered exactly two lines for a bank holding eleven cases, with no
  // `omitted:` notice — because that notice was built only from the sections the *byte budget*
  // dropped. A count limit is the same loss with a different cause, and it is the worse one: the
  // digest silently reads like a project that has two pitfalls, and `--json` agreed with it.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  for (let i = 0; i < 5; i++) {
    await sb.write(
      `.ai/pitfalls/cases/case-${i}.md`,
      `# pitfall number ${i}\n\n**Severity:** 🟠 medium · **Date:** 2026-10-0${i + 1}\n\nSymptom.\n`,
    );
  }
  const out = await runCli(['dump', '--root', sb.root, '--json']);
  const data = JSON.parse(out.out) as { pitfalls: unknown[]; pitfallsTotal: number };
  // `seedBank` ships its own pitfall, so the total is 6 rather than 5 — asserted against the field's
  // own meaning (total >= rendered, difference named) instead of a fixture-dependent constant.
  assert.equal(data.pitfalls.length, 2, 'the rendered list is still bounded');
  assert.equal(data.pitfallsTotal, 6, 'and the total is reported, so "partial" is knowable');
  assert.ok(data.pitfallsTotal > data.pitfalls.length, 'the bank holds more than the digest shows');

  const md = await runCli(['dump', '--root', sb.root]);
  const hidden = data.pitfallsTotal - data.pitfalls.length;
  assert.match(md.out, new RegExp(`… ${hidden} more`), 'the markdown must name what the cap left out');
  assert.match(md.out, /\.ai\/pitfalls\/cases\//, 'and say where to look');
});

test('a bank whose pitfalls all fit says nothing about omissions', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  await sb.write(
    '.ai/pitfalls/cases/only-one.md',
    '# only one\n\n**Severity:** 🟡 low · **Date:** 2026-10-01\n\nSymptom.\n',
  );
  const md = await runCli(['dump', '--root', sb.root]);
  assert.ok(!/more — \.ai\/pitfalls/.test(md.out), 'no phantom omission line when nothing was capped');
});
