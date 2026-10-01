import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOLS, getTool, ruleFilesFor } from '../src/adapters/index.js';
import { materialize } from '../src/adapters/skills.js';
import { SKILL_SPECS } from '../src/templates/skills.js';
import { AI_CONTRACT } from '../src/templates/contract.js';

test('registry ids are unique and every tool carries a style guide', () => {
  const ids = TOOLS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate tool id');
  for (const tool of TOOLS) {
    assert.ok(tool.styleGuide.length > 80, `${tool.id} needs real style guidance`);
    assert.ok(tool.ruleFiles.length > 0, `${tool.id} needs at least one rule file`);
    assert.ok(tool.detect.length > 0, `${tool.id} needs detection paths`);
  }
});

test('ruleFilesFor de-duplicates AGENTS.md across tools and keeps order', () => {
  const files = ruleFilesFor(['codex', 'pi', 'claude']);
  const paths = files.map((f) => f.def.path);
  assert.deepEqual(paths, ['AGENTS.md', 'CLAUDE.md']);
  assert.equal(files[0]?.toolId, 'codex');
});

test('unknown tool ids resolve to undefined rather than throwing', () => {
  assert.equal(getTool('nope'), undefined);
});

test('skill carriers rewrite the ARGUMENTS token per tool', () => {
  const agentSkills = materialize({ kind: 'agent-skills', dir: '.pi/skills' }, SKILL_SPECS);
  const slash = materialize({ kind: 'prompt-md-args', dir: '.claude/commands' }, SKILL_SPECS);
  const gemini = materialize({ kind: 'prompt-toml', dir: '.gemini/commands' }, SKILL_SPECS);

  const skill = agentSkills.find((f) => f.path === '.pi/skills/handoff/SKILL.md');
  assert.ok(skill);
  assert.ok(skill.content.startsWith('---\nname: handoff\n'));
  assert.ok(!skill.content.includes('$ARGUMENTS'));

  const command = slash.find((f) => f.path === '.claude/commands/audit.md');
  assert.ok(command);
  assert.match(command.content, /^---\ndescription: /m);
  assert.match(command.content, /argument-hint:/);
  assert.ok(command.content.includes('$ARGUMENTS'));

  const toml = gemini.find((f) => f.path === '.gemini/commands/handoff.toml');
  assert.ok(toml);
  assert.match(toml.content, /^description = "/m);
  assert.match(toml.content, /prompt = """/);
  assert.ok(toml.content.includes('{{args}}'));
  assert.ok(!toml.content.includes('"""prose'));
});

test('every materialised file declares its canonical source and the generated marker', () => {
  for (const sink of [
    { kind: 'agent-skills', dir: '.agents/skills' },
    { kind: 'prompt-md-args', dir: '.github/prompts', frontmatter: 'copilot' },
  ] as const) {
    for (const file of materialize(sink, SKILL_SPECS)) {
      assert.ok(
        file.content.includes(`<!-- engram:generated -->`),
        `${file.path} must be marked generated`,
      );
      assert.ok(file.content.includes(`.ai/skills/`), `${file.path} must name its source`);
    }
  }
});

test('copilot prompt files use mode: agent frontmatter, not argument-hint', () => {
  const [file] = materialize(
    { kind: 'prompt-md-args', dir: '.github/prompts', frontmatter: 'copilot' },
    SKILL_SPECS,
  );
  assert.ok(file);
  assert.match(file.content, /^---\nmode: agent\n/m);
  assert.ok(!file.content.includes('argument-hint'));
});

test('tools without native skill support rely on the contract fallback', () => {
  const codex = getTool('codex');
  assert.ok(codex);
  assert.deepEqual(codex.skillSinks, []);
  assert.ok(AI_CONTRACT.includes('.ai/skills/*.md'), 'contract must name the passive fallback');
});