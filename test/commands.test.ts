import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { runInit, runSync } from '../src/commands/init.js';
import { runDump, renderDump } from '../src/commands/dump.js';
import { isMemoryKind, renderNewFile, runNew } from '../src/commands/new.js';
import { AI_CONTRACT, CONTRACT_START } from '../src/templates/contract.js';
import { SKILL_NAMES } from '../src/templates/skills.js';
import { generatedHeader } from '../src/adapters/rules.js';
import { detectProject } from '../src/core/project.js';
import { sandbox } from './helpers.js';

const TOOL_SET = ['agents', 'claude', 'cursor', 'pi', 'copilot', 'gemini', 'windsurf', 'codex', 'dsh'];

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
    '.pi/prompts/handoff.md',
    '.agents/skills/handoff/SKILL.md',
    '.engram/BOOTSTRAP.md',
    '.engram/config.json',
  ]) {
    assert.ok(await sb.exists(rel), `init did not create ${rel}`);
  }

  assert.equal(
    await sb.exists('.pi/skills/handoff/SKILL.md'),
    false,
    'REGRESSION: .pi/skills duplicates .agents/skills, which Pi scans too — collision warning',
  );
  const config = JSON.parse(await sb.read('.engram/config.json')) as { version: number; tools: string[] };
  assert.equal(config.version, 1);
  assert.deepEqual([...config.tools].sort(), [...TOOL_SET].sort(), 'init records the chosen tool set');

  assert.equal(await sb.exists('.claude/commands/handoff.md'), false, 'a skill shadows a same-named command');
  const bootstrap = await sb.read('.engram/BOOTSTRAP.md');
  assert.ok(bootstrap.includes('widget'), 'project name from package.json is used');
  assert.ok(bootstrap.includes('AGENTS.md') && bootstrap.includes('CLAUDE.md'));
  assert.ok(bootstrap.includes('## Task'), 'the meta-prompt must be actionable');
});

test('REGRESSION init never modifies a single file inside .ai/', async (t) => {
  // A memory tool that overwrites the memory is self-defeating. An earlier shared write helper
  // rewrote any bank file whose content differed from the template, and running `engram init` on
  // this repository replaced its hand-written CURRENT_TASK.md and ARCHITECTURE.md — committed as
  // placeholders. `init` may only ever add missing files.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });

  const handwritten: Record<string, string> = {
    '.ai/CURRENT_TASK.md': '# Current task\n\n**Status:** 🟡 active\n\n## Goal\n\nMy real goal.\n',
    '.ai/ARCHITECTURE.md': '# Architecture\n\n## 1. Purpose\n\nSomething only I know.\n',
    '.ai/README.md': '# .ai/\n\nMy own index.\n',
    '.ai/decisions/2026-01-01-mine.md': '# Mine\n\n**Status:** ✅ ACCEPTED\n',
  };
  for (const [rel, content] of Object.entries(handwritten)) await sb.write(rel, content);
  const before = new Map<string, string>();
  for (const rel of Object.keys(handwritten)) before.set(rel, await sb.read(rel));

  const res = await runInit({ root: sb.root, toolIds: ['agents', 'claude'] });
  assert.ok(
    res.files.filter((f) => f.path.startsWith('.ai/')).every((f) => f.action === 'kept'),
    'no bank file may be created or updated by a second init',
  );
  for (const [rel, content] of before) {
    assert.equal(await sb.read(rel), content, `${rel} was modified by init`);
  }
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

test('init for dsh wires AGENTS.md + the shared .agents/skills carrier only', async (t) => {
  // dsh scans `.dsh/skills` as well as `.agents/skills` (dsh-skill-filesystem, ranks 100/200).
  // Shipping a second copy under `.dsh/skills` would shadow the portable carrier and warn on
  // every session, so `init` must leave `.dsh/` alone entirely.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write('package.json', JSON.stringify({ name: 'harness-app' }));

  const res = await runInit({ root: sb.root, toolIds: ['dsh'] });

  assert.ok(res.files.some((f) => f.path === 'AGENTS.md' && f.action === 'created'));
  assert.ok(await sb.exists('.agents/skills/handoff/SKILL.md'), 'shared Agent Skills carrier');
  assert.ok(await sb.exists('.agents/skills/audit/SKILL.md'));
  assert.equal(await sb.exists('.dsh/skills/handoff/SKILL.md'), false, 'the shadowing copy must not exist');
  assert.equal(await sb.exists('.dsh'), false, 'engram writes nothing under .dsh/');
  const config = JSON.parse(await sb.read('.engram/config.json')) as { tools: string[] };
  assert.deepEqual(config.tools, ['dsh']);
  const bootstrap = await sb.read('.engram/BOOTSTRAP.md');
  assert.ok(bootstrap.includes('DeepSeek Harness'), 'the meta-prompt documents the tool');
  assert.ok(/\.agents\/skills/.test(bootstrap), 'the carrier dir is named for the assistant');
});

test('sync refreshes a damaged contract and re-materialises carriers', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents', 'claude'] });
  const rendered = await sb.read('AGENTS.md');
  const start = rendered.indexOf('<!-- engram:contract:start');
  const end = rendered.indexOf('<!-- engram:contract:end');
  // Damage the body only; a real "older engram wrote this" keeps both markers on their own lines.
  await sb.write(
    'AGENTS.md',
    `${rendered.slice(0, start)}\n<!-- engram:contract:start v1 -->\n## stale\n${rendered.slice(end)}`,
  );
  await sb.write('.claude/skills/handoff/SKILL.md', 'hand-edited\n');

  const res = await runSync(sb.root, ['agents', 'claude']);

  assert.ok(res.ruleFiles.find((f) => f.path === 'AGENTS.md')?.action === 'updated');
  assert.ok((await sb.read('AGENTS.md')).includes(AI_CONTRACT));
  assert.ok(!(await sb.read('AGENTS.md')).includes('## stale'), 'the stale body is gone');
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

test('REGRESSION sync inherits the tool set recorded by init', async (t) => {
  // `sync` used to default to every supported tool: one run wrote 32 carrier files and created
  // `.gemini/commands`, `.windsurf/rules` and a colliding `.pi/skills` copy for a repo that
  // asked for a single agent. Scope must survive in `.engram/config.json`.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });

  const res = await runSync(sb.root);

  assert.equal(res.scope, 'config');
  assert.ok(res.skills.every((p) => p.startsWith('.agents/skills/')), `unexpected carriers: ${res.skills}`);
  assert.equal(res.skills.length, SKILL_NAMES.length, 'one carrier per skill, not one per tool');
  assert.equal(await sb.exists('.gemini/commands/handoff.toml'), false);
  assert.equal(await sb.exists('.pi/skills/handoff/SKILL.md'), false);
});

test('sync --all overrides the recorded set', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });

  const res = await runSync(sb.root, [], false, true);

  assert.equal(res.scope, 'all-tools');
  assert.ok(res.skills.some((p) => p.startsWith('.claude/skills/')), 'claude carriers appear under --all');
  assert.ok(res.skills.some((p) => p.startsWith('.pi/prompts/')));
});

