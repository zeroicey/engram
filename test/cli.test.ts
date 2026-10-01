import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { sandbox } from './helpers.js';

const pkg = JSON.parse(
  await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8'),
) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

/** Run `main` with stdout captured. */
async function run(args: string[]): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await main(args);
    return { code, out: chunks.join('') };
  } finally {
    process.stdout.write = original;
  }
}

test('package declares zero runtime dependencies', () => {
  assert.equal(pkg.dependencies, undefined, 'a scaffolder must not ship runtime dependencies');
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), ['@types/node', 'typescript']);
});

test('--help and --version work without arguments', async () => {
  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.out.trim(), /^\d+\.\d+\.\d+$/);

  const help = await run(['--help']);
  assert.equal(help.code, 0);
  for (const cmd of ['init', 'dump', 'new', 'sync', 'tools']) {
    assert.ok(help.out.includes(cmd), `help omits ${cmd}`);
  }
});

test('unknown command exits 1', async () => {
  const res = await run(['frobnicate']);
  assert.equal(res.code, 1);
});

test('tools lists every adapter', async () => {
  const res = await run(['tools']);
  assert.equal(res.code, 0);
  for (const id of ['agents', 'claude', 'cursor', 'pi', 'codex', 'copilot', 'gemini', 'windsurf']) {
    assert.ok(res.out.includes(id), `tools omits ${id}`);
  }
});

test('init → dump → sync runs end to end through the CLI surface', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write('package.json', JSON.stringify({ name: 'demo-app', scripts: { test: 'node --test' } }));

  const init = await run(['init', '--tools', 'agents,claude', '--notes', 'prefer pnpm', '--root', sb.root]);
  assert.equal(init.code, 0);
  assert.match(init.out, /BOOTSTRAP\.md/);
  assert.match(init.out, /engram sync/);

  assert.match(await sb.read('AGENTS.md'), /Project memory bank/);
  assert.match(await sb.read('.engram/BOOTSTRAP.md'), /prefer pnpm/);

  const dump = await run(['dump', '--root', sb.root]);
  assert.equal(dump.code, 0);
  const bytes = Buffer.byteLength(dump.out, 'utf8');
  assert.ok(bytes <= 1500 + 40, `fingerprint must respect the budget (got ${bytes})`);
  assert.match(dump.out, /POINTERS/);

  const sync = await run(['sync', '--root', sb.root]);
  assert.equal(sync.code, 0);
  assert.match(sync.out, /skill files materialised/);
});

test('dump honours --max-bytes and --json', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await run(['init', '--tools', 'agents', '--root', sb.root]);

  const tight = await run(['dump', '--root', sb.root, '--max-bytes', '420']);
  assert.ok(Buffer.byteLength(tight.out, 'utf8') <= 460);

  const json = await run(['dump', '--root', sb.root, '--json']);
  const parsed = JSON.parse(json.out) as { project: string; bytes: number };
  assert.equal(typeof parsed.project, 'string');
  assert.ok(parsed.bytes <= 1500);
});

test('dump --out writes the fingerprint to a file', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await run(['init', '--tools', 'agents', '--root', sb.root]);
  await run(['dump', '--root', sb.root, '--out', path.join('.engram', 'LAST.md')]);
  assert.match(await sb.read('.engram/LAST.md'), /^# engram v1/);
});

test('dump without a bank exits 2', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  const res = await run(['dump', '--root', sb.root]);
  assert.equal(res.code, 2);
  assert.match(res.out, /engram init/);
});