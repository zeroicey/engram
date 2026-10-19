/**
 * `engram doctor` — CLI wiring for the bank checks.
 *
 * The I/O lives here so `core/doctor.ts` stays a pure function of a loaded bank: carriers are
 * enumerated from the adapter registry (the sink layout is `adapters/`' business), and path probes go
 * through `core/project.ts` like every other reader.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadMemory } from '../core/memory.js';
import { hasErrors, runChecks, tally, type Finding } from '../core/doctor.js';
import { pathExists } from '../core/project.js';
import { TOOLS } from '../adapters/index.js';

export interface DoctorOptions {
  root: string;
  format?: 'text' | 'json';
  /** Injected so the stale-proposal check is testable without waiting two weeks. */
  now?: string;
}

export interface DoctorResult {
  exitCode: number;
  findings: Finding[];
  lines: string[];
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

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const bank = await loadMemory(opts.root);
  const findings = await runChecks({
    bank,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    carriers: await carriers(opts.root),
    pathExists: (rel: string) => pathExists(path.join(opts.root, rel)),
  });

  if (opts.format === 'json') {
    return {
      exitCode: hasErrors(findings) ? 1 : 0,
      findings,
      // One JSON document, and the human text is derived from the same findings so the two cannot
      // disagree about what was found.
      lines: [JSON.stringify({ root: opts.root, summary: tally(findings), findings }, null, 2)],
    };
  }

  const counts = tally(findings);
  if (findings.length === 0) {
    return { exitCode: 0, findings, lines: [`✅ ${path.basename(opts.root)}: bank is healthy`] };
  }
  const icon = { error: '✗', warn: '⚠', info: '·' } as const;
  const lines = findings.map((f) => {
    const head = `${icon[f.severity]} ${f.rule}: ${f.message}`;
    return f.hint === undefined ? head : `${head}\n    → ${f.hint}`;
  });
  lines.push(
    `\n${counts.error} error(s), ${counts.warn} warning(s), ${counts.info} note(s) — ` +
      (counts.error ? 'errors block; warnings and notes do not' : 'nothing blocking'),
  );
  return { exitCode: hasErrors(findings) ? 1 : 0, findings, lines };
}
