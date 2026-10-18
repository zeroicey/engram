import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOOLS,
  getTool,
  ruleFiles,
  allSinkDirs,
  RETIRED_SINK_DIRS,
  RETIRED_RULE_FILES,
} from '../src/adapters/index.js';
import { commandNameFor, materialize } from '../src/adapters/skills.js';
import { SKILL_SPECS } from '../src/templates/skills.js';
import { AI_CONTRACT } from '../src/templates/contract.js';
import { runInit, runSync } from '../src/commands/init.js';
import { readConfig, writeConfig } from '../src/core/config.js';
import { sandbox, seedBank } from './helpers.js';

/**
 * The registry is one entry, and that is enforced rather than trusted.
 *
 * engram supported nine tools, then three, then one. Each subtraction ended in a file like this
 * because the failure mode of "we removed the adapter but left the entry" is a tool that keeps
 * advertising support it does not have. Adding a client must therefore fail here, so that it costs a
 * decision file rather than an edit.
 */

test('exactly one client is supported, and it is Pi', () => {
  assert.deepEqual(
    TOOLS.map((t) => t.id),
    ['pi'],
    'engram serves Pi only; re-adding a client is a decision, not an edit',
  );
  assert.equal(getTool('pi')?.label, 'Pi (earendil-works)');
});

test('no removed client can resolve', () => {
  for (const gone of ['agents', 'claude', 'codex', 'cursor', 'windsurf', 'copilot', 'gemini', 'dsh']) {
    assert.equal(getTool(gone), undefined, `${gone} was removed and must not resolve`);
  }
});

test('the tool carries a real style guide, rule file and detection paths', () => {
  const pi = TOOLS[0];
  assert.ok(pi);
  assert.ok(pi.styleGuide.length > 80, 'Pi needs real style guidance, not a placeholder');
  assert.deepEqual(ruleFiles().map((f) => f.path), ['AGENTS.md']);
  assert.ok(pi.ruleFiles[0]?.note.includes('Pi'), 'the note says who reads it');
  assert.deepEqual(pi.detect, ['.pi', '.agents', 'AGENTS.md']);
});

test('the two carriers are the Agent Skills dir and the Pi prompts dir', () => {
  const pi = TOOLS[0];
  assert.ok(pi);
  assert.deepEqual(pi.skillSinks.map((s) => [s.kind, s.dir]), [
    ['agent-skills', '.agents/skills'],
    ['prompt-md-args', '.pi/prompts'],
  ]);
  assert.deepEqual(allSinkDirs(), ['.agents/skills', '.pi/prompts']);
  // `.pi/skills` collides with `.agents/skills` at every Pi startup.
  assert.ok(!pi.skillSinks.some((s) => s.dir === '.pi/skills'));
});

test('skill carriers rewrite the ARGUMENTS token per carrier shape', () => {
  const agentSkills = materialize({ kind: 'agent-skills', dir: '.agents/skills' }, SKILL_SPECS);
  const slash = materialize({ kind: 'prompt-md-args', dir: '.pi/prompts' }, SKILL_SPECS);

  const skill = agentSkills.find((f) => f.path === '.agents/skills/handoff/SKILL.md');
  assert.ok(skill);
  assert.ok(skill.content.startsWith('---\nname: handoff\n'));
  assert.ok(!skill.content.includes('$ARGUMENTS'));

  const command = slash.find((f) => f.path === '.pi/prompts/handoff.md');
  assert.ok(command);
  assert.match(command.content, /^---\ndescription: /m);
  assert.match(command.content, /^argument-hint: '.*'$/m, 'argument-hint must be valid YAML');
  assert.ok(command.content.includes('$ARGUMENTS'));
});

test('every materialised file declares its canonical source and the generated marker', () => {
  for (const sink of allSinkDirs().map((dir) =>
    dir === '.agents/skills'
      ? ({ kind: 'agent-skills', dir } as const)
      : ({ kind: 'prompt-md-args', dir } as const),
  )) {
    for (const file of materialize(sink, SKILL_SPECS)) {
      assert.ok(file.content.includes(`<!-- engram:generated -->`), `${file.path} must be marked generated`);
      assert.ok(file.content.includes(`.ai/skills/`), `${file.path} must name its source`);
    }
  }
});

test('slash-command frontmatter parses as YAML for every skill', () => {
  for (const file of materialize({ kind: 'prompt-md-args', dir: '.pi/prompts' }, SKILL_SPECS)) {
    const [head = ''] = file.content.split('\n---\n');
    const lines = head
      .replace(/^---\n/, '')
      .split('\n')
      .filter(Boolean);
    assert.match(lines[0] ?? '', /^description: \S/, `${file.path}: description`);
    const hint = lines[1] ?? '';
    assert.match(hint, /^argument-hint: '.*'$/, `${file.path}: hint must be a quoted YAML scalar`);
    assert.ok(!hint.includes('""'), `${file.path}: unbalanced quotes`);
  }
});

