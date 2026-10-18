import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AI_CONTRACT,
  CONTRACT_END,
  CONTRACT_START,
  MANAGED_MARKER,
  findContractSpan,
  inspectMarkers,
  replaceContractBlock,
  stripContractBlock,
  withContract,
  withoutContract,
} from '../src/templates/contract.js';
import { refreshContract, renderRuleFile } from '../src/adapters/rules.js';
import { parseCurrentTask } from '../src/core/memory.js';
import { SKILL_SPECS, skillFile } from '../src/templates/skills.js';
import { aiSkeleton } from '../src/commands/init.js';

const AGENTS_RULE = { path: 'AGENTS.md', note: 'test' };
const CTX = { projectName: 'demo' };

/** Replace the contract *body* while keeping both markers on their own lines — the realistic
 *  shape of "an older engram version wrote this" and of a hand-mangled block. */
function staleContract(rendered: string): string {
  const start = rendered.indexOf(CONTRACT_START);
  const end = rendered.indexOf(CONTRACT_END);
  return `${rendered.slice(0, start + CONTRACT_START.length)}\n## a stale contract body\n${rendered.slice(end)}`;
}

// ── contract splicing ────────────────────────────────────────────────────────

test('withContract wraps a body once and is idempotent', () => {
  const once = withContract('# Rules\n\nBe careful.');
  const twice = withContract(once);
  assert.equal(once, twice);
  assert.equal(twice.split(CONTRACT_START).length - 1, 1);
  assert.ok(twice.includes(AI_CONTRACT));
});

test('withContract replaces a stale contract body in place', () => {
  const stale = staleContract(withContract('# Rules'));
  const fresh = withContract(stale);
  assert.ok(fresh.includes(AI_CONTRACT));
  assert.ok(!fresh.includes('a stale contract body'));
  assert.ok(fresh.startsWith('# Rules'), 'authored body is preserved verbatim');
});

test('withoutContract returns exactly the authored body', () => {
  const body = '# Rules\n\nline one\nline two';
  assert.equal(withoutContract(withContract(body)), body);
});

test('replaceContractBlock is the single splice and is idempotent', () => {
  const rendered = withContract('# Rules\n\nbody');
  const once = replaceContractBlock(rendered);
  assert.equal(replaceContractBlock(once), once);
  assert.equal(once.split(CONTRACT_START).length - 1, 1);
});

// ── regression: dangling markers used to delete user prose ───────────────────

test('REGRESSION an unpaired contract marker never truncates the file', () => {
  // The original bug: indexOf(CONTRACT_END) returned -1 and the code sliced at start+29,
  // cutting 29 bytes out of hand-written prose and duplicating the body. Byte count 162 → 2432.
  const damaged = `# X\n\n## MY IMPORTANT SECTION\n\nhuman rule: never force push\n\nmore prose\n\n${CONTRACT_START}\n## half\n`;

  assert.equal(inspectMarkers(damaged).health, 'unbalanced');

  const refreshed = refreshContract(damaged, AGENTS_RULE);
  assert.equal(refreshed.health, 'unbalanced-markers');
  assert.equal(refreshed.content, damaged, 'file must come back byte-identical');
  assert.match(refreshed.note ?? '', /unbalanced/);

  const rendered = renderRuleFile(AGENTS_RULE, CTX, damaged);
  assert.equal(rendered.content, damaged, 'renderRuleFile must refuse too');
  assert.ok(damaged.includes('never force push'));
  assert.ok(damaged.includes('more prose'));
});

