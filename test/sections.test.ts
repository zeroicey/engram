import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runInit, runSync } from '../src/commands/init.js';
import { runNewSection } from '../src/commands/new.js';
import { runDump } from '../src/commands/dump.js';
import { aiContract, AI_CONTRACT } from '../src/templates/contract.js';
import { parseSections, sectionFileName } from '../src/core/sections.js';
import { parseSkillFile } from '../src/core/skill-source.js';
import { sandbox } from './helpers.js';

/**
 * The extension surface: a project may add L2 partitions and skills without touching anything
 * engram regenerates.
 *
 * These tests exist because the failure they prevent is silent: before this, a declared section
 * simply never reached a rule file, and a project-authored skill simply never got a carrier. Both
 * looked like the tool working.
 */

const SECTIONS = JSON.stringify({
  version: 1,
  sections: [
    {
      name: 'journal',
      dir: '.ai/journal',
      trigger: 'what happened in the last GPU window',
      writeWhen: 'a GPU window ends',
      file: 'YYYY-MM-DD-night-<slug>.md',
      status: ['📝 DRAFT(auto)', '✅ REVIEWED'],
    },
  ],
});

test('the default contract is pinned to the v1 bytes, not to itself', () => {
  // The upgrade path depends on these exact bytes: an existing repository must see `unchanged`, not
  // a rewrite. The previous version of this test asserted `aiContract() === AI_CONTRACT`, which is a
  // tautology — `AI_CONTRACT` *is* `aiContract()`, so adding a row to the base block or rewriting its
  // prose left the suite green. The digest is taken from `git show v0.3.0:src/templates/contract.ts`
  // (the published block) and must change only with a deliberate `CONTRACT_VERSION` decision.
  assert.equal(Buffer.byteLength(AI_CONTRACT, 'utf8'), 2126);
  assert.equal(
    createHash('sha256').update(AI_CONTRACT).digest('hex'),
    'd1df4b2e5fecbab5f974694219814f581f858a3a88b8ea4a7d044bff8a7da013',
  );
  // Extensions add rows and nothing else: with none declared, the bytes are the frozen block.
  assert.equal(aiContract({ read: [], write: [] }), AI_CONTRACT);
  assert.equal(aiContract(), AI_CONTRACT);
  assert.ok(AI_CONTRACT.includes('| Trigger | Read |'));
  assert.ok(AI_CONTRACT.includes('| Event | Write |'));
});

test('extensions add rows without disturbing the base block', () => {
  // Stripping exactly the added rows must reproduce the frozen block byte for byte — this is what
  // makes the byte-identity claim above meaningful for a repository that *does* declare sections.
  const ext = aiContract({
    read: [{ label: 'journal', target: '.ai/journal/YYYY-MM-DD-night-<slug>.md' }],
    write: [{ label: 'window ends', target: '.ai/journal/' }],
  });
  const stripped = ext
    .split('\n')
    .filter((l) => !l.includes('.ai/journal'))
    .join('\n');
  assert.equal(stripped, AI_CONTRACT, 'the base rows moved or changed when extensions were added');
});

test('parseSections accepts a valid declaration and sorts it for stable output', () => {
  const raw = JSON.stringify({
    version: 1,
    sections: [
      { name: 'zebra', dir: '.ai/zebra', trigger: 'z' },
      { name: 'alpha', dir: '.ai/alpha/', trigger: 'a', writeWhen: 'aw' },
    ],
  });
  const { sections, warnings } = parseSections(raw);
  assert.deepEqual(warnings, []);
  assert.deepEqual(sections.map((s) => s.name), ['alpha', 'zebra']);
  assert.equal(sections[0]?.dir, '.ai/alpha', 'trailing slash is normalised away');
  assert.equal(sections[0]?.writeWhen, 'aw');
});

