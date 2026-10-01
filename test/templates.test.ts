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

const AGENTS_RULE = { path: 'AGENTS.md', kind: 'agents' as const, note: 'test' };
const CURSOR_RULE = { path: '.cursor/rules/engram-memory.mdc', kind: 'cursor' as const, note: 'test' };
const WS_RULE = { path: '.windsurf/rules/engram-memory.md', kind: 'windsurf' as const, note: 'test' };
const CTX = { projectName: 'demo', alsoReadBy: [] as string[] };

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
  const rendered = renderRuleFile(AGENTS_RULE, { projectName: 'demo', alsoReadBy: ['pi'] }, documented);
  assert.equal(rendered.health, 'ok', 'prose must not block the contract');
  assert.ok(rendered.content.includes(AI_CONTRACT), 'the contract must actually be written');
  assert.ok(rendered.content.includes('Never hand-edit it'), 'the human prose survives');
  assert.equal(inspectMarkers(rendered.content).health, 'balanced');

  // And it must survive a re-render unchanged.
  assert.equal(renderRuleFile(AGENTS_RULE, { projectName: 'demo', alsoReadBy: ['pi'] }, rendered.content).content, rendered.content);
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

// ── frontmatter preservation ─────────────────────────────────────────────────

test('REGRESSION a user rule narrowed to alwaysApply:false is not silently promoted', () => {
  const userRule = [
    '---',
    'description: MY OWN RULE - do not touch',
    'globs: "src/**"',
    'alwaysApply: false',
    '---',
    '# My rule',
    '',
    'Keep this scope, it is deliberate.',
    '',
  ].join('\n');

  const rendered = renderRuleFile(CURSOR_RULE, CTX, userRule);
  assert.ok(rendered.content.includes('alwaysApply: false'), 'narrow scope must survive');
  assert.ok(rendered.content.includes('globs: "src/**"'));
  assert.ok(rendered.content.includes('Keep this scope'));
  assert.ok(!rendered.content.includes('alwaysApply: true'));
  assert.ok(rendered.content.startsWith('---'), 'frontmatter stays first');
  assert.equal(rendered.content.split('\n---\n').length, 2, 'no nested frontmatter');
});

test('a frontmatter rule with no keys of its own gains engram defaults', () => {
  const bare = '---\nalwaysApply: false\n---\n\n# only key\n';
  const rendered = renderRuleFile(WS_RULE, CTX, bare);
  assert.ok(rendered.content.includes('alwaysApply: false'));
  assert.ok(rendered.content.includes('trigger: always_on'), 'missing key is filled in');
});

test('cursor alwaysApply rule does not carry ignored keys', () => {
  const out = renderRuleFile(CURSOR_RULE, CTX);
  assert.ok(out.content.startsWith('---\nalwaysApply: true\n---\n'));
  assert.ok(!out.content.includes('globs:'), 'Cursor ignores globs when alwaysApply is set');
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

test('renderRuleFile preserves an existing body but notes shared readers', () => {
  const existing = '# Existing\n\ndo not clobber me\n';
  const out = renderRuleFile(AGENTS_RULE, { projectName: 'demo', alsoReadBy: ['codex', 'pi'] }, existing);
  assert.ok(out.content.includes('do not clobber me'));
  assert.match(out.content, /_Read by: codex, pi\._/);
  assert.ok(out.content.includes(AI_CONTRACT));
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

test('re-rendering a frontmatter file never duplicates its frontmatter', () => {
  const first = renderRuleFile(CURSOR_RULE, CTX).content;
  const second = renderRuleFile(CURSOR_RULE, CTX, first).content;
  assert.equal(second, first);
  assert.equal(second.split('alwaysApply: true').length - 1, 1);
  assert.ok(second.startsWith('---\n'));
});

test('REGRESSION a rule file kind with no frontmatter does not accumulate duplicates', () => {
  // `.github/copilot-instructions.md` is kind `copilot` but has no frontmatter, so its merge
  // path produced an empty default. Returning the whole file there spliced a second copy of the
  // body on every render: the managed marker went 1 -> 3 across a few `init` runs.
  const rule = { path: '.github/copilot-instructions.md', kind: 'copilot' as const, note: 't' };
  const first = renderRuleFile(rule, CTX).content;
  const second = renderRuleFile(rule, CTX, first).content;
  const third = renderRuleFile(rule, CTX, second).content;
  assert.equal(second, first);
  assert.equal(third, second);
  assert.equal(second.split(MANAGED_MARKER).length - 1, 1);
  assert.equal(second.split(CONTRACT_START).length - 1, 1);
  assert.ok(second.split('\n# engram — agent instructions\n').length - 1 <= 1, 'body must not duplicate');
  assert.ok(!second.startsWith('---\n'), 'no frontmatter is invented for this file');
});

test('every rule kind is stable across three render passes', () => {
  // A blunt net for the whole bug class: whatever the file kind, re-rendering is a no-op.
  const kinds = [
    { path: 'AGENTS.md', kind: 'agents' as const, note: 't' },
    { path: 'CLAUDE.md', kind: 'claude' as const, note: 't' },
    { path: 'GEMINI.md', kind: 'gemini' as const, note: 't' },
    { path: '.cursor/rules/x.mdc', kind: 'cursor' as const, note: 't' },
    { path: '.windsurf/rules/x.md', kind: 'windsurf' as const, note: 't' },
    { path: '.github/copilot-instructions.md', kind: 'copilot' as const, note: 't' },
    { path: '.github/instructions/x.instructions.md', kind: 'copilot' as const, note: 't' },
  ];
  for (const kind of kinds) {
    const ctx = { projectName: 'demo', alsoReadBy: ['pi'] };
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

test('shared-reader notes appear once no matter how often init runs', () => {
  const ctx = { projectName: 'demo', alsoReadBy: ['codex', 'pi'] };
  const first = renderRuleFile(AGENTS_RULE, ctx).content;
  const second = renderRuleFile(AGENTS_RULE, ctx, first).content;
  assert.equal(second, first);
  assert.equal(second.split('_Read by:').length - 1, 1);
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
  assert.ok(parsed.goal.length > 0, 'template goal must parse');
  assert.ok(parsed.nextAction.length > 0, 'template next action must parse');
});