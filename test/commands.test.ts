import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import { materializeSkillSinks, runInit, runSync } from '../src/commands/init.js';
import { TOOLS } from '../src/adapters/index.js';
import { readSkillSources } from '../src/core/skill-source.js';
import { runDump, renderDump } from '../src/commands/dump.js';
import { isMemoryKind, renderNewFile, runNew } from '../src/commands/new.js';
import { AI_CONTRACT, CONTRACT_START } from '../src/templates/contract.js';
import { SKILL_NAMES } from '../src/templates/skills.js';
import { generatedHeader } from '../src/adapters/rules.js';
import { detectProject } from '../src/core/project.js';
import { sandbox } from './helpers.js';

test('init creates the bank, rule files, carriers and the bootstrap prompt', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write('package.json', JSON.stringify({ name: '@acme/widget', scripts: { build: 'tsc' } }));

  const res = await runInit({ root: sb.root });

  assert.ok(res.files.every((f) => f.action === 'created'));
  for (const rel of [
    '.ai/README.md',
    '.ai/ARCHITECTURE.md',
    '.ai/CURRENT_TASK.md',
    '.ai/skills/handoff.md',
    'AGENTS.md',
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
  const config = JSON.parse(await sb.read('.engram/config.json')) as Record<string, unknown>;
  assert.equal(config.version, 2, 'the tool list is gone; the config holds the goal opt-in only');
  assert.equal(config.tools, undefined);

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
  await runInit({ root: sb.root });

  const handwritten: Record<string, string> = {
    '.ai/CURRENT_TASK.md': '# Current task\n\n**Status:** 🟡 active\n\n## Goal\n\nMy real goal.\n',
    '.ai/ARCHITECTURE.md': '# Architecture\n\n## 1. Purpose\n\nSomething only I know.\n',
    '.ai/README.md': '# .ai/\n\nMy own index.\n',
    '.ai/decisions/2026-01-01-mine.md': '# Mine\n\n**Status:** ✅ ACCEPTED\n',
  };
  for (const [rel, content] of Object.entries(handwritten)) await sb.write(rel, content);
  const before = new Map<string, string>();
  for (const rel of Object.keys(handwritten)) before.set(rel, await sb.read(rel));

  const res = await runInit({ root: sb.root });
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

  await runInit({ root: sb.root });

  const agents = await sb.read('AGENTS.md');
  assert.ok(agents.includes('Never touch the deploy scripts.'));
  assert.ok(agents.includes(AI_CONTRACT));
  assert.equal(agents.split(CONTRACT_START).length - 1, 1, 'exactly one contract block');
});

test('init is idempotent: a second run creates nothing and changes nothing', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });
  const snapshot = new Map<string, string>();
  for (const rel of ['AGENTS.md', '.ai/README.md', '.agents/skills/handoff/SKILL.md', '.pi/prompts/handoff.md']) {
    snapshot.set(rel, await sb.read(rel));
  }

  const second = await runInit({ root: sb.root });
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
  const res = await runInit({ root: sb.root, dryRun: true });
  assert.ok(res.files.some((f) => f.action === 'created'));
  assert.equal(await sb.exists('.ai/README.md'), false);
  assert.equal(await sb.exists('AGENTS.md'), false);
});

test('a request for a removed client is ignored, and the bank is still created', async (t) => {
  // `--tools` is gone, so the CLI warns instead of silently doing something else. `runInit` has no
  // tool parameter at all: the only client is Pi.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  const res = await runInit({ root: sb.root });
  assert.deepEqual(res.warnings, []);
  assert.ok(await sb.exists('AGENTS.md'));
});

test('init for pi alone installs the skills pi reads, not only its prompt templates', async (t) => {
  // `pi` used to declare just `.pi/prompts`, relying on another adapter to write `.agents/skills`.
  // With the `agents`/`dsh` entries removed that made `init --tools pi` advertise four skills that
  // were never materialised — nothing was loadable. The shared dir is now claimed by both `codex`
  // and `pi`, and written once.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write('package.json', JSON.stringify({ name: 'pi-app' }));

  const res = await runInit({ root: sb.root });

  assert.ok(res.files.some((f) => f.path === 'AGENTS.md' && f.action === 'created'));
  assert.ok(await sb.exists('.agents/skills/handoff/SKILL.md'), 'the skills pi reads must exist');
  assert.ok(await sb.exists('.pi/prompts/handoff.md'), 'and so must its prompt templates');
  // `.pi/skills` collides with `.agents/skills` at every Pi startup; it must stay retired.
  assert.equal(await sb.exists('.pi/skills/handoff/SKILL.md'), false);
  const config = JSON.parse(await sb.read('.engram/config.json')) as Record<string, unknown>;
  assert.equal(config.version, 2);
  const bootstrap = await sb.read('.engram/BOOTSTRAP.md');
  assert.ok(bootstrap.includes('Pi'), 'the meta-prompt documents the tool');
});