test('parseSections rejects the shapes that would corrupt the contract, with a warning each', () => {
  const cases: Array<[unknown, RegExp, number]> = [
    ['not json', /invalid JSON/, 0],
    [{ version: 2, sections: [] }, /unsupported version/, 0],
    [{ version: 1, sections: {} }, /must be an array/, 0],
    [{ version: 1, sections: [{ name: 'Bad Name', dir: '.ai/x', trigger: 't' }] }, /kebab-case/, 0],
    [{ version: 1, sections: [{ name: 'x', dir: '/etc', trigger: 't' }] }, /under \.ai\//, 0],
    [{ version: 1, sections: [{ name: 'x', dir: '.ai/../etc', trigger: 't' }] }, /under \.ai\//, 0],
    [{ version: 1, sections: [{ name: 'x', dir: '.ai/decisions', trigger: 't' }] }, /built-in partition/, 0],
    [{ version: 1, sections: [{ name: 'x', dir: '.ai/x' }] }, /"trigger" is required/, 0],
    // A duplicate name drops the *later* entry: the first declaration is the one that keeps
    // working, so a copy-paste mistake cannot silently change an existing section's directory.
    [
      {
        version: 1,
        sections: [
          { name: 'dup', dir: '.ai/a', trigger: 't' },
          { name: 'dup', dir: '.ai/b', trigger: 't' },
        ],
      },
      /duplicate name/,
      1,
    ],
  ];
  for (const [input, pattern, expected] of cases) {
    const raw = typeof input === 'string' ? input : JSON.stringify(input);
    const { sections, warnings } = parseSections(raw);
    assert.equal(sections.length, expected, `wrong section count for ${raw}`);
    assert.ok(
      warnings.some((w) => pattern.test(w)),
      `expected a warning matching ${pattern} for ${raw}, got: ${warnings.join(' | ')}`,
    );
  }
  assert.equal(parseSections(JSON.stringify(cases[8]?.[0]))?.sections[0]?.dir, '.ai/a');
});

test('an absent sections file is not a warning', () => {
  assert.deepEqual(parseSections(null), { sections: [], warnings: [] });
});

test('a declared section reaches every rule file, and removing the declaration removes the rows', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents', 'dsh'] });
  await sb.write('.ai/sections.json', SECTIONS);

  const sync = await runSync(sb.root);
  assert.deepEqual(sync.declaredSections, ['journal']);
  const agents = await sb.read('AGENTS.md');
  assert.ok(agents.includes('| what happened in the last GPU window | `.ai/journal/YYYY-MM-DD-night-<slug>.md` |'));
  assert.ok(agents.includes('| a GPU window ends | `.ai/journal/YYYY-MM-DD-night-<slug>.md` |'));

  // Derived, not authored: deleting the declaration must take the rows with it.
  await sb.write('.ai/sections.json', JSON.stringify({ version: 1, sections: [] }));
  const second = await runSync(sb.root);
  assert.ok(second.ruleFiles.some((f) => f.path === 'AGENTS.md' && f.action === 'updated'));
  assert.equal((await sb.read('AGENTS.md')).includes('journal'), false);
});

test('a malformed sections file warns and leaves the contract alone', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  const before = await sb.read('AGENTS.md');
  await sb.write('.ai/sections.json', '{ this is not json');

  const sync = await runSync(sb.root);
  assert.ok(sync.warnings.some((w) => /invalid JSON/.test(w)));
  assert.equal(await sb.read('AGENTS.md'), before);
  assert.ok(sync.ruleFiles.every((f) => f.action === 'unchanged'));
});

test('the built-in carriers keep their real argument hints when the directory is the source', async (t) => {
  // REGRESSION: making `.ai/skills/` authoritative dropped `argument-hint` from every prompt
  // carrier, because the canonical files carry only `name` + `description`. The carriers changed
  // silently — nothing failed, and `sync` reported success. Compare the generated text, not counts.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['pi'] });
  await runSync(sb.root);

  const handoff = await sb.read('.pi/prompts/handoff.md');
  assert.ok(
    handoff.includes("argument-hint: '[topic] — short slug for the session"),
    `built-in argument hint was lost: ${handoff.split('\n').find((l) => l.startsWith('argument-hint'))}`,
  );
  // A project-authored skill has no built-in hint, so it must get the neutral fallback.
  await sb.write('.ai/skills/nightly.md', '---\nname: nightly\ndescription: d\n---\n\nbody\n');
  await runSync(sb.root);
  assert.ok((await sb.read('.pi/prompts/nightly.md')).includes("argument-hint: 'arguments'"));
});

test('a project-authored skill is materialised into every carrier', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents', 'pi', 'dsh'] });
  await sb.write(
    '.ai/skills/nightly.md',
    '---\nname: nightly\ndescription: Close out a GPU window.\n---\n\nDo the thing.\n',
  );

  await runSync(sb.root);
  assert.ok(await sb.exists('.agents/skills/nightly/SKILL.md'));
  assert.ok(await sb.exists('.pi/prompts/nightly.md'));
  const carrier = await sb.read('.agents/skills/nightly/SKILL.md');
  assert.ok(carrier.includes('name: nightly'));
  assert.ok(carrier.includes('engram:generated'));
  // The prompt sink has no declared argument hint, so it must fall back rather than emit `undefined`.
  assert.ok((await sb.read('.pi/prompts/nightly.md')).includes('argument-hint:'));
});

