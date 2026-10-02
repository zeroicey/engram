import assert from 'node:assert/strict';
import { test } from 'node:test';
import { load as parseYaml } from 'js-yaml';
import { materialize } from '../src/adapters/skills.js';
import { SKILL_SPECS, skillFile } from '../src/templates/skills.js';
import { validateFrontmatter } from '../src/core/yaml.js';

/**
 * Frontmatter must PARSE, not merely look right.
 *
 * engram 0.2.0 shipped skills that no tool could load: `description: <text>` was emitted
 * unquoted, and a YAML plain scalar cannot contain ": ". Two of the four skill descriptions
 * contain a colon-space ("…memory bank: architecture drift…"), so every carrier generated for
 * them was rejected by the parser with "nested mappings are not allowed". The old test asserted
 * only `^description: \S`, which passed on exactly the broken output.
 *
 * This suite parses with a real YAML parser. js-yaml is a devDependency: the published tarball
 * stays dependency-free, and a hand-rolled regex would re-introduce the proxy this file exists
 * to eliminate.
 */

const SINK_KINDS = [
  { kind: 'agent-skills', dir: '.pi/skills' },
  { kind: 'prompt-md-args', dir: '.pi/prompts' },
  { kind: 'prompt-md-args', dir: '.claude/commands' },
  { kind: 'prompt-md-args', dir: '.github/prompts', suffix: '.prompt.md', frontmatter: 'copilot' },
  { kind: 'agent-skills', dir: '.cursor/skills' },
] as const;

function frontmatterOf(content: string): string {
  assert.ok(content.startsWith('---\n'), 'file must start with a frontmatter fence');
  const end = content.indexOf('\n---', 3);
  assert.notEqual(end, -1, 'frontmatter must be terminated');
  return content.slice(4, end);
}

test('REGRESSION every generated skill carrier has YAML that actually parses', () => {
  const failures: string[] = [];
  let checked = 0;

  for (const sink of SINK_KINDS) {
    for (const file of materialize(sink, SKILL_SPECS)) {
      checked++;
      const fm = frontmatterOf(file.content);
      try {
        const parsed = parseYaml(fm) as Record<string, unknown> | undefined;
        assert.ok(parsed && typeof parsed === 'object', 'frontmatter must be a mapping');
        assert.equal(typeof parsed.description, 'string', 'description must be a string');
        assert.ok((parsed.description as string).length > 20, 'description must not be truncated');
      } catch (err) {
        failures.push(`${file.path}: ${(err as Error).message.split('\n')[0]}`);
      }
    }
  }

  assert.deepEqual(failures, [], `unparseable frontmatter:\n  ${failures.join('\n  ')}`);
  assert.equal(checked, SKILL_SPECS.length * SINK_KINDS.length);
});

test('REGRESSION the canonical .ai/skills spec has parseable frontmatter too', () => {
  for (const spec of SKILL_SPECS) {
    const fm = frontmatterOf(skillFile(spec));
    const parsed = parseYaml(fm) as { name?: string; description?: string };
    assert.equal(parsed.name, spec.name);
    assert.equal(typeof parsed.description, 'string');
  }
});

test('descriptions containing ": " survive the round trip', () => {
  const withColons = SKILL_SPECS.filter((s) => s.description.includes(': '));
  assert.ok(withColons.length >= 2, 'this bug needs a description with a colon-space to be caught');
  for (const spec of withColons) {
    const fm = frontmatterOf(skillFile(spec));
    const parsed = parseYaml(fm) as { description: string };
    assert.equal(parsed.description, spec.description, `${spec.name} must survive quoting unchanged`);
  }
});

test('a description with an apostrophe survives the round trip', () => {
  // The pitfall skill description contains "don't"; a naive single-quoted scalar would break it.
  const pitfall = SKILL_SPECS.find((s) => s.name === 'remember-pitfall');
  assert.ok(pitfall);
  assert.ok(pitfall.description.includes("don't"), 'fixture should exercise the apostrophe');
  const parsed = parseYaml(frontmatterOf(skillFile(pitfall))) as { description: string };
  assert.equal(parsed.description, pitfall.description);
});

test('the dependency-free validator agrees with the real parser', () => {
  assert.deepEqual(validateFrontmatter('description: plain and fine'), []);
  assert.deepEqual(validateFrontmatter("description: 'quoted: safely'"), []);
  assert.equal(validateFrontmatter('description: bad: value').length, 1);
  assert.equal(validateFrontmatter('not a mapping line').length, 1);
});
