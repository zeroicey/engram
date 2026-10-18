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
