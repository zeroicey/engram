import assert from 'node:assert/strict';
import { test } from 'node:test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { findGitRepository, workingTreeDigest } from '../src/core/git.js';
import { main } from '../src/cli.js';
import { sandbox, sandboxWithoutGit, type Sandbox } from './helpers.js';

/** Mark a sandbox directory as a working-tree root, the way a real checkout looks. */
async function makeRepo(sb: Sandbox, marker: 'directory' | 'file' = 'directory'): Promise<void> {
  const dotGit = path.join(sb.root, '.git');
  // The sandbox already contains a `.git` directory; drop it so either marker can be written.
  await fs.rm(dotGit, { recursive: true, force: true });
  if (marker === 'directory') {
    await fs.mkdir(path.join(dotGit, 'objects'), { recursive: true });
    await fs.writeFile(path.join(dotGit, 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    return;
  }
  // Linked worktrees and `--separate-git-dir` record the real repository in a `.git` *file*.
  await fs.writeFile(dotGit, 'gitdir: /somewhere/else/.git/worktrees/wt\n', 'utf8');
}

/** Run `engram init` in-process with stdout/stderr captured. */
async function initIn(root: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const wOut = process.stdout.write.bind(process.stdout);
  const wErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array): boolean => {
    out.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array): boolean => {
    err.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(['init', '--root', root, '--tools', 'codex']);
    return { code, out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = wOut;
    process.stderr.write = wErr;
  }
}

test('findGitRepository walks upwards and reports the enclosing root', async () => {
  const sb = await sandbox();
  try {
    await makeRepo(sb);
    const nested = path.join(sb.root, 'packages', 'app');
    await fs.mkdir(nested, { recursive: true });

    const fromNested = await findGitRepository(nested);
    assert.equal(fromNested.hasRepository, true);
    assert.equal(fromNested.repositoryRoot, await fs.realpath(sb.root));
    assert.equal(fromNested.marker, 'directory');

    const fromRoot = await findGitRepository(sb.root);
    assert.equal(fromRoot.repositoryRoot, await fs.realpath(sb.root));
  } finally {
    await sb.cleanup();
  }
});

test('findGitRepository accepts a .git file, not only a directory', async () => {
  const sb = await sandbox();
  try {
    await makeRepo(sb, 'file');
    const check = await findGitRepository(sb.root);
    assert.equal(check.hasRepository, true);
    assert.equal(check.marker, 'file');
  } finally {
    await sb.cleanup();
  }
});

test('findGitRepository reports no repository outside a working tree', async () => {
  const sb = await sandbox();
  try {
    // os.tmpdir() is not inside a repository on any supported platform; if it ever is, this test
    // is meaningless rather than wrong, so it asserts the shape it can rely on.
    const check = await findGitRepository(sb.root);
    if (check.hasRepository) {
      assert.ok(check.repositoryRoot !== null);
    } else {
      assert.equal(check.repositoryRoot, null);
      assert.equal(check.marker, null);
    }
  } finally {
    await sb.cleanup();
  }
});

test('the working-tree digest cannot be moved by a no-op touch', async (t) => {
  // `workingTreeDigest` is the stuck detector's only input, and it had no test at all — which is how a
  // detector this central stayed evadable. The digest was `size:mtime`, and mtime is *model-controlled*:
  // one `touch README.md` per round reset `unchangedRounds` to 0 forever, so the one detector built
  // because "the model may be looping without progress" could be defeated by a no-op write. Measured:
  // touching an unchanged file changed the digest.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await makeRepo(sb, 'directory');
  await sb.write('a.txt', 'hello');
  const first = await workingTreeDigest(sb.root);
  assert.notEqual(first, null, 'a git working tree must produce a digest');

  // A pure mtime bump must not count as progress.
  await new Promise((r) => setTimeout(r, 20));
  await fs.utimes(path.join(sb.root, 'a.txt'), new Date(), new Date());
  assert.equal(await workingTreeDigest(sb.root), first, 'touch is not progress');

  // A same-length content change must count — that is what `size` alone missed.
  await sb.write('a.txt', 'world');
  assert.notEqual(await workingTreeDigest(sb.root), first, 'an equal-length edit is progress');
});

test('a truncated walk reports unknown, not unchanged', async (t) => {
  // Past `maxEntries` or the depth cap the walk silently stopped, and the digest it returned was compared
  // as though it covered the whole tree. An edit outside the sampled subset then read as "nothing
  // changed", so a *productive* goal would be declared stuck. Measured: `workingTreeDigest(root, 5)` on
  // this repository returned the same digest twice while ignoring most of it.
  //
  // `null` is the reducer's "the host cannot see a working tree", and since round 3 that is bounded by the
  // stuck ceiling rather than looking healthy forever — so "unknown" escalates instead of lying.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await makeRepo(sb, 'directory');
  for (let i = 0; i < 10; i++) await sb.write(`f${i}.txt`, `content ${i}`);

  assert.equal(await workingTreeDigest(sb.root, 3), null, 'a capped walk must not report a digest');
  assert.notEqual(await workingTreeDigest(sb.root, 20_000), null, 'an uncapped walk still works');
});

test('the working-tree digest ignores the engine own bookkeeping', async (t) => {
  // `.ai/goal` is rewritten by the very transition that reads the digest, so including it pinned
  // `unchangedRounds` at 0 in production while the tests (which inject a literal digest) stayed green.
  const sb = await sandbox();
  t.after(() => sb.cleanup());
  await makeRepo(sb, 'directory');
  await sb.write('a.txt', 'hello');
  await sb.write('.ai/goal/g/goal.json', '{"version":1}');
  const first = await workingTreeDigest(sb.root);
  await sb.write('.ai/goal/g/goal.json', '{"version":1,"updatedAt":"later"}');
  assert.equal(await workingTreeDigest(sb.root), first, 'the engine writing its own record is not progress');
});

test('init refuses outside git and writes nothing at all', async () => {
  const sb = await sandboxWithoutGit();
  try {
    const before = await sb.list();
    const res = await initIn(sb.root);

    assert.equal(res.code, 1, 'a refusal must not exit 0');
    assert.match(res.err, /not inside a git repository/);
    assert.match(res.err, /Nothing was written/);
    // No partial bank: refusing after writing `.ai/README.md` would be the worst outcome.
    assert.deepEqual(await sb.list(), before);
    assert.equal(await sb.exists('.ai'), false);
    assert.equal(await sb.exists('.engram'), false);
  } finally {
    await sb.cleanup();
  }
});

test('init --dry-run does not bypass the git precondition', async () => {
  const sb = await sandboxWithoutGit();
  try {
    const res = await main(['init', '--root', sb.root, '--tools', 'codex', '--dry-run']).then(
      (code) => ({ code }),
    );
    assert.equal(res.code, 1);
    assert.equal(await sb.exists('.ai'), false);
  } finally {
    await sb.cleanup();
  }
});

test('init runs inside a git repository', async () => {
  const sb = await sandbox();
  try {
    await makeRepo(sb);
    const res = await initIn(sb.root);

    assert.equal(res.code, 0, res.err);
    assert.equal(await sb.exists('.ai/CURRENT_TASK.md'), true);
    assert.equal(await sb.exists('.ai/decisions/_TEMPLATE.md'), true);
    // Root == repository root, so the "enclosing repository" note must stay out of the output.
    assert.doesNotMatch(res.out, /using enclosing git/);
  } finally {
    await sb.cleanup();
  }
});

test('init on a subdirectory of a repository keeps the bank in the subdirectory', async () => {
  const sb = await sandbox();
  try {
    await makeRepo(sb);
    const sub = path.join(sb.root, 'tools', 'cli');
    await fs.mkdir(sub, { recursive: true });

    const res = await initIn(sub);
    assert.equal(res.code, 0, res.err);
    assert.equal(await fs.stat(path.join(sub, '.ai/CURRENT_TASK.md')).then(() => true), true);
    // The bank must not be hoisted to the repository root: the user pointed at the subdirectory.
    assert.equal(await fs.stat(path.join(sb.root, '.ai')).then(() => true).catch(() => false), false);
    assert.match(res.out, /using enclosing git repository/);
  } finally {
    await sb.cleanup();
  }
});
