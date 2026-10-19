/**
 * `engram doctor` — CLI wiring for the bank checks.
 *
 * The I/O lives here so `core/doctor.ts` stays a pure function of a loaded bank: carriers are
 * enumerated from the adapter registry (the sink layout is `adapters/`' business), and path probes go
 * through `core/project.ts` like every other reader.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { compactCurrentTask, loadMemory, POINTER_PREFIX } from '../core/memory.js';
import { hasErrors, runChecks, tally, type Finding } from '../core/doctor.js';
import { pathExists, readFileSafe, readIfPresent, writeFile } from '../core/project.js';
import { TOOLS } from '../adapters/index.js';

export interface DoctorOptions {
  root: string;
  format?: 'text' | 'json';
  /**
   * Apply the one mechanical fix: move completed milestones out of `CURRENT_TASK.md` into
   * `.ai/sessions/_milestone-log-archive.md`.
   *
   * Deliberately the *only* fix, and deliberately narrow. Every other finding is a judgement about a
   * project's own prose — which of two `## Goal` paragraphs is still true, whether a heading was dropped
   * on purpose — and a tool that guessed would be a second writer of the file the human already owns.
   * This one is mechanical, append-only, and loses nothing: a `- [x]` entry leaves one file and arrives
   * verbatim in another.
   */
  fix?: boolean;
  /** Injected so the stale-proposal check is testable without waiting two weeks. */
  now?: string;
}

export interface DoctorResult {
  exitCode: number;
  findings: Finding[];
  lines: string[];
  /** What `--fix` changed, when it ran. */
  fixed?: { moved: number; archive: string; wrote: boolean };
}

/** Every skill-carrier directory in the registry, with the skill names it currently holds. */
async function carriers(root: string): Promise<Array<{ dir: string; skills: string[] }>> {
  const out: Array<{ dir: string; skills: string[] }> = [];
  for (const tool of TOOLS) {
    for (const sink of tool.skillSinks) {
      // Only the Agent Skills shape is a skill carrier in the "one file per skill" sense; the
      // prompt-template sink holds command files and is checked by `sync`, not here.
      if (sink.kind !== 'agent-skills') continue;
      const abs = path.join(root, sink.dir);
      let names: string[] = [];
      try {
        const entries = await fs.readdir(abs, { withFileTypes: true });
        names = entries.filter((e) => e.isDirectory()).map((e) => e.name);
      } catch {
        // A carrier directory that does not exist is the normal state before the first `sync`.
        continue;
      }
      out.push({ dir: sink.dir, skills: names });
    }
  }
  return out;
}

/** `.ai/sessions/_milestone-log-archive.md` — inert by naming, so it never reaches the fingerprint. */
export const ARCHIVE_REL = '.ai/sessions/_milestone-log-archive.md';

/**
 * Move completed milestones out of `CURRENT_TASK.md`, appending them to the archive.
 *
 * The archive is **appended to**, never rewritten: a second run must not lose the first run's entries,
 * and a human may have added their own notes under the same heading.
 */
async function applyCompact(
  root: string,
): Promise<{ moved: number; archive: string; wrote: boolean; error?: string }> {
  const taskPath = path.join(root, '.ai/CURRENT_TASK.md');
  const raw = await readFileSafe(taskPath);
  if (raw === null) return { moved: 0, archive: ARCHIVE_REL, wrote: false };

  const before = raw;
  const { currentTask, moved, movedCount } = compactCurrentTask(raw);
  if (moved.length === 0) return { moved: 0, archive: ARCHIVE_REL, wrote: false };

  const archivePath = path.join(root, ARCHIVE_REL);
  // `readIfPresent`, not `readFileSafe`: the latter collapses "unreadable" to `null`, and treating an
  // archive that failed to read transiently as absent **overwrote it** with only the new entries —
  // permanent loss of everything previously archived. Losing history is the one thing this command
  // promises not to do, so a read error stops the run.
  const read = await readIfPresent(archivePath);
  if (read.error) return { moved: 0, archive: ARCHIVE_REL, wrote: false, error: `cannot read ${ARCHIVE_REL}: ${read.error}` };
  const existing = read.text ?? `# Completed milestones\n`;
  const body = existing.endsWith('\n') ? existing : `${existing}\n`;
  // A heading for the run, so two compactions months apart are distinguishable in the file.
  const stamp = new Date().toISOString().slice(0, 10);
  // The **task file first**: the archive is append-only, so a crash after this write but before it would
  // otherwise leave the milestone in both files and the next `--fix` would append it a second time.
  await writeFile(taskPath, before === currentTask ? before : currentTask);
  await writeFile(archivePath, `${body}\n## Compacted ${stamp}\n\n${moved.join('\n')}\n`);
  return { moved: movedCount, archive: ARCHIVE_REL, wrote: before !== currentTask };
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const bank = await loadMemory(opts.root);
  const findings = await runChecks({
    bank,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    carriers: await carriers(opts.root),
    pathExists: (rel: string) => pathExists(path.join(opts.root, rel)),
  });

  // `--fix` runs after the checks so it can report what changed, and it re-checks nothing: the caller
  // sees the state as found, plus what the fix did about the one thing it may touch.
  const fixed = opts.fix === true ? await applyCompact(opts.root) : undefined;

  if (opts.format === 'json') {
    return {
      exitCode: hasErrors(findings) ? 1 : 0,
      findings,
      // One JSON document, and the human text is derived from the same findings so the two cannot
      // disagree about what was found.
      lines: [JSON.stringify({ root: opts.root, summary: tally(findings), findings, ...(fixed ? { fixed } : {}) }, null, 2)],
      ...(fixed ? { fixed } : {}),
    };
  }

  const fixLines: string[] = [];
  if (fixed !== undefined) {
    fixLines.push(
      fixed.error !== undefined
        ? `  NOTHING WAS MOVED — ${fixed.error}`
        : fixed.moved === 0
          ? '  (nothing to compact: no completed milestones in CURRENT_TASK.md)'
          : `  moved ${fixed.moved} completed milestone(s) → ${fixed.archive}`,
    );
  }

  const counts = tally(findings);
  if (findings.length === 0) {
    return {
      exitCode: 0,
      findings,
      lines: [`✅ ${path.basename(opts.root)}: bank is healthy`, ...fixLines],
      ...(fixed ? { fixed } : {}),
    };
  }
  const icon = { error: '✗', warn: '⚠', info: '·' } as const;
  const lines = findings.map((f) => {
    const head = `${icon[f.severity]} ${f.rule}: ${f.message}`;
    return f.hint === undefined ? head : `${head}\n    → ${f.hint}`;
  });
  if (fixLines.length) lines.push('', 'fixed:', ...fixLines);
  lines.push(
    `\n${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} note(s) — ` +
      (counts.error ? 'errors block; warnings and notes do not' : 'nothing blocking'),
  );
  return { exitCode: hasErrors(findings) ? 1 : 0, findings, lines, ...(fixed ? { fixed } : {}) };
}
