import { promises as fs } from 'node:fs';
import path from 'node:path';
import { MANAGED_MARKER } from '../templates/contract.js';

export interface ProjectFacts {
  root: string;
  name: string;
  /** Detected stack/tooling, e.g. `typescript`, `node >= 20`, `npm`, `vitest`. */
  stack: string[];
  /** Non-test npm scripts, useful for the bootstrap meta-prompt. */
  scripts: string[];
  /** Top-level directories (excluding dotfiles and heavy trees). */
  dirs: string[];
  hasGit: boolean;
  /**
   * Pre-existing AI-tool rule files found in the repo, excluding the ones engram generated.
   *
   * The candidate list is supplied by the caller from the tool registry rather than hardcoded in
   * this leaf: duplicating vendor filenames here meant adding a tool touched two files, and
   * forgetting the second failed *silently* — `init` simply stopped reporting that a rule file
   * already existed, and the bootstrap meta-prompt told the model none was there.
   */
  existingRuleFiles: string[];
}

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'site-packages',
  '.next',
  '.nuxt',
  'tmp',
]);

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(p: string): Promise<boolean> {
  try {
    const stats = await fs.stat(p);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function readFileSafe(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export interface ReadResult {
  /** File content, or `null` when the path simply does not exist. */
  text: string | null;
  /** Set when the read failed for a reason other than "absent" (EACCES, EMFILE, …). */
  error: string | null;
}

/**
 * Read a file, distinguishing "not there" from "there but unreadable".
 *
 * Collapsing EACCES into "no decisions" is the worst failure this tool can make: the fingerprint
 * then asserts a project has no binding decisions, with exit code 0 and nothing on stderr.
 */
export async function readIfPresent(p: string): Promise<ReadResult> {
  try {
    return { text: await fs.readFile(p, 'utf8'), error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { text: null, error: null };
    return { text: null, error: `${p}: ${code || 'read failed'}` };
  }
}

export interface ListResult {
  names: string[];
  error: string | null;
}

/** List a directory, reporting an unreadable directory instead of an empty one. */
export async function listIfPresent(dir: string): Promise<ListResult> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return { names: entries.filter((e) => e.isFile()).map((e) => e.name), error: null };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { names: [], error: null };
    return { names: [], error: `${dir}: ${code || 'readdir failed'}` };
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Write only when the file is absent. Returns true when a file was created. */
export async function writeIfMissing(file: string, content: string): Promise<boolean> {
  if (await pathExists(file)) return false;
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, 'utf8');
  return true;
}

export async function writeFile(file: string, content: string): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, 'utf8');
}

/**
 * Does writing `file` stay inside `root`, even through symlinks?
 *
 * `fs.writeFile` follows symlinks, so a symlinked carrier — `.agents/skills/foo/SKILL.md` pointing at
 * a file elsewhere, or `.agents/skills` itself pointing at another directory — made `engram sync`
 * overwrite a file the project never asked engram to own. The check resolves the *nearest existing
 * ancestor* rather than the parent, because the parent may not exist yet and creating it is exactly
 * the operation that would escape.
 */
export async function resolvesInsideRoot(root: string, file: string): Promise<boolean> {
  const realRoot = await fs.realpath(root).catch(() => null);
  if (realRoot === null) return false;
  let cur = path.dirname(path.resolve(file));
  for (;;) {
    const real = await fs.realpath(cur).catch(() => null);
    if (real !== null) return real === realRoot || real.startsWith(realRoot + path.sep);
    const up = path.dirname(cur);
    if (up === cur) return false;
    cur = up;
  }
}

/**
 * Write a generated file without following a symlink out of the project.
 *
 * A symlinked *leaf* is replaced with a real file: the link was a stale indirection at a path engram
 * owns, and unlinking it is far less destructive than writing through it. A symlinked *directory* is
 * refused outright — there is nowhere safe to put the file.
 *
 * Returns `false` when the write was refused, so the caller can warn instead of failing silently.
 */
export async function writeFileGuarded(root: string, file: string, content: string): Promise<boolean> {
  if (!(await resolvesInsideRoot(root, file))) return false;
  const link = await fs.lstat(file).catch(() => null);
  if (link?.isSymbolicLink()) await fs.rm(file, { force: true });
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, content, 'utf8');
  return true;
}

export async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** Files beginning with `_` are templates and never participate in dumps or audits. */
export const isTemplateName = (name: string): boolean => name.startsWith('_');

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Latin-only slug with CJK stripped; keeps filenames portable across tools. */
export function asciiSlug(input: string): string {
  const base = slugify(input);
  const ascii = base.replace(/[^a-z0-9-]+/g, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  return ascii || 'untitled';
}

export function todayISO(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}
export async function detectProject(
  root: string,
  /** Rule-file paths to probe. Supplied from `adapters/index.ts` by the caller. */
  ruleFileCandidates: readonly string[] = [],
): Promise<ProjectFacts> {
  return {
    root,
    name: await detectProjectName(root),
    stack: await detectStack(root),
    scripts: await detectScripts(root),
    dirs: await detectDirs(root),
    hasGit: await pathExists(path.join(root, '.git')),
    existingRuleFiles: await detectRuleFiles(root, ruleFileCandidates),
  };
}

async function detectProjectName(root: string): Promise<string> {
  const pkgRaw = await readFileSafe(path.join(root, 'package.json'));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as { name?: string };
      if (pkg.name) return pkg.name.replace(/^@[^/]+\//, '');
    } catch {
      /* malformed package.json: fall through to the directory name */
    }
  }
  return path.basename(root);
}

async function detectScripts(root: string): Promise<string[]> {
  const pkgRaw = await readFileSafe(path.join(root, 'package.json'));
  if (!pkgRaw) return [];
  try {
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const names = Object.keys(pkg.scripts ?? {});
    const rank = (s: string): number => (/^(dev|build|start|lint|typecheck|test)/.test(s) ? 0 : 1);
    return names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b)).slice(0, 12);
  } catch {
    return [];
  }
}

const JS_DEPS = ['typescript', 'react', 'next', 'vue', 'svelte', 'vite', 'express', 'fastify'];

const MANIFESTS: ReadonlyArray<readonly [string, string]> = [
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['Gemfile', 'ruby'],
  ['composer.json', 'php'],
  ['docker-compose.yml', 'docker'],
  ['Dockerfile', 'docker'],
  ['Makefile', 'make'],
];

async function detectStack(root: string): Promise<string[]> {
  const stack: string[] = [];
  const pkgRaw = await readFileSafe(path.join(root, 'package.json'));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        engines?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      stack.push('node');
      if (pkg.engines?.node) stack.push(`node ${pkg.engines.node}`);
      for (const dep of JS_DEPS) {
        if (pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]) stack.push(dep);
      }
    } catch {
      /* malformed package.json: ignore */
    }
  }
  for (const [file, label] of MANIFESTS) {
    if (await pathExists(path.join(root, file))) stack.push(label);
  }
  return [...new Set(stack)];
}

async function detectDirs(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[] = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue;
    dirs.push(e.name);
    if (dirs.length >= 25) break;
  }
  return dirs.sort((a, b) => a.localeCompare(b));
}

async function detectRuleFiles(root: string, candidates: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const c of candidates) {
    const abs = path.join(root, c);
    if (!(await pathExists(abs))) continue;
    const content = (await readFileSafe(abs)) ?? '';
    // Files engram generated are not "pre-existing" for reporting purposes; excluding them keeps
    // `init` idempotent.
    if (content.includes(MANAGED_MARKER)) continue;
    found.push(c);
  }
  return found;
}
