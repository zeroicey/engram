import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { runInit, runSync } from '../src/commands/init.js';
import { runDump, renderDump } from '../src/commands/dump.js';
import { isMemoryKind, renderNewFile, runNew } from '../src/commands/new.js';
import { AI_CONTRACT, CONTRACT_START } from '../src/templates/contract.js';
import { SKILL_NAMES } from '../src/templates/skills.js';
import { detectProject } from '../src/core/project.js';
import { sandbox } from './helpers.js';

const TOOL_SET = ['agents', 'claude', 'cursor', 'pi', 'copilot', 'gemini', 'windsurf', 'codex'];

test('init creates the bank, rule files, carriers and the bootstrap prompt', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write('package.json', JSON.stringify({ name: '@acme/widget', scripts: { build: 'tsc' } }));

  const res = await runInit({ root: sb.root, toolIds: TOOL_SET });

  assert.ok(res.files.every((f) => f.action === 'created'));
  for (const rel of [
    '.ai/README.md',
    '.ai/ARCHITECTURE.md',
    '.ai/CURRENT_TASK.md',
    '.ai/skills/handoff.md',
    'AGENTS.md',
    'CLAUDE.md',
    '.cursor/rules/engram-memory.mdc',
    '.windsurf/rules/engram-memory.md',
    '.github/copilot-instructions.md',
    '.gemini/commands/handoff.toml',
    '.github/prompts/handoff.prompt.md',
    '.claude/skills/handoff/SKILL.md',
    '.pi/skills/handoff/SKILL.md',
    '.pi/prompts/handoff.md',
    '.agents/skills/handoff/SKILL.md',
    '.engram/BOOTSTRAP.md',
  ]) {
    assert.ok(await sb.exists(rel), `init did not create ${rel}`);
  }

  assert.equal(await sb.exists('.claude/commands/handoff.md'), false, 'a skill shadows a same-named command');
  const bootstrap = await sb.read('.engram/BOOTSTRAP.md');
  assert.ok(bootstrap.includes('widget'), 'project name from package.json is used');
  assert.ok(bootstrap.includes('AGENTS.md') && bootstrap.includes('CLAUDE.md'));
  assert.ok(bootstrap.includes('## Task'), 'the meta-prompt must be actionable');
});

test('init preserves an existing AGENTS.md body and appends the contract', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write('AGENTS.md', '# House rules\n\nNever touch the deploy scripts.\n');

  await runInit({ root: sb.root, toolIds: ['agents', 'pi'] });

  const agents = await sb.read('AGENTS.md');
  assert.ok(agents.includes('Never touch the deploy scripts.'));
  assert.ok(agents.includes(AI_CONTRACT));
  assert.equal(agents.split(CONTRACT_START).length - 1, 1, 'exactly one contract block');
});

test('init is idempotent: a second run creates nothing and changes nothing', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents', 'claude'] });
  const snapshot = new Map<string, string>();
  for (const rel of ['AGENTS.md', 'CLAUDE.md', '.ai/README.md', '.claude/skills/handoff/SKILL.md']) {
    snapshot.set(rel, await sb.read(rel));
  }

  const second = await runInit({ root: sb.root, toolIds: ['agents', 'claude'] });
  assert.ok(
    second.files.every((f) => f.action === 'kept'),
    'second init must not create files',
  );
  for (const [rel, content] of snapshot) {
    assert.equal(await sb.read(rel), content, `${rel} changed on re-init`);
  }
});

test('init --dry-run writes nothing', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  const res = await runInit({ root: sb.root, toolIds: ['agents'], dryRun: true });
  assert.ok(res.files.some((f) => f.action === 'created'));
  assert.equal(await sb.exists('.ai/README.md'), false);
  assert.equal(await sb.exists('AGENTS.md'), false);
});

test('init reports unknown tools instead of crashing', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  const res = await runInit({ root: sb.root, toolIds: ['agents', 'emacs-ai'] });
  assert.match(res.warnings.join(' '), /Unknown tool "emacs-ai"/);
  assert.ok(await sb.exists('AGENTS.md'));
});

test('sync refreshes a damaged contract and re-materialises carriers', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents', 'claude'] });
  await sb.write('AGENTS.md', (await sb.read('AGENTS.md')).replace(AI_CONTRACT, 'broken'));
  await sb.write('.claude/skills/handoff/SKILL.md', 'hand-edited\n');

  const res = await runSync(sb.root, ['agents', 'claude']);

  assert.ok(res.ruleFiles.find((f) => f.path === 'AGENTS.md')?.action === 'updated');
  assert.ok((await sb.read('AGENTS.md')).includes(AI_CONTRACT));
  const skill = await sb.read('.claude/skills/handoff/SKILL.md');
  assert.ok(skill.includes('<!-- engram:generated -->'), 'hand edits to carriers are replaced');

  const again = await runSync(sb.root, ['agents', 'claude']);
  assert.ok(again.ruleFiles.every((f) => f.action === 'unchanged'), 'sync must be idempotent');
});

