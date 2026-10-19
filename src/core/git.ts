import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Is this directory inside a git working tree, and where does that tree root?
 *
 * The check walks **upwards**, exactly like git does: a subdirectory of a repository is a valid
 * target, and the enclosing repository is the unit of history. That is the whole reason this is not
 * `pathExists(path.join(root, '.git'))` — a value that only answers "is this the top-level folder".
 *
 * Deliberately dependency-free and `git`-binary-free: engram keeps zero runtime dependencies, and a
 * `.git` **file** also counts, because that is how `git worktree add` and `--separate-git-dir`
 * record a working tree whose repository lives elsewhere.
 */
export interface GitCheck {
  /** Some ancestor (or `root` itself) is a working-tree root. */
  hasRepository: boolean;
  /** Absolute path of the nearest enclosing working-tree root, when one was found. */
  repositoryRoot: string | null;
  /** What was found at `repositoryRoot`: a directory (normal checkout) or a file (worktree). */
  marker: 'directory' | 'file' | null;
}

/** A `.git` entry: a directory for a normal checkout, a file for a linked worktree or a separate git dir. */
async function gitMarker(dir: string): Promise<'directory' | 'file' | null> {
  try {
    const st = await fs.stat(path.join(dir, '.git'));
    if (st.isDirectory()) return 'directory';
    if (st.isFile()) return 'file';
    return null;
  } catch {
    return null;
  }
}

/**
 * Walk from `start` to the filesystem root looking for a working-tree marker.
 *
 * `start` is realpath'd first so a target reached through a symlink is judged by where it actually
 * is; otherwise a symlinked project could "find" a repository that does not contain it.
 */
export async function findGitRepository(start: string): Promise<GitCheck> {
  const real = await fs.realpath(start).catch(() => null);
  if (real === null) return { hasRepository: false, repositoryRoot: null, marker: null };

  let cur = real;
  for (;;) {
    const marker = await gitMarker(cur);
    if (marker !== null) return { hasRepository: true, repositoryRoot: cur, marker };
    const up = path.dirname(cur);
    if (up === cur) return { hasRepository: false, repositoryRoot: null, marker: null };
    cur = up;
  }
}

/**
 * Read `HEAD` without running git, to get a working-tree digest.
 *
 * The goal engine's "no file change across K rounds" detector needs to know whether anything
 * happened. Doing that honestly requires the *working tree*, not just the commit — an agent that
 * edited six files and committed none has made progress, and a detector that says otherwise blocks a
 * productive goal. So the digest is `HEAD` + every tracked-file mtime/size under the working tree.
 *
 * Reading git's own index was the obvious alternative and it is worse: it is a binary format, it is
 * updated by commands that do not change files (`git status` refreshes stat data), and parsing it is
 * a second implementation of git in a tool that promised not to have one. `stat` is enough for
 * "did anything change", which is all a stuck detector needs.
 *
 * Returns `null` when the host cannot see a working tree — and `null` must never be read as
 * "unchanged", or every round on a non-git project would look stuck.
 */
/**
 * Above this size a file contributes its size only, not a content hash.
 *
 * The digest runs on every `goal_report`, so it must stay cheap: reading a 200 MB build artifact on each
 * report would cost more than the evasion it closes. A stuck detector is looking at source files.
 */
const CONTENT_HASH_MAX_BYTES = 512 * 1024;

export async function workingTreeDigest(root: string, maxEntries = 20_000): Promise<string | null> {
  const check = await findGitRepository(root);
  const repositoryRoot = check.repositoryRoot;
  if (!check.hasRepository || repositoryRoot === null) return null;

  const head = await readHead(repositoryRoot);
  const parts: string[] = [head ?? 'no-head'];
  const IGNORED = new Set(['.git', 'node_modules', 'dist', 'build', 'out', 'target', 'coverage', '__pycache__', '.venv', 'venv']);

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (parts.length > maxEntries || depth > 12) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (parts.length > maxEntries) return;
      if (e.name.startsWith('.') && e.name !== '.ai') continue;
      if (IGNORED.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // The engine's own bookkeeping is not evidence of progress, and it is rewritten by the very
        // transition that reads this digest — so including it pinned the no-progress detector at
        // `unchangedRounds: 0` in production, while the tests (which inject a literal digest) stayed
        // green. Measured: two consecutive digests with nothing but a `writeGoalRecord` between them
        // differed on every run, because `goal.json` carries the record's own `updatedAt`.
        if (path.relative(repositoryRoot, full) === path.join('.ai', 'goal')) continue;
        await walk(full, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const st = await fs.stat(full);
        // Content, not just size+mtime. Size alone misses an equal-length edit, and mtime is
        // model-controlled input: `touch README.md` (or any formatter that rewrites an unchanged file)
        // bumped the mtime and reset `unchangedRounds` to 0 on every report, so the stuck detector — which
        // exists precisely because a model may be looping without progress — could be defeated by one
        // no-op write per round. Measured: touch on an unchanged file changed the digest.
        //
        // The cost is reading the bytes we were already stat-ing. Files above CONTENT_HASH_MAX_BYTES keep
        // the cheap fields: a multi-megabyte artifact is not what a stuck detector is watching, and
        // reading the whole tree on every report would be a worse trade than the evasion it closes.
        const rel = path.relative(repositoryRoot, full);
        if (st.size <= CONTENT_HASH_MAX_BYTES) {
          const body = await fs.readFile(full);
          parts.push(`${rel}:${st.size}:${hash(body.toString('latin1'))}`);
        } else {
          parts.push(`${rel}:${st.size}:big`);
        }
      } catch {
        /* a file that vanished mid-walk is not a change worth reporting */
      }
    }
  };

  await walk(repositoryRoot, 0);
  parts.sort();
  // A short, stable fingerprint: the detector only compares digests, it never parses one.
  return `${parts.length}:${hash(parts.join('\n'))}`;
}

/** `HEAD` ref or detached sha; `null` when the repository has no commits yet. */
async function readHead(repositoryRoot: string): Promise<string | null> {
  const gitDir = await resolveGitDir(repositoryRoot);
  if (gitDir === null) return null;
  try {
    const head = await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8');
    const ref = /^ref:\s*(\S+)/.exec(head.trim());
    if (!ref?.[1]) return head.trim();
    const refPath = path.join(gitDir, ref[1]);
    const sha = await fs.readFile(refPath, 'utf8').catch(() => null);
    return sha?.trim() ?? ref[1];
  } catch {
    return null;
  }
}

/** `.git` may be a file (`gitdir: …`) in a linked worktree. */
async function resolveGitDir(repositoryRoot: string): Promise<string | null> {
  const marker = path.join(repositoryRoot, '.git');
  const st = await fs.stat(marker).catch(() => null);
  if (st === null) return null;
  if (st.isDirectory()) return marker;
  try {
    const text = await fs.readFile(marker, 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m?.[1]) return null;
    const target = m[1].trim();
    return path.isAbsolute(target) ? target : path.resolve(repositoryRoot, target);
  } catch {
    return null;
  }
}

/**
 * FNV-1a, 32-bit. Not a security hash — a change detector. Chosen because it is four lines with no
 * dependency and `node:crypto` would be a heavier import for a number nobody reads.
 */
function hash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
