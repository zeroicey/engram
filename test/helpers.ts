import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Sandbox {
  root: string;
  write(rel: string, content: string): Promise<string>;
  read(rel: string): Promise<string>;
  exists(rel: string): Promise<boolean>;
  list(rel?: string): Promise<string[]>;
  cleanup(): Promise<void>;
}

/**
 * Isolated temp directory; every test gets its own project root.
 *
 * The sandbox is a **git repository** by default, because `engram init` refuses to run anywhere
 * else (see `.ai/decisions/2026-10-18-require-a-git-repository-before-engram-initializes.md`).
 * Making that the default keeps every existing test honest: they exercise the real precondition
 * instead of a special-cased path. Tests that need the refusal use `sandboxWithoutGit`.
 */
export async function sandbox(prefix = 'engram-test-'): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await makeGitDir(root);
  return sandboxAt(root);
}

/** A sandbox that is **not** inside a working tree, for asserting the `init` refusal. */
export async function sandboxWithoutGit(prefix = 'engram-nogit-'): Promise<Sandbox> {
  return sandboxAt(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

/**
 * Write a minimal but real `.git` directory. Not a valid repository (no objects/refs), only the
 * marker the precondition looks for — engram never shells out to git.
 */
async function makeGitDir(root: string): Promise<void> {
  await fs.mkdir(path.join(root, '.git', 'objects'), { recursive: true });
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
}

/** Attach the sandbox helpers to an existing directory. */
function sandboxAt(root: string): Sandbox {
  return {
    root,
    async write(rel, content) {
      const abs = path.join(root, rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      return abs;
    },
    async read(rel) {
      return fs.readFile(path.join(root, rel), 'utf8');
    },
    async exists(rel) {
      try {
        await fs.stat(path.join(root, rel));
        return true;
      } catch {
        return false;
      }
    },
    async list(rel = '.') {
      try {
        const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
      } catch {
        return [];
      }
    },
    async cleanup() {
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

/** Minimal `.ai/` bank used by dump/fingerprint tests. */
export async function seedBank(sb: Sandbox): Promise<void> {
  await sb.write(
    '.ai/CURRENT_TASK.md',
    [
      '# Current task',
      '',
      '**Status:** 🟡 active · **Updated:** 2026-10-01',
      '',
      '## Goal',
      '',
      'Ship the parser rewrite behind a flag',
      '',
      '## Blockers',
      '',
      '| Blocker | Waiting on | Unblock by |',
      '| --- | --- | --- |',
      '| schema review | platform team | 2026-10-04 |',
      '',
      '## Next action',
      '',
      'Wire `--legacy` into the CLI',
      '',
    ].join('\n'),
  );
  await sb.write(
    '.ai/decisions/2026-09-01-adopt-zod.md',
    '# Adopt zod for runtime validation\n\n**Status:** ✅ ACCEPTED\n',
  );
  await sb.write(
    '.ai/decisions/2026-10-01-stream-parsing-proposal.md',
    '# Stream responses instead of buffering\n\n**Status:** 💭 PROPOSAL\n',
  );
  await sb.write(
    '.ai/decisions/2026-08-01-orm-choice.md',
    '# ORM choice\n\n**Status:** 🪦 REJECTED\n',
  );
  await sb.write(
    '.ai/sessions/2026-10-01-parser-handoff.md',
    '# Parser work — handoff\n\nBenchmarks live in `bench/parse.ts`.\n',
  );
  await sb.write(
    '.ai/sessions/2026-09-20-old-handoff.md',
    '# Old work — handoff\n\nSuperseded.\n',
  );
  await sb.write(
    '.ai/pitfalls/cases/worker-leak-on-abort.md',
    '# Workers leak when a request is aborted\n\n**Severity:** 🔴 high\n',
  );
  await sb.write('.ai/pitfalls/cases/_TEMPLATE.md', '# template\n');
  await sb.write('.ai/skills/handoff.md', '---\nname: handoff\n---\n\nbody\n');
}