test('sync infers and records the tool set for a repo predating the config file', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['claude'] });
  await fs.rm(`${sb.root}/.engram/config.json`);

  const res = await runSync(sb.root);

  assert.equal(res.scope, 'inferred');
  assert.ok(res.warnings.some((w) => w.includes('.engram/config.json')));
  const config = JSON.parse(await sb.read('.engram/config.json')) as { tools: string[] };
  assert.ok(config.tools.includes('claude'), 'claude is provably in use');
  assert.ok(!config.tools.includes('gemini'), 'an absent tool must not be silently re-added');
  assert.ok(res.skills.some((p) => p.startsWith('.claude/skills/')));
});

test('sync prunes generated carriers the tool set no longer claims', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  // A stale `.pi/skills` set, as shipped by engram <= 0.2.1. The header is taken from
  // `generatedHeader` rather than hand-written: an earlier version of this test used an invented
  // short form (`<!-- engram:generated --> generated by engram`) that no release ever wrote, so it
  // passed against a pruner that could not have recognised a real 0.2.1 carrier.
  await runInit({ root: sb.root, toolIds: ['agents', 'pi'] });
  await sb.write('.pi/skills/handoff/SKILL.md', `${generatedHeader('.ai/skills/handoff.md')}\n`);
  await sb.write('.pi/skills/audit/SKILL.md', `${generatedHeader('.ai/skills/audit.md')}\n`);

  const res = await runSync(sb.root, ['agents']);

  assert.deepEqual(res.pruned.sort(), ['.pi/skills/audit/SKILL.md', '.pi/skills/handoff/SKILL.md']);
  assert.equal(await sb.exists('.pi/skills'), false, 'the emptied skill dirs are removed too');
  assert.ok(await sb.exists('.agents/skills/handoff/SKILL.md'), 'the live carrier survives');
});

test('sync never prunes a hand-written skill or the canonical bank', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root, toolIds: ['agents'] });
  // `research/.pi/skills/net-access/SKILL.md` is a real, hand-authored skill in a dir engram
  // no longer writes. Its name is not even a canonical skill, but the test pins both guards.
  await sb.write('.pi/skills/net-access/SKILL.md', '# net access\n\nmy own skill\n');
  await sb.write('.pi/skills/handoff/SKILL.md', '# mine, same name as a canonical skill\n');
  const canonical = await sb.read('.ai/skills/handoff.md');

  const res = await runSync(sb.root, ['agents']);

  assert.deepEqual(res.pruned, [], 'nothing without the generated marker is engram-owned');
  assert.equal(await sb.read('.pi/skills/net-access/SKILL.md'), '# net access\n\nmy own skill\n');
  assert.equal(await sb.read('.pi/skills/handoff/SKILL.md'), '# mine, same name as a canonical skill\n');
  assert.equal(await sb.read('.ai/skills/handoff.md'), canonical, 'the bank is never a prune target');
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

