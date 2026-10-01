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
  /** Existing AI-tool rule files found in the repo. */
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
export async function detectProject(root: string): Promise<ProjectFacts> {
  return {
    root,
    name: await detectProjectName(root),
    stack: await detectStack(root),
    scripts: await detectScripts(root),
    dirs: await detectDirs(root),
    hasGit: await pathExists(path.join(root, '.git')),
    existingRuleFiles: await detectRuleFiles(root),
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

const RULE_FILE_CANDIDATES = [
  'AGENTS.md',
  'AGENTS.override.md',
  'CLAUDE.md',
  'GEMINI.md',
  '.cursorrules',
  '.github/copilot-instructions.md',
  '.windsurfrules',
  '.clinerules',
];

async function detectRuleFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const c of RULE_FILE_CANDIDATES) {
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