test('Pi invocation syntax is /skill: for a skill and / for a prompt', () => {
  const spec = SKILL_SPECS[0];
  assert.ok(spec);
  assert.equal(commandNameFor({ kind: 'agent-skills', dir: '.agents/skills' }, spec), '/skill:handoff');
  assert.equal(commandNameFor({ kind: 'prompt-md-args', dir: '.pi/prompts' }, spec), '/handoff');
});

test('RETIRED_SINK_DIRS holds every dir engram stopped writing, and nothing it still owns', () => {
  for (const dir of ['.pi/skills', '.claude/skills', '.cursor/skills', '.github/prompts', '.gemini/commands']) {
    assert.ok(RETIRED_SINK_DIRS.includes(dir), `${dir} must be prunable`);
  }
  for (const live of allSinkDirs()) {
    assert.ok(!RETIRED_SINK_DIRS.includes(live), `${live} is still written by Pi and must not be pruned`);
  }
});

test('RETIRED_RULE_FILES names every stale contract, and no path Pi owns', () => {
  assert.deepEqual([...RETIRED_RULE_FILES].sort(), [
    '.cursor/rules/engram-memory.mdc',
    '.github/copilot-instructions.md',
    '.github/instructions/engram-memory.instructions.md',
    '.windsurf/rules/engram-memory.md',
    'CLAUDE.md',
    'GEMINI.md',
  ]);
  for (const live of ruleFiles()) {
    assert.ok(!RETIRED_RULE_FILES.includes(live.path), `${live.path} is Pi's own rule file`);
  }
});

test('REGRESSION the ARGUMENTS placeholder does not rewrite its own documentation', () => {
  // The old global replace produced "$ARGUMENTS: `$ARGUMENTS` is the optional topic slug"
  // across 16 generated carriers: a garbled instruction about where to get the slug.
  for (const file of materialize({ kind: 'prompt-md-args', dir: '.pi/prompts' }, SKILL_SPECS)) {
    assert.ok(file.content.includes('$ARGUMENTS'), `${file.path} must substitute the placeholder`);
    assert.ok(
      !/\$ARGUMENTS:\s*`\$ARGUMENTS`/.test(file.content),
      `${file.path} rewrote the sentence that documents the placeholder`,
    );
  }
});

test('the contract still names the passive fallback for a client with no skill support', () => {
  assert.ok(AI_CONTRACT.includes('.ai/skills/*.md'), 'contract must name the passive fallback');
});

// ── the Pi-only migration ─────────────────────────────────────────────────────

test('init writes a v2 config with no tool list', async (t) => {
  // A `tools: ["pi"]` array would be a list with one legal value — an extensibility story the
  // product no longer tells.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await runInit({ root: sb.root });
  const raw = JSON.parse(await sb.read('.engram/config.json')) as Record<string, unknown>;
  assert.equal(raw.version, 2);
  assert.equal(raw.tools, undefined, 'the tool list is gone');
});

test('a v1 config is still readable, and sync rewrites it without losing the goal opt-in', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await seedBank(sb);
  await sb.write(
    '.engram/config.json',
    JSON.stringify({ version: 1, tools: ['claude', 'codex', 'pi'], goal: { enabled: true } }),
  );
  // Reading a legacy file must not drop the one field that still means something.
  const before = await readConfig(sb.root);
  assert.equal(before?.goal?.enabled, true, 'v1 is accepted and its goal flag is preserved');

  await runSync(sb.root);
  const raw = JSON.parse(await sb.read('.engram/config.json')) as Record<string, unknown>;
  assert.equal(raw.version, 2, 'sync upgrades the file');
  assert.equal(raw.tools, undefined);
  assert.deepEqual(raw.goal, { enabled: true });
});

test('a config with an unsupported version is ignored rather than trusted', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write('.engram/config.json', JSON.stringify({ version: 99, goal: { enabled: true } }));
  assert.equal(await readConfig(sb.root), null, 'a future format must not enable lifecycle code');
});

test('writeConfig round-trips the goal opt-in', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await writeConfig(sb.root, true);
  assert.equal((await readConfig(sb.root))?.goal?.enabled, true);
  await writeConfig(sb.root, false);
  assert.equal((await readConfig(sb.root))?.goal?.enabled, false);
});
