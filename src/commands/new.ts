import path from 'node:path';
import { promises as fs } from 'node:fs';
import { asciiSlug, pathExists, readFileSafe, todayISO, writeFile } from '../core/project.js';
import { sectionFileName, sectionTemplatePath, type CustomSection } from '../core/sections.js';

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
  await assertDirIsUsable(path.dirname(abs), target.dir);
  const existing = await readFileSafe(abs);
  if (existing && !opts.force) return { path: rel, created: false };
  await writeFile(abs, renderNewFile(opts.kind, opts.title, date));
  return { path: rel, created: true };
}

/**
 * Fail with a sentence, not a stack trace, when a target directory is really a file.
 *
 * `ensureDir` on a path occupied by a file throws `EEXIST: file already exists, mkdir '<abs>'`, which
 * the CLI printed verbatim — technically accurate, useless to the reader, and it named neither the
 * section nor the fix.
 */
async function assertDirIsUsable(dir: string, label: string): Promise<void> {
  if (!(await pathExists(dir))) return;
  const stat = await fs.stat(dir).catch(() => null);
  if (stat && !stat.isDirectory()) throw new Error(`${label} is a file, not a directory — move it aside or change the section "dir"`);
}

export interface NewSectionOptions {
  root: string;
  /** A section the project declared in `.ai/sections.json`. */
  section: CustomSection;
  title: string;
  force?: boolean;
}

/**
 * Scaffold one file in a project-declared section.
 *
 * The project owns the shape, so when `<section dir>/_TEMPLATE.md` exists it is copied verbatim
 * (with the date and slug placeholders filled) rather than replaced by an engram-shaped stub.
 * That keeps `.ai/journal/_TEMPLATE.md` the single place the project defines what a journal entry
 * looks like — including its own status machine, which engram only documents.
 */
export async function runNewSection(opts: NewSectionOptions): Promise<NewResult> {
  const date = todayISO();
  const slug = asciiSlug(opts.title) || 'untitled';
  const rel = path.posix.join(opts.section.dir, sectionFileName(opts.section, date, slug));
  const abs = path.join(opts.root, rel);
  await assertDirIsUsable(path.dirname(abs), opts.section.dir);

  // Defence in depth behind `parseSections`: a `CustomSection` built by a library caller never went
  // through validation, and this function writes to a path derived from it. Resolve the target and
  // confirm it lands directly inside the declared directory before touching the filesystem.
  const dirAbs = path.resolve(opts.root, opts.section.dir);
  const target = path.resolve(abs);
  if (path.dirname(target) !== dirAbs) {
    throw new Error(`refusing to write outside ${opts.section.dir}: ${rel}`);
  }

  const existing = await readFileSafe(abs);
  if (existing && !opts.force) return { path: rel, created: false };

  const template = await readFileSafe(path.join(opts.root, sectionTemplatePath(opts.section)));
  const body = template
    ? template.replace(/YYYY-MM-DD/g, date).replace(/<slug>/g, slug)
    : renderSectionFile(opts.section, opts.title, date);
  await writeFile(abs, body);
  return { path: rel, created: true };
}

/** Fallback scaffold when the section ships no `_TEMPLATE.md`. */
function renderSectionFile(section: CustomSection, title: string, date: string): string {
  const status = section.status?.length ? `**Status:** ${section.status[0]} · **Date:** ${date}` : `**Date:** ${date}`;
  return `# ${title}\n\n${status}\n\n## Summary\n\n<!-- -->\n`;
}