test('materializeSkillSinks writes each path exactly once', async (t) => {
  // The de-duplicator existed because `.agents/skills` was claimed by two tools. With one tool it
  // has nothing to merge, but a duplicate path would still mean a wasted write and a doubled count
  // in `sync`'s "N skill files materialised" line, so the invariant is kept as an assertion.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });
  const { skills } = await readSkillSources(sb.root);

  const res = await materializeSkillSinks(sb.root, skills, [...TOOLS], true);
  assert.equal(new Set(res.written).size, res.written.length, 'no path is written twice');
  assert.ok(res.written.includes('.agents/skills/handoff/SKILL.md'));
  assert.ok(res.written.includes('.pi/prompts/handoff.md'));
});

test('sync refreshes a damaged contract and re-materialises carriers', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });
  const rendered = await sb.read('AGENTS.md');
  const start = rendered.indexOf('<!-- engram:contract:start');
  const end = rendered.indexOf('<!-- engram:contract:end');
  // Damage the body only; a real "older engram wrote this" keeps both markers on their own lines.
  await sb.write(
    'AGENTS.md',
    `${rendered.slice(0, start)}\n<!-- engram:contract:start v1 -->\n## stale\n${rendered.slice(end)}`,
  );
  await sb.write('.agents/skills/handoff/SKILL.md', 'hand-edited\n');

  const res = await runSync(sb.root);

  assert.ok(res.ruleFiles.find((f) => f.path === 'AGENTS.md')?.action === 'updated');
  assert.ok((await sb.read('AGENTS.md')).includes(AI_CONTRACT));
  assert.ok(!(await sb.read('AGENTS.md')).includes('## stale'), 'the stale body is gone');
  const skill = await sb.read('.agents/skills/handoff/SKILL.md');
  assert.ok(skill.includes('<!-- engram:generated -->'), 'hand edits to carriers are replaced');

  const again = await runSync(sb.root);
  assert.ok(again.ruleFiles.every((f) => f.action === 'unchanged'), 'sync must be idempotent');
});

test('sync warns about canonical skills missing from .ai/skills/', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });
  await fs.rm(`${sb.root}/.ai/skills/audit.md`);
  const res = await runSync(sb.root);
  assert.deepEqual(res.missingSkills, ['audit']);
});

test('sync writes one carrier per skill — there is no longer a tool set to multiply by', async (t) => {
  // `sync` used to default to every supported tool: one run wrote 32 carrier files and created
  // `.gemini/commands`, `.windsurf/rules` and a colliding `.pi/skills` copy for a repo that asked for
  // a single agent. With one client the arithmetic is simply "one carrier per skill".
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });

  const res = await runSync(sb.root);

  assert.ok(
    res.skills.every((p) => p.startsWith('.agents/skills/') || p.startsWith('.pi/prompts/')),
    `unexpected carriers: ${res.skills}`,
  );
  assert.equal(res.skills.length, SKILL_NAMES.length * 2, 'one SKILL.md and one prompt per skill');
  assert.equal(await sb.exists('.gemini/commands/handoff.toml'), false);
  assert.equal(await sb.exists('.claude/skills/handoff/SKILL.md'), false);
  assert.equal(await sb.exists('.pi/skills/handoff/SKILL.md'), false);
});

test('sync prunes generated carriers the tool set no longer claims', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  // A stale `.pi/skills` set, as shipped by engram <= 0.2.1. The header is taken from
  // `generatedHeader` rather than hand-written: an earlier version of this test used an invented
  // short form (`<!-- engram:generated --> generated by engram`) that no release ever wrote, so it
  // passed against a pruner that could not have recognised a real 0.2.1 carrier.
  await runInit({ root: sb.root });
  await sb.write('.pi/skills/handoff/SKILL.md', `${generatedHeader('.ai/skills/handoff.md')}\n`);
  await sb.write('.pi/skills/audit/SKILL.md', `${generatedHeader('.ai/skills/audit.md')}\n`);

  const res = await runSync(sb.root);

  assert.deepEqual(res.pruned.sort(), ['.pi/skills/audit/SKILL.md', '.pi/skills/handoff/SKILL.md']);
  assert.equal(await sb.exists('.pi/skills'), false, 'the emptied skill dirs are removed too');
  assert.ok(await sb.exists('.agents/skills/handoff/SKILL.md'), 'the live carrier survives');
});