test('deleting a skill prunes its generated carrier but never a hand-written one', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents', 'dsh'] });
  await sb.write('.ai/skills/nightly.md', '---\nname: nightly\ndescription: d\n---\n\nbody\n');
  await runSync(sb.root);
  // A project-owned skill living in the same carrier directory: no generated marker.
  await sb.write('.agents/skills/handwritten/SKILL.md', '---\nname: handwritten\ndescription: d\n---\n\nmine\n');

  await sb.write('.ai/skills/other.md', '');
  const { promises: fsp } = await import('node:fs');
  await fsp.rm(`${sb.root}/.ai/skills/nightly.md`);
  await fsp.rm(`${sb.root}/.ai/skills/other.md`);

  const sync = await runSync(sb.root);
  assert.ok(sync.pruned.includes('.agents/skills/nightly/SKILL.md'));
  assert.equal(await sb.exists('.agents/skills/nightly/SKILL.md'), false);
  assert.ok(await sb.exists('.agents/skills/handwritten/SKILL.md'), 'hand-written carrier was deleted');
});

test('a skill file without valid frontmatter warns and gets no carrier', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await sb.write('.ai/skills/broken.md', 'no frontmatter here\n');

  const sync = await runSync(sb.root);
  assert.ok(sync.warnings.some((w) => /no YAML frontmatter/.test(w)));
  assert.equal(await sb.exists('.agents/skills/broken/SKILL.md'), false);
});

test('parseSkillFile insists the frontmatter name matches the file name', () => {
  assert.ok(parseSkillFile('a.md', '---\nname: b\ndescription: d\n---\n\nx\n').warning);
  assert.ok(parseSkillFile('a.md', '---\nname: a\n---\n\nx\n').warning, 'description is required');
  const ok = parseSkillFile('a.md', '---\nname: a\ndescription: d\nargument-hint: <x>\n---\n\nx\n');
  assert.equal(ok.warning, null);
  assert.equal(ok.source?.argumentHint, '<x>');
  // A file with no `name` takes it from the stem, which is how the built-ins are written.
  assert.equal(parseSkillFile('a-b.md', "---\ndescription: 'd'\n---\n\nx\n").source?.name, 'a-b');
});

test('engram new scaffolds a declared section from the project template', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await sb.write('.ai/sections.json', SECTIONS);
  await sb.write('.ai/journal/_TEMPLATE.md', '# <slug> journal\n\n**Date:** YYYY-MM-DD\n');

  const res = await runNewSection({
    root: sb.root,
    section: { name: 'journal', dir: '.ai/journal', trigger: 't', file: 'YYYY-MM-DD-night-<slug>.md' },
    title: 'Window 4',
  });
  assert.ok(res.created);
  assert.match(res.path, /^\.ai\/journal\/\d{4}-\d{2}-\d{2}-night-window-4\.md$/);
  const body = await sb.read(res.path);
  assert.ok(body.startsWith('# window-4 journal'), 'the project template decides the shape');
  assert.ok(!body.includes('YYYY-MM-DD'), 'the date placeholder is filled');
});

test('sectionFileName substitutes the date and slug and leaves an unknown placeholder visible', () => {
  const base = { name: 'j', dir: '.ai/j', trigger: 't' };
  assert.equal(sectionFileName({ ...base, file: 'YYYY-MM-DD-night-<slug>.md' }, '2026-10-10', 'w1'), '2026-10-10-night-w1.md');
  assert.equal(sectionFileName({ ...base, file: '<date>-<slug>.md' }, '2026-10-10', 'w1'), '2026-10-10-w1.md');
  assert.equal(sectionFileName({ ...base, file: '<n>-<slug>.md' }, '2026-10-10', 'w1'), '<n>-w1.md');
  assert.equal(sectionFileName(base, '2026-10-10', 'w1'), '2026-10-10-w1.md');
});

