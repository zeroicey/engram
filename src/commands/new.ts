import path from 'node:path';
import { asciiSlug, readFileSafe, todayISO, writeFile } from '../core/project.js';

export type MemoryKind = 'decision' | 'session' | 'pitfall' | 'runbook';

const TARGETS: Record<MemoryKind, { dir: string; suffix: string; title: string }> = {
  decision: { dir: '.ai/decisions', suffix: '.md', title: 'Decision title' },
  session: { dir: '.ai/sessions', suffix: '-handoff.md', title: 'Session topic — handoff' },
  pitfall: { dir: '.ai/pitfalls/cases', suffix: '.md', title: 'Failure mode as a sentence' },
  runbook: { dir: '.ai/runbooks', suffix: '.md', title: 'Runbook title' },
};

const HEADERS: Record<MemoryKind, string> = {
  decision: `**Status:** 💭 PROPOSAL · **Date:** {{date}} · **Deciders:** `,
  session: `**Date:** {{date}} · **Branch/Commit:** `,
  pitfall: `**Severity:** 🟠 medium · **First hit:** {{date}} · **Hits since:** 0`,
  runbook: `**Applies to:** · **Owner:** · **Last verified:** {{date}}`,
};

const SECTIONS: Record<MemoryKind, string[]> = {
  decision: ['## Context', '## Options', '## Decision', '## Consequences', '## Revisit when'],
  session: [
    '## Where we ended',
    '## What changed',
    '## Verified / unverified',
    '## Loose ends',
    '## Do not repeat',
    '## Next step',
  ],
  pitfall: ['## Symptom', '## Root cause', '## Fix', '## Guard'],
  runbook: ['## When to use this', '## Preconditions', '## Procedure', '## Verification', '## Rollback'],
};

export interface NewOptions {
  root: string;
  kind: MemoryKind;
  title: string;
  /** Overwrite when the target file already exists. */
  force?: boolean;
}

export interface NewResult {
  path: string;
  created: boolean;
}

export function renderNewFile(kind: MemoryKind, title: string, date = todayISO()): string {
  const header = HEADERS[kind].replace('{{date}}', date);
  const sections = SECTIONS[kind].map((s) => `${s}\n\n<!-- -->\n`).join('\n');
  return `# ${title}\n\n${header}\n\n${sections}`;
}

export function isMemoryKind(value: string): value is MemoryKind {
  return value in TARGETS;
}

export async function runNew(opts: NewOptions): Promise<NewResult> {
  const target = TARGETS[opts.kind];
  const slug = asciiSlug(opts.title) || 'untitled';
  const date = todayISO();
  const rel = path.posix.join(target.dir, `${date}-${slug}${target.suffix}`);
  const abs = path.join(opts.root, rel);
  const existing = await readFileSafe(abs);
  if (existing && !opts.force) return { path: rel, created: false };
  await writeFile(abs, renderNewFile(opts.kind, opts.title, date));
  return { path: rel, created: true };
}