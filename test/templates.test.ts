import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_CONTRACT, CONTRACT_START, MANAGED_MARKER, withContract, withoutContract } from '../src/templates/contract.js';
import { refreshContract, renderRuleFile } from '../src/adapters/rules.js';
import { SKILL_SPECS, skillFile } from '../src/templates/skills.js';
import { aiSkeleton } from '../src/commands/init.js';

const AGENTS_RULE = { path: 'AGENTS.md', kind: 'agents' as const, note: 'test' };
const CURSOR_RULE = { path: '.cursor/rules/engram-memory.mdc', kind: 'cursor' as const, note: 'test' };

test('withContract wraps a body once and is idempotent', () => {
  const once = withContract('# Rules\n\nBe careful.');
  const twice = withContract(once);
  assert.equal(once, twice);
  assert.equal(twice.split(CONTRACT_START).length - 1, 1);
  assert.ok(twice.includes(AI_CONTRACT));
});

test('withContract replaces a stale contract body in place', () => {
  const stale = withContract('# Rules').replace(AI_CONTRACT, 'OLD AND WRONG');
  const fresh = withContract(stale);
  assert.ok(fresh.includes(AI_CONTRACT));
  assert.ok(!fresh.includes('OLD AND WRONG'));
  assert.ok(fresh.startsWith('# Rules'), 'authored body is preserved verbatim');
});

test('withoutContract returns exactly the authored body', () => {
  const body = '# Rules\n\nline one\nline two';
  assert.equal(withoutContract(withContract(body)), body);
});

test('refreshContract is a no-op on a fresh file and repairs a damaged one', () => {
  const ctx = { projectName: 'demo', alsoReadBy: [] };
  const rendered = renderRuleFile(AGENTS_RULE, ctx);
  assert.equal(refreshContract(rendered, AGENTS_RULE), rendered);

  const damaged = rendered.replace(AI_CONTRACT, 'truncated...');
  const repaired = refreshContract(damaged, AGENTS_RULE);
  assert.ok(repaired.includes(AI_CONTRACT));
  assert.equal(refreshContract(repaired, AGENTS_RULE), repaired, 'repair must be idempotent');
});

test('refreshContract appends the contract to a file that never had one', () => {
  const handWritten = '# Hand written\n\nTeam rules.\n';
  const next = refreshContract(handWritten, AGENTS_RULE);
  assert.ok(next.startsWith('# Hand written'));
  assert.ok(next.includes(AI_CONTRACT));
});

test('cursor rule keeps its frontmatter above the contract', () => {
  const out = renderRuleFile(CURSOR_RULE, { projectName: 'demo', alsoReadBy: [] });
  assert.ok(out.startsWith('---\n'), 'frontmatter must remain the first thing in the file');
  assert.match(out, /alwaysApply: true/);
  assert.ok(out.indexOf('alwaysApply: true') < out.indexOf(CONTRACT_START));
});

test('renderRuleFile preserves an existing body but notes shared readers', () => {
  const existing = '# Existing\n\ndo not clobber me\n';
  const out = renderRuleFile(AGENTS_RULE, { projectName: 'demo', alsoReadBy: ['codex', 'pi'] }, existing);
  assert.ok(out.includes('do not clobber me'));
  assert.match(out, /_Read by: codex, pi\._/);
  assert.ok(out.includes(AI_CONTRACT));
});

test('every rendered rule file carries the managed marker exactly once', () => {
  const out = renderRuleFile(AGENTS_RULE, { projectName: 'demo', alsoReadBy: [] });
  assert.equal(out.split(MANAGED_MARKER).length - 1, 1);
  assert.ok(out.indexOf(MANAGED_MARKER) < out.indexOf(CONTRACT_START), 'marker precedes contract');
});