test('sync with no readable bank must not delete carriers', async (t) => {
  // REGRESSION: orphan pruning infers "this carrier has no canonical skill" from an empty skill
  // list, and an unreadable bank also produces an empty list. `sync --root <typo>` therefore wiped
  // every generated carrier in `.pi/prompts/` and `.agents/skills/` while reporting success.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['pi', 'agents'] });
  assert.ok(await sb.exists('.pi/prompts/handoff.md'));

  const { promises: fsp } = await import('node:fs');
  await fsp.rm(`${sb.root}/.ai`, { recursive: true, force: true });

  const sync = await runSync(sb.root);
  assert.equal(sync.needsInit, true);
  assert.deepEqual(sync.pruned, [], 'a missing bank is not an authority to delete anything');
  for (const rel of ['.pi/prompts/handoff.md', '.pi/prompts/audit.md', '.agents/skills/handoff/SKILL.md']) {
    assert.ok(await sb.exists(rel), `${rel} was deleted by a sync that could not read the bank`);
  }
});

test('sync with an unreadable .ai/skills/ must not delete carriers either', async (t) => {
  // The same conflation one level down, and the more dangerous one: `.ai/` exists but the canonical
  // directory is gone, so the carriers are the ONLY copy of every skill body. Guarding on "does
  // `.ai/` exist" left this hole wide open — deleting `.ai/skills/` emptied every carrier dir.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['pi', 'agents'] });
  const carriers = ['.pi/prompts/handoff.md', '.agents/skills/handoff/SKILL.md', '.agents/skills/audit/SKILL.md'];

  const { promises: fsp } = await import('node:fs');
  await fsp.rm(`${sb.root}/.ai/skills`, { recursive: true, force: true });
  const sync = await runSync(sb.root);
  assert.equal(sync.needsInit, false, '.ai/ itself still exists — this is the case the guard missed');
  assert.deepEqual(sync.pruned, []);
  assert.ok(sync.warnings.some((w) => /Cannot read \.ai\/skills\//.test(w)), 'the protection must be announced');
  for (const rel of carriers) assert.ok(await sb.exists(rel), `${rel} was deleted`);
});

test('a hand-written carrier that merely mentions the marker survives', async (t) => {
  // REGRESSION: the generated check was `content.includes('<!-- engram:generated -->')`, so a
  // hand-written skill explaining how carriers are stamped was itself deleted — the exact opposite
  // of the promise in the pruner's docstring. Only a whole generated header line counts now.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await sb.write(
    '.agents/skills/engram-notes/SKILL.md',
    '---\nname: engram-notes\ndescription: mine\n---\n\nCarriers are stamped `<!-- engram:generated -->` by sync.\n',
  );
  await sb.write('.agents/skills/notes.md', '# notes\n\nSee <!-- engram:generated --> in every carrier.\n');

  const sync = await runSync(sb.root);
  assert.deepEqual(sync.pruned, []);
  assert.ok(await sb.exists('.agents/skills/engram-notes/SKILL.md'));
  assert.ok(await sb.exists('.agents/skills/notes.md'));
});

test('pruning will not follow a symlink out of the repository', async (t) => {
  // `pathExists`/`readFileSafe`/`fs.rm` all traverse symlinks, so a symlinked carrier directory
  // pointing outside the repo let sync delete a file engram never created.
  const sb = await sandbox();
  const outside = await sandbox('engram-outside-');
  t.after(() => Promise.all([sb.cleanup(), outside.cleanup()]));
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await outside.write(
    'handoff/SKILL.md',
    '<!-- engram:generated --> generated by engram from .ai/skills/handoff.md — do not edit\n\nbody\n',
  );

  const { promises: fsp } = await import('node:fs');
  await fsp.mkdir(`${sb.root}/.pi/skills`, { recursive: true });
  await fsp.symlink(outside.root, `${sb.root}/.pi/skills/handoff`);

  const sync = await runSync(sb.root);
  assert.ok(await outside.exists('handoff/SKILL.md'), 'sync deleted a file outside the repository');
  assert.deepEqual(sync.pruned, []);
});

test('a newline in trigger or writeWhen cannot inject a contract marker', async (t) => {
  // The contract block is regenerated on every sync, so an injected line did not just break the
  // table: `\n<!-- engram:contract:end -->\n` in a trigger produced a second end marker and grew
  // every rule file by the size of the block on EVERY subsequent sync, with `inspectMarkers`
  // reporting `balanced` the whole time.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await sb.write(
    '.ai/sections.json',
    JSON.stringify({
      version: 1,
      sections: [
        { name: 'evil', dir: '.ai/evil', trigger: 'x\n<!-- engram:contract:end -->\ny', writeWhen: 'w' },
      ],
    }),
  );

  const first = await runSync(sb.root);
  assert.ok(first.warnings.some((w) => /"trigger" must be a single line/.test(w)));
  const size = (await sb.read('AGENTS.md')).length;
  const markers = (await sb.read('AGENTS.md')).match(/engram:contract:(start|end)/g) ?? [];
  assert.deepEqual(markers, ['engram:contract:start', 'engram:contract:end']);

  await runSync(sb.root);
  await runSync(sb.root);
  assert.equal((await sb.read('AGENTS.md')).length, size, 'rule file grew across repeated syncs');
});