test('sync warns about canonical skills missing from .ai/skills/', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  await fs.rm(`${sb.root}/.ai/skills/audit.md`);
  const res = await runSync(sb.root, ['agents']);
  assert.deepEqual(res.missingSkills, ['audit']);
});

test('dump renders a fingerprint after init and stays in budget', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });

  const result = await runDump({ root: sb.root });
  assert.equal(result.exitCode, 0);
  assert.ok(result.bytes <= 1500);
  assert.match(result.markdown, /^# engram v1/);
  assert.match(result.markdown, /POINTERS/);
  for (const skill of SKILL_NAMES) assert.ok(result.markdown.includes(`/${skill}`));
});

test('dump without a bank exits 2 with an actionable hint', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  const result = await runDump({ root: sb.root });
  assert.equal(result.exitCode, 2);
  assert.match(renderDump(result, 'markdown'), /engram init/);
});

test('dump --json emits the structured view', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  const result = await runDump({ root: sb.root });
  const parsed = JSON.parse(renderDump(result, 'json')) as { project: string; skills: string[] };
  assert.equal(typeof parsed.project, 'string');
  assert.deepEqual([...parsed.skills].sort(), SKILL_NAMES.map((n) => `/${n}`).sort());
});

test('new scaffolds each memory kind from the shared section skeleton', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });

  const cases: Array<{ kind: 'decision' | 'session' | 'pitfall' | 'runbook'; title: string; pattern: RegExp }> = [
    { kind: 'decision', title: 'adopt redis', pattern: /^\.ai\/decisions\/\d{4}-\d{2}-\d{2}-adopt-redis\.md$/ },
    {
      kind: 'session',
      title: 'cache work',
      pattern: /^\.ai\/sessions\/\d{4}-\d{2}-\d{2}-cache-work-handoff\.md$/,
    },
    {
      kind: 'pitfall',
      title: 'flaky timer tests',
      pattern: /^\.ai\/pitfalls\/cases\/\d{4}-\d{2}-\d{2}-flaky-timer-tests\.md$/,
    },
    { kind: 'runbook', title: 'nightly backups', pattern: /^\.ai\/runbooks\/\d{4}-\d{2}-\d{2}-nightly-backups\.md$/ },
  ];
  const created = new Map<string, string>();
  for (const { kind, title, pattern } of cases) {
    const res = await runNew({ root: sb.root, kind, title });
    assert.equal(res.created, true);
    assert.match(res.path, pattern);
    created.set(kind, res.path);
  }

  const decisionPath = created.get('decision') ?? '';
  assert.ok(decisionPath, 'decision file was created');
  assert.match(await sb.read(decisionPath), /\*\*Status:\*\* 💭 PROPOSAL/);
  assert.match(await sb.read(decisionPath), /^# adopt redis/m);

  const second = await runNew({ root: sb.root, kind: 'decision', title: 'adopt redis' });
  assert.equal(second.created, false, 'same title on same day must not overwrite');
});

test('new validates its kind', () => {
  assert.equal(isMemoryKind('decision'), true);
  assert.equal(isMemoryKind('ideas'), false);
  assert.match(renderNewFile('pitfall', 'X'), /Severity/);
});

test('project detection reads stack, scripts and existing rule files', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write('package.json', JSON.stringify({ name: 'widget', engines: { node: '>=20' }, scripts: { test: 'x' } }));
  await sb.write('CLAUDE.md', '# rules');
  await sb.write('requirements.txt', '');

  // Rule-file candidates now come from the registry, not from a hardcoded list in core/.
  const facts = await detectProject(sb.root, ['AGENTS.md', 'CLAUDE.md', '.cursorrules']);
  assert.equal(facts.name, 'widget');
  assert.ok(facts.stack.includes('node'));
  assert.ok(facts.stack.includes('python'));
  assert.deepEqual(facts.existingRuleFiles, ['CLAUDE.md']);
  assert.deepEqual(
    await detectProject(sb.root, []).then((f) => f.existingRuleFiles),
    [],
    'with no candidates the leaf layer knows nothing about vendors',
  );
  assert.equal(facts.hasGit, false);
});