test('sync never prunes a hand-written skill or the canonical bank', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });
  // `research/.pi/skills/net-access/SKILL.md` is a real, hand-authored skill in a dir engram
  // no longer writes. Its name is not even a canonical skill, but the test pins both guards.
  await sb.write('.pi/skills/net-access/SKILL.md', '# net access\n\nmy own skill\n');
  await sb.write('.pi/skills/handoff/SKILL.md', '# mine, same name as a canonical skill\n');
  const canonical = await sb.read('.ai/skills/handoff.md');

  const res = await runSync(sb.root);

  assert.deepEqual(res.pruned, [], 'nothing without the generated marker is engram-owned');
  assert.equal(await sb.read('.pi/skills/net-access/SKILL.md'), '# net access\n\nmy own skill\n');
  assert.equal(await sb.read('.pi/skills/handoff/SKILL.md'), '# mine, same name as a canonical skill\n');
  assert.equal(await sb.read('.ai/skills/handoff.md'), canonical, 'the bank is never a prune target');
});

test('dump renders a fingerprint after init and stays in budget', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });

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
  await runInit({ root: sb.root });
  const result = await runDump({ root: sb.root });
  const parsed = JSON.parse(renderDump(result, 'json')) as { project: string; skills: string[] };
  assert.equal(typeof parsed.project, 'string');
  assert.deepEqual([...parsed.skills].sort(), SKILL_NAMES.map((n) => `/${n}`).sort());
});

test('new scaffolds each memory kind from the shared section skeleton', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });

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
  // The sandbox is a git repository by default (init requires one), so `hasGit` is true here.
  assert.equal(facts.hasGit, true);
});


test('REGRESSION a retired carrier dir is pruned whatever filename shape it holds', async (t) => {
  // The retired-dir pruner used to enumerate the four built-in skill names × three hard-coded
  // filename shapes (`<name>/SKILL.md`, `<name>.md`, `<name>.toml`). Copilot's prompt files are
  // `<name>.prompt.md` — a fourth shape — so `.github/prompts/*.prompt.md` survived every `sync` in
  // every repository that had ever used that adapter, advertising skills for a client engram cannot
  // install for. Found by running a migration against a synthetic old repository, not by a test.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });
  const marker = '<!-- engram:generated --> generated by engram from .ai/skills/handoff.md';
  await sb.write('.github/prompts/handoff.prompt.md', marker);
  await sb.write('.github/prompts/audit.prompt.md', marker);
  await sb.write('.github/prompts/mine.prompt.md', 'hand-written, no marker\n');
  await sb.write('.gemini/commands/handoff.toml', marker);

  const res = await runSync(sb.root);

  assert.ok(res.pruned.includes('.github/prompts/handoff.prompt.md'), `.prompt.md must be pruned: ${res.pruned}`);
  assert.ok(res.pruned.includes('.github/prompts/audit.prompt.md'));
  assert.ok(res.pruned.includes('.gemini/commands/handoff.toml'));
  assert.equal(await sb.exists('.gemini/commands'), false, 'an emptied retired dir is removed');
  assert.equal(
    await sb.read('.github/prompts/mine.prompt.md'),
    'hand-written, no marker\n',
    'a hand-written file in a retired dir survives — the marker is the safety property, not the name',
  );
});

test('a re-run of init never rewrites the config it does not own', async (t) => {
  // `init` used to write the config through `writeGenerated`, which replaces content whenever it differs,
  // under a comment claiming the opposite. Measured consequence: `init` → `config --goal on` → `init`
  // wrote `{"version": 2}`, and the **next `sync` deleted `.pi/extensions/engram-goal.ts`** because
  // `goalEnabled(...)` was then false. A re-run silently disarmed the goal engine.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });
  await sb.write(
    '.engram/config.json',
    JSON.stringify({ version: 2, goal: { enabled: true }, limits: { livenessMs: 60_000 } }),
  );

  const again = await runInit({ root: sb.root, force: true });
  assert.equal(again.files.find((f) => f.path === '.engram/config.json')?.action, 'kept');
  const raw = JSON.parse(await sb.read('.engram/config.json')) as Record<string, unknown>;
  assert.deepEqual(raw.goal, { enabled: true }, 'the goal opt-in survives a re-init');
  assert.deepEqual(raw.limits, { livenessMs: 60_000 }, 'and so do the limits');

  // And the carrier it protects is still there after the sync that follows.
  await runSync(sb.root);
  assert.equal(await sb.exists('.pi/extensions/engram-goal.ts'), true, 'a re-init must not disarm the goal engine');
});

test('the legacy-config upgrade keeps the limits block', async (t) => {
  // `writeConfig(root, goal, limits?)` emits `limits` only when given one, and the migration passed only
  // the opt-in — so the first `sync` erased a tuned liveness deadline that a v1 file is a legal place to
  // have written.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });
  await sb.write(
    '.engram/config.json',
    JSON.stringify({ version: 1, tools: ['pi'], goal: { enabled: true }, limits: { livenessMs: 60_000 } }),
  );

  await runSync(sb.root);
  const raw = JSON.parse(await sb.read('.engram/config.json')) as Record<string, unknown>;
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.goal, { enabled: true });
  assert.deepEqual(raw.limits, { livenessMs: 60_000 });
});