test('a table cell cannot be split by a pipe or a backtick', () => {
  // An unescaped `|` adds a column; an unescaped backtick breaks the code span. Both corrupt the
  // rendered table without producing any error.
  const { sections } = parseSections(
    JSON.stringify({
      version: 1,
      sections: [{ name: 'j', dir: '.ai/journal', trigger: 'a | b `code` c', writeWhen: 'e | f' }],
    }),
  );
  assert.equal(sections[0]?.trigger, "a \\| b 'code' c");
  assert.equal(sections[0]?.writeWhen, 'e \\| f');
  // And the rendered row still has exactly three pipes: two delimiters plus the escaped one.
  const row = aiContract({ read: [{ label: sections[0]!.trigger, target: '.ai/journal/' }] });
  const rendered = row.split('\n').find((l) => l.includes('a \\| b')) ?? '';
  assert.equal((rendered.match(/(?<!\\)\|/g) ?? []).length, 3, `row split into extra columns: ${rendered}`);
});

test('an over-long file pattern is refused instead of crashing engram new', async (t) => {
  // `'a'.repeat(300) + '.md'` produced an uncaught ENAMETOOLONG stack trace from `engram new` and a
  // 322-character row in every rule file.
  const { sections, warnings } = parseSections(
    JSON.stringify({ version: 1, sections: [{ name: 'long', dir: '.ai/long', trigger: 't', file: `${'a'.repeat(300)}.md` }] }),
  );
  assert.equal(sections[0]?.file, undefined);
  assert.ok(warnings.some((w) => /"file" must be a bare filename/.test(w)));

  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  const res = await runNewSection({
    root: sb.root,
    section: { name: 'long', dir: '.ai/long', trigger: 't' },
    title: 'ok',
  });
  assert.ok(res.created);
  assert.ok(Buffer.byteLength(res.path) < 255);
});

test('a retired sink dir is pruned, but only its generated files', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  // What engram used to write, plus a hand-written skill in the same retired directory.
  const generated = await sb.read('.agents/skills/handoff/SKILL.md');
  await sb.write('.pi/skills/handoff/SKILL.md', generated);
  await sb.write('.pi/skills/net-access/SKILL.md', '---\nname: net-access\ndescription: mine\n---\n\nbody\n');
  // The hand-written file above proves nothing on its own: loop 1 only ever considers the built-in
  // skill names, so `net-access` is never a candidate and its survival is guaranteed by the loop
  // bounds rather than by the marker check. A hand-written file named after a *built-in* is what
  // actually exercises that guard — removing the marker check used to delete it with the suite green.
  await sb.write('.pi/skills/audit/SKILL.md', '---\nname: audit\ndescription: mine, same name as a built-in\n---\n\nbody\n');

  const sync = await runSync(sb.root);
  assert.ok(sync.pruned.includes('.pi/skills/handoff/SKILL.md'));
  assert.equal(await sb.exists('.pi/skills/handoff/SKILL.md'), false);
  assert.ok(await sb.exists('.pi/skills/net-access/SKILL.md'), 'hand-written file in a retired dir was deleted');
  assert.ok(
    await sb.exists('.pi/skills/audit/SKILL.md'),
    'a hand-written file named after a built-in was deleted from a retired dir — the marker check is gone',
  );
});

test('a section cannot shadow a built-in verb or partition name', () => {
  // `engram new session …` must keep meaning `.ai/sessions/`. A declared section named after a
  // built-in verb would win the CLI dispatch and silently change an existing command. The *plural*
  // partition names are the subtler collision: `{name: "decisions", dir: ".ai/dec2"}` was accepted,
  // and then `engram new decisions` wrote to `.ai/dec2/` while the contract's read table still sent
  // agents — and `/remember-decision` — to `.ai/decisions/`, leaving two contradictory rows.
  for (const name of [
    'decision',
    'session',
    'pitfall',
    'runbook',
    'decisions',
    'sessions',
    'pitfalls',
    'runbooks',
    'skills',
    'sections',
  ]) {
    const { sections, warnings } = parseSections(
      JSON.stringify({ version: 1, sections: [{ name, dir: '.ai/other', trigger: 't' }] }),
    );
    assert.equal(sections.length, 0, `${name} shadowed a built-in verb or partition`);
    assert.ok(
      warnings.some((w) => /built-in partition or `engram new` verb/.test(w)),
      `${name} was refused without saying why`,
    );
  }
});

