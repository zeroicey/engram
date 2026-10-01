import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Architectural rules, enforced.
 *
 * `.ai/ARCHITECTURE.md` §3 calls `core/` the leaf layer and `AGENTS.md` forbids it importing from
 * `commands/`, `adapters/` or the meta-prompt. Before this file existed, that rule was prose: a
 * stray import would have passed CI, tests included. The layering is what makes `core/` testable
 * in memory, so it is worth a test rather than a convention.
 *
 * This reads the real source tree, so it keeps working through refactors instead of drifting.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/** Packages `core/` may import from, besides itself and the Node standard library. */
const CORE_ALLOWED = /^(\.|node:)/;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Relative specifiers imported by a TypeScript file, ignoring type-only imports. */
function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*import\s+(?!type\s)[^'"]*from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');
}

const rel = (file: string): string => path.relative(SRC, file).split(path.sep).join('/');

test('core/ imports nothing from commands, adapters or templates', async () => {
  const files = await walk(path.join(SRC, 'core'));
  assert.ok(files.length >= 4, 'core/ should hold several modules');

  const violations: string[] = [];
  for (const file of files) {
    for (const spec of importsOf(await fs.readFile(file, 'utf8'))) {
      if (CORE_ALLOWED.test(spec)) continue;
      violations.push(`${rel(file)} → ${spec}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `core/ must stay the leaf layer:\n  ${violations.join('\n  ')}`,
  );
});

test('templates/ performs no filesystem access', async () => {
  const files = await walk(path.join(SRC, 'templates'));
  const violations: string[] = [];
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    for (const spec of importsOf(source)) {
      if (!/^node:fs/.test(spec) && !/^node:(path|os|process)\b/.test(spec)) continue;
      // `node:path` is pure string manipulation, not I/O; only fs/process touch the machine.
      if (/^node:(fs|process)/.test(spec)) violations.push(`${rel(file)} → ${spec}`);
    }
    if (/\bfs\.(readFile|writeFile|readdir|mkdir|stat|rm)\b/.test(source)) {
      violations.push(`${rel(file)} calls fs.* directly`);
    }
  }
  assert.deepEqual(violations, [], `templates/ must build strings only:\n  ${violations.join('\n  ')}`);
});

test('adapters/ never touch the filesystem either', async () => {
  const files = await walk(path.join(SRC, 'adapters'));
  const violations: string[] = [];
  for (const file of files) {
    const source = await fs.readFile(file, 'utf8');
    if (/from\s*['"]node:fs/.test(source)) violations.push(`${rel(file)} imports node:fs`);
    if (/\bfs\.(readFile|writeFile|readdir|mkdir|stat|rm)\b/.test(source)) {
      violations.push(`${rel(file)} calls fs.* directly`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `adapters/ must be pure renderers; content is passed in by commands/:\n  ${violations.join('\n  ')}`,
  );
});

test('every relative import resolves to a real module', async () => {
  const files = await walk(SRC);
  const missing: string[] = [];
  for (const file of files) {
    for (const spec of importsOf(await fs.readFile(file, 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts'));
      if (!files.includes(target)) missing.push(`${rel(file)} → ${spec}`);
    }
  }
  assert.deepEqual(missing, [], `unresolved relative imports:\n  ${missing.join('\n  ')}`);
});

test('the layering invariants in ARCHITECTURE.md still describe the code', async () => {
  const arch = await fs.readFile(path.join(ROOT, '.ai', 'ARCHITECTURE.md'), 'utf8');
  // Guard against the test going vacuous: this file is read as a *document*, and a scaffolded
  // template would satisfy every assertion below while asserting nothing about this codebase.
  assert.ok(!arch.includes('Single file by design'), 'ARCHITECTURE.md is still the scaffold template');
  assert.ok(arch.includes('src/'), 'ARCHITECTURE.md should describe this repository');
  const registry = await fs.readFile(path.join(SRC, 'adapters', 'index.ts'), 'utf8');
  // "TOOLS is the single place to fix" was documented and false: the frontmatter dialect lived in
  // rules.ts while the tool record lived in index.ts, so a maintainer following the doc changed
  // the wrong file and saw no effect.
  assert.ok(
    !/single place to fix/i.test(arch) || /frontmatter/i.test(arch),
    'if ARCHITECTURE.md still claims one place, it must name where the format strings live',
  );
  assert.ok(registry.includes('styleGuide'), 'the registry keeps the per-tool style guides');
});

test('SKILL_SPECS and the fingerprint fallback list cannot drift apart', async () => {
  // The fallback branch once hardcoded four names; adding a fifth skill left it advertising four.
  const canon = await fs.readFile(path.join(SRC, 'core', 'canon.ts'), 'utf8');
  const specs = await fs.readFile(path.join(SRC, 'templates', 'skills.ts'), 'utf8');
  const canonNames = [...canon.matchAll(/'(\w[\w-]*)'/g)].map((m) => m[1]).filter(Boolean);
  const specNames = [...specs.matchAll(/^\s*name: '([\w-]+)',$/gm)].map((m) => m[1]);
  assert.deepEqual(
    [...specNames].sort(),
    [...canonNames].sort(),
    'add a skill to SKILL_SPECS *and* CANONICAL_SKILL_NAMES',
  );
});