import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOLS, getTool, ruleFilesFor } from '../src/adapters/index.js';
import { commandNameFor, materialize } from '../src/adapters/skills.js';
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

  const command = slash.find((f) => f.path === '.claude/commands/handoff.md');
  assert.ok(command);
  assert.match(command.content, /^---\ndescription: /m);
  assert.match(command.content, /^argument-hint: '.*'$/m, 'argument-hint must be valid YAML');
  assert.ok(command.content.includes('$ARGUMENTS'));
  assert.ok(
    !/^description: .*: /m.test(command.content) && command.content.split('\n')[2]?.includes('e.g.'),
    'quotes inside the hint must not break the frontmatter scalar',
  );

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
    { kind: 'prompt-md-args', dir: '.github/prompts', suffix: '.prompt.md', frontmatter: 'copilot' },
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

test('copilot prompt files use the official .prompt.md name and agent: frontmatter', () => {
  // Corrections from a docs fact-check: the filename must be <name>.prompt.md (a bare .md is
  // not registered) and the frontmatter key is `agent:`, not `mode:`.
  const [file] = materialize(
    { kind: 'prompt-md-args', dir: '.github/prompts', suffix: '.prompt.md', frontmatter: 'copilot' },
    SKILL_SPECS,
  );
  assert.ok(file);
  assert.equal(file.path, '.github/prompts/handoff.prompt.md');
  assert.match(file.content, /^---\nagent: agent\n/m);
  assert.ok(!file.content.includes('mode: agent'), 'there is no `mode:` key in prompt-file frontmatter');
  assert.ok(!file.content.includes('argument-hint'));
});

test('codex does support project skills, so it gets an .agents/skills sink', () => {
  const codex = getTool('codex');
  assert.ok(codex);
  assert.ok(codex.skillSinks.length > 0, 'Codex scans .agents/skills from cwd to the repo root');
  assert.equal(codex.skillSinks[0]?.dir, '.agents/skills');
});

test('claude has no .claude/commands sink, because a same-named skill shadows it', () => {
  const claude = getTool('claude');
  assert.ok(claude);
  const dirs = claude.skillSinks.map((sk) => sk.dir);
  assert.ok(dirs.includes('.claude/skills'));
  assert.ok(!dirs.includes('.claude/commands'), 'the command file would be permanently dead');
});

test('skill invocation syntax is per-tool, not hardcoded /skill:', () => {
  const spec = SKILL_SPECS[0];
  assert.ok(spec);
  const claude = getTool('claude')?.skillSinks[0];
  const pi = getTool('pi')?.skillSinks[0];
  assert.ok(claude && pi);
  assert.equal(commandNameFor(claude, spec), '/handoff', 'Claude invokes skills as /name');
  assert.equal(commandNameFor(pi, spec), '/skill:handoff', '/skill: is Pi-specific');
});

test('REGRESSION the ARGUMENTS placeholder does not rewrite its own documentation', () => {
  // The old global replace produced "$ARGUMENTS: `$ARGUMENTS` is the optional topic slug"
  // across 16 generated carriers: a garbled instruction about where to get the slug.
  for (const file of materialize({ kind: 'prompt-md-args', dir: '.claude/commands' }, SKILL_SPECS)) {
    assert.ok(file.content.includes('$ARGUMENTS'), `${file.path} must substitute the placeholder`);
    assert.ok(
      !/\$ARGUMENTS:\s*`\$ARGUMENTS`/.test(file.content),
      `${file.path} rewrote the sentence that documents the placeholder`,
    );
  }
  for (const file of materialize({ kind: 'prompt-toml', dir: '.gemini/commands' }, SKILL_SPECS)) {
    assert.ok(!/\{\{args\}\}:\s*`\{\{args\}\}`/.test(file.content), `${file.path} has the same defect`);
  }
});

test('tools without native skill support rely on the contract fallback', () => {
  const windsurf = getTool('windsurf');
  assert.ok(windsurf);
  assert.deepEqual(windsurf.skillSinks, [], 'Windsurf has no project-scoped skill mechanism');
  assert.ok(AI_CONTRACT.includes('.ai/skills/*.md'), 'contract must name the passive fallback');
});