test('a declared path can never escape .ai/ — traversal, separators and control characters', async (t) => {
  // `engram new` writes to a path derived from project-owned JSON. A typo like
  // `"file": "../../../etc/passwd"` was joined straight onto the section dir and written outside
  // the repository, so the pattern is now an allowlist rather than a blacklist.
  const rejectedDir = ['.ai/../etc', '.ai/../../etc', '/etc', 'etc/passwd', '.ai', '.ai/', '~', 'C:\\x', '.ai/jo\u0000urnal', '.ai/a b'];
  for (const dir of rejectedDir) {
    const { sections, warnings } = parseSections(JSON.stringify({ version: 1, sections: [{ name: 'j', dir, trigger: 't' }] }));
    assert.equal(sections.length, 0, `${JSON.stringify(dir)} was accepted as a section dir`);
    assert.ok(warnings.length > 0, `no warning for ${JSON.stringify(dir)}`);
  }

  // A bad `file` pattern costs the pattern, not the section: the row still reaches the contract
  // with the safe default, and the user is told exactly what was ignored.
  const badFiles = ['../../../etc/passwd', 'sub/x.md', 'a\\b.md', 'x\u0000.md', '..', '.'];
  for (const file of badFiles) {
    const { sections, warnings } = parseSections(
      JSON.stringify({ version: 1, sections: [{ name: 'j', dir: '.ai/journal', trigger: 't', file }] }),
    );
    assert.equal(sections.length, 1, `${JSON.stringify(file)} should not reject the whole section`);
    assert.equal(sections[0]?.file, undefined, `${JSON.stringify(file)} was kept as a file pattern`);
    assert.ok(warnings.some((w) => /"file" must be a bare filename/.test(w)), `no warning for ${JSON.stringify(file)}`);
  }

  // And the writer refuses independently, so a CustomSection built by a library caller cannot
  // bypass validation that only exists in the JSON parser.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await assert.rejects(
    runNewSection({
      root: sb.root,
      section: { name: 'evil', dir: '.ai/journal', trigger: 't', file: '../../../../etc/passwd' },
      title: 'x',
    }),
    /refusing to write outside/,
  );
  // The refusal is what matters; asserting `/tmp/etc/passwd` does not exist would be a claim about
  // the host filesystem, and a pre-existing file there would fail this test spuriously.
  assert.equal(await sb.exists('.ai/journal/../../../etc/passwd'), false);
});

test('CRLF and BOM frontmatter parse the same as LF', () => {
  // JavaScript's `.` does not match `\r`, so a CRLF file made `(.*)$` fail on every line and the
  // skill was reported as having no description. A BOM stops `^---` matching at position 0. Both
  // are produced routinely by Windows editors and `core.autocrlf=true` checkouts, and in both cases
  // the file is correct and the parser was wrong.
  const lf = parseSkillFile('a.md', '---\nname: a\ndescription: does a thing\n---\n\nbody\n');
  const crlf = parseSkillFile('a.md', '---\r\nname: a\r\ndescription: does a thing\r\n---\r\n\r\nbody\r\n');
  const bom = parseSkillFile('a.md', '\uFEFF---\nname: a\ndescription: does a thing\n---\n\nbody\n');
  const bomCrlf = parseSkillFile('a.md', '\uFEFF---\r\nname: a\r\ndescription: does a thing\r\n---\r\n\r\nbody\r\n');

  assert.equal(lf.warning, null);
  for (const [label, parsed] of [['CRLF', crlf], ['BOM', bom], ['BOM+CRLF', bomCrlf]] as const) {
    assert.equal(parsed.warning, null, `${label}: ${parsed.warning}`);
    assert.equal(parsed.source?.description, 'does a thing', `${label} lost the description`);
    assert.equal(parsed.source?.name, 'a', `${label} lost the name`);
    assert.equal(parsed.source?.body, 'body', `${label} mangled the body (off-by-one on the BOM?)`);
  }
});

test('dump advertises declared sections so an agent learns they exist', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await sb.write('.ai/sections.json', SECTIONS);

  const dump = await runDump({ root: sb.root });
  assert.ok(dump.markdown.includes('sections: journal → .ai/journal/YYYY-MM-DD-night-<slug>.md'));
  assert.ok(dump.bytes <= 1500);
});