test('re-rendering a managed rule file does not nest markers or contracts', () => {
  const ctx = { projectName: 'demo', alsoReadBy: [] };
  const first = renderRuleFile(AGENTS_RULE, ctx);
  const second = renderRuleFile(AGENTS_RULE, ctx, first);
  const third = renderRuleFile(AGENTS_RULE, ctx, second);
  assert.equal(second, first);
  assert.equal(third, first);
  assert.equal(second.split(MANAGED_MARKER).length - 1, 1);
  assert.equal(second.split(CONTRACT_START).length - 1, 1);
  assert.ok(second.includes(withoutContract(first).trim()), 'authored body survives every pass');
});

test('re-rendering a frontmatter file never duplicates its frontmatter', () => {
  const ctx = { projectName: 'demo', alsoReadBy: [] };
  const first = renderRuleFile(CURSOR_RULE, ctx);
  const second = renderRuleFile(CURSOR_RULE, ctx, first);
  assert.equal(second, first);
  assert.equal(second.split('alwaysApply: true').length - 1, 1);
  assert.ok(second.startsWith('---\n'));
});

test('shared-reader notes appear once no matter how often init runs', () => {
  const ctx = { projectName: 'demo', alsoReadBy: ['codex', 'pi'] };
  const first = renderRuleFile(AGENTS_RULE, ctx);
  const second = renderRuleFile(AGENTS_RULE, ctx, first);
  assert.equal(second, first);
  assert.equal(second.split('_Read by:').length - 1, 1);
});

test('the managed marker survives a damaged contract repair', () => {
  const ctx = { projectName: 'demo', alsoReadBy: [] };
  const rendered = renderRuleFile(AGENTS_RULE, ctx).replace(AI_CONTRACT, 'broken');
  const repaired = refreshContract(rendered, AGENTS_RULE);
  assert.equal(repaired.split(MANAGED_MARKER).length - 1, 1);
  assert.ok(repaired.includes(AI_CONTRACT));
});

test('every canonical skill has valid frontmatter and a tool-neutral body', () => {
  assert.deepEqual(
    SKILL_SPECS.map((s) => s.name),
    ['handoff', 'remember-pitfall', 'remember-decision', 'audit'],
  );
  for (const spec of SKILL_SPECS) {
    const file = skillFile(spec);
    assert.ok(file.startsWith(`---\nname: ${spec.name}\n`), `${spec.name} needs matching frontmatter`);
    assert.match(file, /^description: .{20,}$/m);
    assert.ok(file.includes('ARGUMENTS'), `${spec.name} documents its argument`);
    assert.ok(
      !file.includes('$ARGUMENTS') && !file.includes('{{args}}'),
      `${spec.name} must stay tool-neutral; the ARGUMENTS token is rewritten per carrier`,
    );
    assert.ok(file.includes('.ai/'), `${spec.name} must write into the bank`);
  }
});

test('aiSkeleton matches the frozen four-layer layout', () => {
  const paths = aiSkeleton({ projectName: 'demo', today: '2026-10-01' }).map((f) => f.path);
  for (const required of [
    '.ai/README.md',
    '.ai/ARCHITECTURE.md',
    '.ai/CURRENT_TASK.md',
    '.ai/decisions/_TEMPLATE.md',
    '.ai/sessions/_TEMPLATE.md',
    '.ai/runbooks/_TEMPLATE.md',
    '.ai/pitfalls/cases/_TEMPLATE.md',
    '.ai/skills/handoff.md',
    '.ai/skills/audit.md',
  ]) {
    assert.ok(paths.includes(required), `skeleton is missing ${required}`);
  }
  assert.equal(paths.filter((p) => p.startsWith('.ai/ideas/')).length, 0, 'ideas/ stays cancelled');
});

test('decision template ships the status machine', () => {
  const decision = aiSkeleton({ projectName: 'demo', today: '2026-10-01' }).find((f) =>
    f.path.endsWith('decisions/_TEMPLATE.md'),
  );
  assert.ok(decision);
  for (const status of ['💭 PROPOSAL', '✅ ACCEPTED', '🪦 REJECTED']) {
    assert.ok(decision.content.includes(status), `template lacks ${status}`);
  }
});