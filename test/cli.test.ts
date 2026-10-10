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
  // js-yaml is a deliberate devDependency: the frontmatter bug in 0.2.0 shipped because a regex
  // test could not tell valid YAML from invalid. Parsing for real is the only assertion that
  // catches it. It never reaches a consumer: `files` ships build/src only.
  assert.deepEqual(Object.keys(pkg.devDependencies ?? {}).sort(), ['@types/node', 'js-yaml', 'typescript']);
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
  for (const id of ['agents', 'claude', 'cursor', 'pi', 'codex', 'copilot', 'gemini', 'windsurf', 'dsh']) {
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

test('REGRESSION dump --json emits parseable JSON on stdout even when it fails', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  const res = await run(['dump', '--json', '--root', sb.root]);
  assert.equal(res.code, 2);
  const parsed = JSON.parse(res.out) as { error: string; bank: boolean };
  assert.equal(parsed.bank, false);
  assert.match(parsed.error, /engram init/);
});

test('REGRESSION sync on an uninitialised repo fails instead of reporting success', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  const res = await run(['sync', '--root', sb.root]);
  assert.equal(res.code, 1, 'a green exit here makes an agent believe the contract is installed');
  assert.match(res.out, /missing\s+AGENTS\.md/, 'absent files must say "missing", not "unchanged"');
});

test('REGRESSION sync --tools with a typo is reported', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  const res = await run(['sync', '--tools', 'bogus', '--root', sb.root]);
  assert.equal(res.code, 1);
});

test('REGRESSION the installed (symlinked) bin still runs', async (t) => {
  // npm exposes `.bin/engram` as a symlink; without realpath the CLI exited 0 with no output.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await run(['init', '--tools', 'agents', '--root', sb.root]);
  const link = path.join(sb.root, 'engram-bin');
  await fs.symlink(path.resolve('build/src/cli.js'), link);
  const { execFile } = await import('node:child_process');
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, [link, '--version'], (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()),
    );
  });
  assert.match(out, /^\d+\.\d+\.\d+$/, 'the symlinked entry point produced no version');
});

test('REGRESSION init --force really regenerates a rule file', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await sb.write('AGENTS.md', '# Human rules\n\nNever touch deploy.\n');
  const plain = await run(['init', '--tools', 'agents', '--root', sb.root]);
  assert.equal(plain.code, 0);
  const preserved = await sb.read('AGENTS.md');
  assert.ok(preserved.includes('Never touch deploy.'), 'default init preserves human content');

  const forced = await run(['init', '--tools', 'agents', '--force', '--root', sb.root]);
  assert.equal(forced.code, 0);
  const regenerated = await sb.read('AGENTS.md');
  assert.ok(!regenerated.includes('Never touch deploy.'), '--force must replace the stubbed body');
  assert.ok(regenerated.includes('engram:contract:start'), 'and still install the contract');
});

test('dump --out writes the requested format', async (t) => {
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await run(['init', '--tools', 'agents', '--root', sb.root]);
  await run(['dump', '--json', '--out', 'snap.json', '--root', sb.root]);
  const written = JSON.parse(await sb.read('snap.json')) as { project: string };
  assert.equal(typeof written.project, 'string');
});