test('a UTF-8 BOM in sections.json must not disable every declared section', () => {
  // A BOM is not whitespace, so `JSON.parse` rejected the whole file and every declared section
  // silently vanished while the file looked correct to the user. `parseSkillFile` already stripped
  // one; this path did not.
  const raw = `\uFEFF${JSON.stringify({ version: 1, sections: [{ name: 'j', dir: '.ai/j', trigger: 't' }] })}`;
  const { sections, warnings } = parseSections(raw);
  assert.equal(sections.length, 1, 'a BOM disabled the whole extension surface');
  assert.deepEqual(warnings, []);
});

test('a quoted version number is accepted instead of contradicting itself', () => {
  // `version: "1"` used to be rejected with "unsupported version 1 — expected 1", which tells the
  // reader nothing. Either accept it or name the type; it is accepted.
  const { sections, warnings } = parseSections(
    JSON.stringify({ version: '1', sections: [{ name: 'j', dir: '.ai/j', trigger: 't' }] }),
  );
  assert.equal(sections.length, 1);
  assert.deepEqual(warnings, []);
  const bad = parseSections(JSON.stringify({ version: 2, sections: [] }));
  assert.ok(bad.warnings.some((w) => /expected the number 1/.test(w)));
});

test('a YAML block scalar is refused by name, not silently reduced to ">"', () => {
  // `description: >` with indented continuation lines parsed as the literal string `">"` and dropped
  // the continuation — the skill loaded with `>` as its routing signal, with no warning.
  const folded = parseSkillFile('a.md', '---\nname: a\ndescription: >\n  first line\n  second\n---\n\nx\n');
  assert.equal(folded.source, null);
  assert.match(folded.warning ?? '', /block scalar/);
  assert.match(folded.warning ?? '', /"description"/);
  const literal = parseSkillFile('a.md', '---\nname: a\ndescription: |\n  one\n---\n\nx\n');
  assert.match(literal.warning ?? '', /block scalar/);
  // The normal one-line form still parses.
  assert.equal(parseSkillFile('a.md', '---\nname: a\ndescription: plain\n---\n\nx\n').source?.description, 'plain');
});

test('engram new <section> refuses to clobber unless forced', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  const section = { name: 'journal', dir: '.ai/journal', trigger: 't' };
  assert.equal((await runNewSection({ root: sb.root, section, title: 'Window 4' })).created, true);
  assert.equal((await runNewSection({ root: sb.root, section, title: 'Window 4' })).created, false);
  assert.equal((await runNewSection({ root: sb.root, section, title: 'Window 4', force: true })).created, true);
});

test('engram new <section> falls back to a stub when no template exists', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  const res = await runNewSection({
    root: sb.root,
    section: { name: 'journal', dir: '.ai/journal', trigger: 't', status: ['📝 DRAFT'] },
    title: 'Window 4',
  });
  const body = await sb.read(res.path);
  assert.ok(body.startsWith('# Window 4'), `stub did not start with the title: ${body.slice(0, 40)}`);
  assert.ok(body.includes('**Status:** 📝 DRAFT'));
});

test('a section whose dir is a file fails with a sentence, not a raw EEXIST', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await sb.write('.ai/journal', 'i am a file\n');
  await assert.rejects(
    runNewSection({ root: sb.root, section: { name: 'journal', dir: '.ai/journal', trigger: 't' }, title: 'x' }),
    /is a file, not a directory/,
  );
});

test('a _-prefixed skill file is inert and does not warn', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await sb.write('.ai/skills/_template.md', '---\nname: _template\ndescription: d\n---\n\nx\n');
  const sync = await runSync(sb.root);
  assert.equal(await sb.exists('.agents/skills/_template/SKILL.md'), false);
  assert.ok(!sync.warnings.some((w) => w.includes('_template')), 'a template must not warn');
});

test('sync --dry-run with sections reports the same actions and writes nothing', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await sb.write(
    '.ai/sections.json',
    JSON.stringify({ version: 1, sections: [{ name: 'journal', dir: '.ai/journal', trigger: 't', writeWhen: 'w' }] }),
  );
  const before = await sb.read('AGENTS.md');
  const dry = await runSync(sb.root, [], true);
  assert.equal(await sb.read('AGENTS.md'), before, 'dry-run wrote a rule file');
  assert.ok(dry.ruleFiles.some((f) => f.path === 'AGENTS.md' && f.action === 'updated'));
  const real = await runSync(sb.root, [], false);
  assert.deepEqual(dry.ruleFiles, real.ruleFiles, 'dry-run disagrees with the real run');
});