test('REGRESSION a rule file documenting the markers in prose keeps its contract', () => {
  // Found while regenerating this repository: AGENTS.md explains the contract with the markers
  // inline ("never hand-edit the block between `<!-- engram:contract:start -->` and
  // `<!-- engram:contract:end -->`"). Treating those inline mentions as structural made the file
  // look unbalanced, so withContract refused to write and the real contract block was deleted.
  const documented = [
    '# engram — agent instructions',
    '',
    '- The contract block between `<!-- engram:contract:start -->` and',
    '  `<!-- engram:contract:end -->` is machine-owned. Never hand-edit it.',
    '',
    '_Read by: pi, codex._',
    '',
    '<!-- engram:managed -->',
    '',
  ].join('\n');

  assert.equal(inspectMarkers(documented).health, 'absent', 'prose mentions are not markers');
  const rendered = renderRuleFile(AGENTS_RULE, { projectName: 'demo' }, documented);
  assert.equal(rendered.health, 'ok', 'prose must not block the contract');
  assert.ok(rendered.content.includes(AI_CONTRACT), 'the contract must actually be written');
  assert.ok(rendered.content.includes('Never hand-edit it'), 'the human prose survives');
  assert.equal(inspectMarkers(rendered.content).health, 'balanced');

  // And it must survive a re-render unchanged.
  assert.equal(renderRuleFile(AGENTS_RULE, { projectName: 'demo' }, rendered.content).content, rendered.content);
});

test('markers inside a fenced code block are documentation, not the contract', () => {
  // A README-style file that *shows* an engram marker inside ``` must survive untouched.
  const doc = [
    '# Docs',
    '',
    'Here is how the marker looks:',
    '',
    '```markdown',
    CONTRACT_START,
    '## fake contract',
    CONTRACT_END,
    '```',
    '',
    '## Real content',
    '',
    'do not eat this fence',
    '',
  ].join('\n');

  assert.equal(inspectMarkers(doc).health, 'absent');
  assert.equal(findContractSpan(doc), null);
  assert.equal(stripContractBlock(doc), doc);

  const rendered = renderRuleFile(AGENTS_RULE, CTX, doc);
  assert.ok(rendered.content.includes('do not eat this fence'));
  assert.ok(rendered.content.includes('```markdown'), 'the fence and its example survive');
  // Two textual occurrences: the one inside the fence (documentation, preserved) and the real
  // block that was appended. Only the second is a contract, which inspectMarkers must prove.
  const after = inspectMarkers(rendered.content);
  assert.equal(after.health, 'balanced');
  assert.equal(after.starts, 1, 'exactly one *real* opening marker outside code fences');
});

test('inspectMarkers counts balanced pairs and flags both directions of breakage', () => {
  const balanced = withContract('# x');
  assert.equal(inspectMarkers(balanced).health, 'balanced');
  assert.equal(inspectMarkers(balanced).starts, 1);
  assert.equal(inspectMarkers(balanced).ends, 1);
  assert.equal(inspectMarkers('# nothing here').health, 'absent');
  assert.equal(inspectMarkers(`a\n${CONTRACT_END}\nb`).health, 'unbalanced');
});

// ── rendering invariants ─────────────────────────────────────────────────────

test('refreshContract is a no-op on a fresh file and repairs a damaged one', () => {
  const rendered = renderRuleFile(AGENTS_RULE, CTX).content;
  assert.equal(refreshContract(rendered, AGENTS_RULE).content, rendered);

  const repaired = refreshContract(staleContract(rendered), AGENTS_RULE);
  assert.ok(repaired.content.includes(AI_CONTRACT));
  assert.ok(!repaired.content.includes('a stale contract body'));
  assert.equal(refreshContract(repaired.content, AGENTS_RULE).content, repaired.content);
});

test('refreshContract appends the contract to a file that never had one', () => {
  const handWritten = '# Hand written\n\nTeam rules.\n';
  const next = refreshContract(handWritten, AGENTS_RULE);
  assert.ok(next.content.startsWith('# Hand written'));
  assert.ok(next.content.includes(AI_CONTRACT));
});

test('the managed marker survives a damaged contract repair', () => {
  const rendered = staleContract(renderRuleFile(AGENTS_RULE, CTX).content);
  const repaired = refreshContract(rendered, AGENTS_RULE);
  assert.equal(repaired.content.split(MANAGED_MARKER).length - 1, 1);
  assert.ok(repaired.content.includes(AI_CONTRACT));
});

test('renderRuleFile preserves an existing body and installs the contract', () => {
  const existing = '# Existing\n\ndo not clobber me\n';
  const out = renderRuleFile(AGENTS_RULE, { projectName: 'demo' }, existing);
  assert.ok(out.content.includes('do not clobber me'));
  assert.ok(out.content.includes(AI_CONTRACT));
});

