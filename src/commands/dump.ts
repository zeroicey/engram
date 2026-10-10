import { buildFingerprint, type Fingerprint } from '../core/fingerprint.js';
import { loadMemory } from '../core/memory.js';
import path from 'node:path';

export interface DumpOptions {
  root: string;
  maxBytes?: number;
  format?: 'markdown' | 'json';
  recentSessions?: number;
  acceptedDecisions?: number;
  proposals?: number;
  pitfalls?: number;
  projectName?: string;
}

export interface DumpResult extends Fingerprint {
  /** Non-zero when the repository has no `.ai/` bank yet. */
  exitCode: number;
  hint?: string;
  /**
   * Bank paths that exist but could not be read. A non-empty list means the fingerprint is
   * *partial*, not empty: reporting "no binding decisions" because a directory was unreadable
   * is the most damaging thing this tool could do.
   */
  readErrors: string[];
  /** Content problems in project-owned inputs (a malformed `sections.json`, …), not read failures. */
  warnings: string[];
}

export async function runDump(opts: DumpOptions): Promise<DumpResult> {
  const bank = await loadMemory(opts.root);
  if (!bank.exists) {
    return {
      markdown: '',
      bytes: 0,
      truncated: false,
      exitCode: 2,
      hint: `No .ai/ memory bank at ${path.join(opts.root, '.ai')}. Run \`engram init\` first.`,
      readErrors: bank.readErrors,
      warnings: bank.warnings,
      data: {
        project: path.basename(opts.root),
        generated: new Date().toISOString(),
        status: '',
        goal: '',
        nextAction: '',
        blockers: [],
        decisions: [],
        sessions: [],
        pitfalls: [],
        skills: [],
        bytes: 0,
        truncated: false,
      },
    };
  }
  const fp = buildFingerprint(bank, {
    maxBytes: opts.maxBytes,
    projectName: opts.projectName,
    recentSessions: opts.recentSessions,
    acceptedDecisions: opts.acceptedDecisions,
    proposals: opts.proposals,
    pitfalls: opts.pitfalls,
  });
  return { ...fp, exitCode: 0, readErrors: bank.readErrors, warnings: bank.warnings };
}

export interface DumpCliOptions extends DumpOptions {
  format?: 'markdown' | 'json';
  writeTo?: string;
  quiet?: boolean;
}

export function renderDump(result: DumpResult, format: 'markdown' | 'json'): string {
  if (result.exitCode === 2) return result.hint ?? '';
  return format === 'json' ? JSON.stringify(result.data, null, 2) : result.markdown;
}