test('sync refuses to write a carrier through a symlink out of the project', async (t) => {
  // `fs.writeFile` follows symlinks, so a symlinked carrier made sync overwrite a file the project
  // never asked engram to own — a real setup, since redirecting a generated dir is a common trick.
  const sb = await sandbox();
  const outside = await sandbox('engram-outside-');
  t.after(() => Promise.all([sb.cleanup(), outside.cleanup()]));
  await runInit({ root: sb.root, toolIds: ['agents'] });

  const { promises: fsp } = await import('node:fs');
  await outside.write('target.md', 'MY OWN NOTES — do not touch\n');
  await fsp.mkdir(`${sb.root}/.agents/skills/foo`, { recursive: true });
  await fsp.symlink(`${outside.root}/target.md`, `${sb.root}/.agents/skills/foo/SKILL.md`);
  await sb.write('.ai/skills/foo.md', '---\nname: foo\ndescription: canonical\n---\n\nCANONICAL\n');

  await runSync(sb.root);
  assert.equal(await outside.read('target.md'), 'MY OWN NOTES — do not touch\n', 'sync wrote outside the repo');
  assert.equal(await sb.exists('.agents/skills/foo/SKILL.md'), true, 'the carrier should be a real file now');

  // A symlinked *directory* has nowhere safe to write, so it is refused outright.
  const q = await sandbox();
  const outDir = await sandbox('engram-outside-dir-');
  t.after(() => Promise.all([q.cleanup(), outDir.cleanup()]));
  await runInit({ root: q.root, toolIds: ['agents'] });
  await fsp.rm(`${q.root}/.agents/skills`, { recursive: true, force: true });
  await fsp.symlink(outDir.root, `${q.root}/.agents/skills`);
  const sync = await runSync(q.root);
  assert.ok(sync.warnings.some((w) => /symlinked directory/.test(w)), 'the refusal must be announced');
  assert.deepEqual(await fsp.readdir(outDir.root), [], 'sync populated a directory outside the project');
});

test('declaring a section must not evict pitfalls from the fingerprint', async (t) => {
  // The sections line went into POINTERS (priority 4, never dropped), while fitToBudget drops
  // priorities 3→2→1. So one declaration evicted the whole PITFALLS block, then RECENT, then the
  // binding decisions: the new feature outranked the content it exists to complement.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  for (let i = 1; i <= 5; i++) {
    await sb.write(
      `.ai/decisions/2026-10-0${i}-topic${i}.md`,
      `---\nstatus: ACCEPTED\n---\n# decision ${'A'.repeat(100)} ${i}\n`,
    );
  }
  for (let i = 1; i <= 3; i++) await sb.write(`.ai/sessions/2026-10-0${i}-s${i}-handoff.md`, `# s ${'B'.repeat(100)}\n`);
  for (let i = 1; i <= 3; i++) await sb.write(`.ai/pitfalls/cases/case-${i}.md`, `# pitfall ${'C'.repeat(100)}\n`);

  const before = (await runDump({ root: sb.root, maxBytes: 1270 })).markdown;
  assert.match(before, /^PITFALLS$/m, 'fixture does not exercise the budget');
  await sb.write(
    '.ai/sections.json',
    JSON.stringify({
      version: 1,
      sections: [
        {
          name: 'journal',
          dir: '.ai/journal',
          trigger: 'nightly experiment window wrap-up and review',
          writeWhen: 'window ends',
        },
      ],
    }),
  );
  const after = (await runDump({ root: sb.root, maxBytes: 1270 })).markdown;
  assert.match(after, /^PITFALLS$/m, 'declaring a section evicted the pitfalls block');
  assert.match(after, /^BINDING$/m);
});

test('dump never emits more bytes than --max-bytes', async (t) => {
  // The budget was applied to the markdown, then cli.ts appended a framing newline for stdout only,
  // so `dump --max-bytes 50 | wc -c` reported 51 while stderr said "50 bytes · at budget".
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  for (const maxBytes of [50, 100, 338, 400, 1270]) {
    const { markdown } = await runDump({ root: sb.root, maxBytes });
    const emitted = markdown.endsWith('\n') ? markdown : `${markdown}\n`;
    assert.ok(
      Buffer.byteLength(emitted, 'utf8') <= maxBytes,
      `--max-bytes ${maxBytes} emitted ${Buffer.byteLength(emitted, 'utf8')} bytes`,
    );
  }
});