test('REGRESSION the multi-client shared-reader note is stripped on re-render', () => {
  // Older versions appended `_Read by: codex, pi._` because several tools shared AGENTS.md. With one
  // client the note has nothing to say, so a re-render must remove it rather than leave a line naming
  // tools engram no longer installs for.
  const stale = renderRuleFile(AGENTS_RULE, { projectName: 'demo' });
  const withNote = `${stale.content}\n\n_Read by: codex, pi._\n`;
  const out = renderRuleFile(AGENTS_RULE, { projectName: 'demo' }, withNote);
  assert.ok(!out.content.includes('_Read by:'), 'the stale note is gone');
  assert.equal(out.content.split(MANAGED_MARKER).length - 1, 1);
});

test('every rendered rule file carries the managed marker exactly once', () => {
  const out = renderRuleFile(AGENTS_RULE, CTX);
  assert.equal(out.content.split(MANAGED_MARKER).length - 1, 1);
  assert.ok(out.content.indexOf(MANAGED_MARKER) < out.content.indexOf(CONTRACT_START), 'marker precedes contract');
});

test('re-rendering a managed rule file does not nest markers or contracts', () => {
  const first = renderRuleFile(AGENTS_RULE, CTX).content;
  const second = renderRuleFile(AGENTS_RULE, CTX, first).content;
  const third = renderRuleFile(AGENTS_RULE, CTX, second).content;
  assert.equal(second, first);
  assert.equal(third, first);
  assert.equal(second.split(MANAGED_MARKER).length - 1, 1);
  assert.equal(second.split(CONTRACT_START).length - 1, 1);
  assert.ok(second.includes(withoutContract(first).trim()), 'authored body survives every pass');
});

test('every rule kind is stable across three render passes', () => {
  // A blunt net for the whole bug class: whatever the file kind, re-rendering is a no-op.
  const kinds = [
    { path: 'AGENTS.md', kind: 'agents' as const, note: 't' },
    { path: 'CLAUDE.md', kind: 'claude' as const, note: 't' },
  ];
  for (const kind of kinds) {
    const ctx = { projectName: 'demo' };
    const a = renderRuleFile(kind, ctx).content;
    const b = renderRuleFile(kind, ctx, a).content;
    const c = renderRuleFile(kind, ctx, b).content;
    assert.equal(b, a, `${kind.path} is not stable after one re-render`);
    assert.equal(c, a, `${kind.path} is not stable after two re-renders`);
    assert.equal(a.split(MANAGED_MARKER).length - 1, 1, `${kind.path} marker count`);
    assert.equal(a.split(CONTRACT_START).length - 1, 1, `${kind.path} contract count`);
    assert.ok(a.trim().length > 0);
  }
});

test('re-rendering is a no-op and never adds a shared-reader note', () => {
  const ctx = { projectName: 'demo' };
  const first = renderRuleFile(AGENTS_RULE, ctx).content;
  const second = renderRuleFile(AGENTS_RULE, ctx, first).content;
  assert.equal(second, first);
  assert.ok(!second.includes('_Read by:'));
});

// ── canonical skills and skeleton ────────────────────────────────────────────

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

test('CURRENT_TASK template keeps blockers parseable (bullets, not a table)', () => {
  // Regression: the template shipped a Markdown table for Blockers while the parser skipped
  // table rows, so `blocked:` was structurally dead for every scaffolded repository.
  const task = aiSkeleton({ projectName: 'demo', today: '2026-10-01' }).find((f) =>
    f.path.endsWith('CURRENT_TASK.md'),
  );
  assert.ok(task);
  const parsed = parseCurrentTask(task.content);
  assert.equal(parsed.goal, '', 'placeholder guidance is not project state');
  assert.equal(parsed.nextAction, '');
  assert.deepEqual(parsed.blockers, [], 'an untouched template has no blockers');
  assert.ok(!parsed.goal.includes('<!--'), 'no comment text may leak into the fingerprint');
});