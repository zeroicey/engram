/**
 * `engram doctor` — machine-checkable bank health.
 *
 * Why this exists as a command and not as advice: the same checks were run by hand, as shell loops,
 * against the seven repositories that adopted the bank, and **every one of the problems they found was
 * invisible to `engram` itself**. `clip`, `research` and `teleport` had rewritten `CURRENT_TASK.md` into
 * prose and lost `project:` / `next:` / `branch:` from every fingerprint; two repositories held
 * byte-identical untouched templates; `research` had two carriers with no canonical source. `sync`
 * reported "clean" for all seven, and `dump` reported success. Drift detection lived in an `/audit`
 * skill spec, i.e. in a model's willingness to look — which is not a check.
 *
 * The design rules, because a checker that lies is worse than no checker:
 *
 * - **Read-only.** Nothing here writes, and nothing here suggests a command that rewrites a project's
 *   own files. The bank is the project's; `doctor` reports, the project decides.
 * - **Absent is not empty is not broken.** A fresh scaffold has no entries and is healthy; a directory
 *   that cannot be read is not "no entries". Every finding carries a severity that says which.
 * - **One data structure, two renderings.** `--json` is the machine surface (so CI and `/audit` can
 *   consume it), the human text is derived from the same findings and cannot disagree.
 * - **`core/` stays pure.** The checks take an already-loaded bank plus the values they need, so they
 *   are testable without a filesystem; `commands/doctor.ts` does the I/O.
 */

import type { MemoryBank } from './memory.js';
import type { GoalRecord } from './goal.js';

/** How bad a finding is. Chosen so a caller can gate on `error` alone without reading any text. */
export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  /** Stable, machine-matchable id: `current-task/missing-headings`, `skills/orphan-carrier`, … */
  rule: string;
  severity: Severity;
  /** What is wrong, in one line. */
  message: string;
  /** How to fix it, when the fix is not obvious from the message. */
  hint?: string;
}

export interface DoctorInput {
  bank: MemoryBank;
  /** `env`-style values the checks need, kept explicit so the tests need no process state. */
  now?: string;
  /**
   * Carrier skill directories that exist on disk, with the names they contain.
   *
   * Passed in rather than discovered here: the sink layout belongs to `adapters/`, and a leaf check
   * that hard-coded `.agents/skills` would be the second place to update when a carrier moves.
   */
  carriers?: Array<{ dir: string; skills: string[] }>;
  /** `.ai/` files referenced by prose, already resolved to existence checks by the caller. */
  pathExists?: (rel: string) => Promise<boolean>;
}

/**
 * `CURRENT_TASK.md` is the one file read on **every** session start, so its size is a cost paid per
 * session, not per edit. The template says ~60 lines; the reference set ran 144–536.
 *
 * The threshold is deliberately generous (3× the guidance): the point of a checker is to catch the
 * 9× case that erodes the fingerprint and the opening context, not to nag about a 90-line file that a
 * project reads fine.
 */
export const CURRENT_TASK_WARN_LINES = 180;
export const CURRENT_TASK_ERROR_LINES = 400;

/** Decisions proposed and never adjudicated stop being proposals and become noise. */
export const PROPOSAL_STALE_DAYS = 14;

/**
 * Every check, over one loaded bank.
 *
 * Ordered by how much they cost the reader: a broken contract first (the fingerprint silently loses
 * fields), then scale, then the inputs that rot without anyone noticing.
 */
export async function runChecks(input: DoctorInput): Promise<Finding[]> {
  const { bank } = input;
  const findings: Finding[] = [];

  if (!bank.exists) {
    return [
      {
        rule: 'bank/absent',
        severity: 'error',
        message: 'no .ai/ memory bank in this repository',
        hint: 'run `engram init` to scaffold one',
      },
    ];
  }

  // --- the file every session reads -------------------------------------------------------------

  const task = bank.currentTask;
  if (task === null) {
    findings.push({
      rule: 'current-task/absent',
      severity: 'error',
      message: '.ai/CURRENT_TASK.md is missing — nothing tells a session what to work on',
      hint: 'run `engram sync` to scaffold it, or `engram init` on a fresh repository',
    });
  } else {
    if (task.missing.length) {
      findings.push({
        rule: 'current-task/missing-headings',
        severity: 'error',
        message: `CURRENT_TASK.md has no ${task.missing.join(' / ')} heading`,
        hint: 'the fingerprint cannot render what the file does not have: add the headings back, or run `engram new current-task`',
      });
    }
    // `empty` is the freshly-scaffolded state and is reported as info: a repository one minute after
    // `init` is not unhealthy, it is new. Saying otherwise teaches people to ignore the checker.
    if (task.empty.length === 3) {
      findings.push({
        rule: 'current-task/unwritten',
        severity: 'info',
        message: 'CURRENT_TASK.md has its headings and no content yet',
        hint: 'fill it in when the first session starts',
      });
    }
    const lines = task.raw.split('\n').length;
    if (lines > CURRENT_TASK_ERROR_LINES) {
      findings.push({
        rule: 'current-task/too-long',
        severity: 'error',
        message: `CURRENT_TASK.md is ${lines} lines — read on every session start, so this is a per-session cost`,
        hint: 'move finished rounds into `.ai/sessions/`; only the present state belongs here',
      });
    } else if (lines > CURRENT_TASK_WARN_LINES) {
      findings.push({
        rule: 'current-task/long',
        severity: 'warn',
        message: `CURRENT_TASK.md is ${lines} lines (guidance: ~60)`,
        hint: 'move completed rounds into `.ai/sessions/` and keep this file to what is true now',
      });
    }
    if (!task.updated) {
      findings.push({
        rule: 'current-task/no-updated',
        severity: 'info',
        message: 'CURRENT_TASK.md records no `**Updated:**` date',
        hint: 'a reader cannot tell a current file from an abandoned one without it',
      });
    }
  }

  // --- inputs that rot silently -----------------------------------------------------------------

  for (const rel of DEFAULTS_REQUIRED) {
    if (!(await exists(input, rel)) && !bankPathPresent(bank, rel)) {
      findings.push({
        rule: 'bank/missing-file',
        severity: 'warn',
        message: `${rel} is missing`,
        hint: 'run `engram sync` to restore the scaffold',
      });
    }
  }

  const unknown = bank.decisions.filter((d) => d.status === 'UNKNOWN');
  if (unknown.length) {
    findings.push({
      rule: 'decisions/unclassified',
      severity: 'warn',
      message: `${unknown.length} decision(s) have no readable status, so they never reach the fingerprint`,
      hint: `start the body with \`**Status:** 💭 PROPOSAL\` or \`✅ ACCEPTED\` — first: .ai/decisions/${unknown[0]?.file ?? ''}`,
    });
  }

  const stale = staleProposals(bank, input.now);
  if (stale.length) {
    findings.push({
      rule: 'decisions/stale-proposal',
      severity: 'warn',
      message: `${stale.length} proposal(s) older than ${PROPOSAL_STALE_DAYS} days with no verdict`,
      hint: `a proposal needs a verdict, not silence — first: .ai/decisions/${stale[0] ?? ''}`,
    });
  }

  // --- the goal engine -------------------------------------------------------------------------

  if (bank.goalErrors.length) {
    findings.push({
      rule: 'goal/unreadable',
      severity: 'error',
      message: `${bank.goalErrors.length} goal directory exists but cannot be read`,
      hint: `a damaged goal is not an absent one — ${bank.goalErrors[0] ?? ''}`,
    });
  }
  if (bank.goal !== null) {
    findings.push(...goalFindings(bank.goal.record, bank.goal.brief.doneWhen === null, bank.goal.brief.error));
  }

  // --- declared sections -----------------------------------------------------------------------

  for (const section of bank.sections) {
    if (!(await exists(input, section.dir))) {
      // Declared-but-absent is not an error: the section may simply have nothing in it yet. It is worth
      // saying because the pointer reaches the fingerprint, so a reader will look for it.
      findings.push({
        rule: 'sections/absent-dir',
        severity: 'info',
        message: `declared section "${section.name}" points at ${section.dir}, which does not exist`,
        hint: `create it, or remove the declaration from .ai/sections.json`,
      });
    }
  }

  // --- carriers vs canonical skills ------------------------------------------------------------

  const canonical = new Set(bank.skills.map((s) => s.replace(/\.md$/, '')));
  for (const carrier of input.carriers ?? []) {
    for (const name of carrier.skills) {
      if (canonical.has(name)) continue;
      findings.push({
        rule: 'skills/orphan-carrier',
        severity: 'warn',
        message: `${carrier.dir}/${name} has no ${'.ai/skills'}/${name}.md`,
        hint: 'move it to `.ai/skills/` so `sync` owns it, or delete it — a carrier engram cannot regenerate drifts silently',
      });
    }
  }

  return findings;
}

/** Files every bank is scaffolded with, checked only when the bank exists. */
const DEFAULTS_REQUIRED = ['.ai/CURRENT_TASK.md', '.ai/README.md', '.ai/ARCHITECTURE.md'] as const;

async function exists(input: DoctorInput, rel: string): Promise<boolean> {
  if (input.pathExists === undefined) return true; // no probe supplied: do not invent a failure
  return input.pathExists(rel);
}

/**
 * Whether a required file is one the loader already saw.
 *
 * `pathExists` is the caller's probe and the loader already read these; asking twice would make the
 * two disagree on a permission error, and the disagreement would read as a missing file.
 */
function bankPathPresent(bank: MemoryBank, rel: string): boolean {
  if (rel === '.ai/CURRENT_TASK.md') return bank.currentTask !== null;
  // `README`/`ARCHITECTURE` are read as prose and are not in the loaded shape; a read error is the only
  // signal, so treat an unreadable path as present-and-broken rather than absent.
  return !bank.readErrors.some((e) => e.includes(rel));
}

/** A proposal is stale when its date is older than the threshold and it still has no verdict. */
function staleProposals(bank: MemoryBank, now: string | undefined): string[] {
  if (now === undefined) return [];
  const today = Date.parse(now);
  if (!Number.isFinite(today)) return [];
  const cutoff = today - PROPOSAL_STALE_DAYS * 86_400_000;
  return bank.decisions
    .filter((d) => d.status === 'PROPOSAL' && d.date !== '')
    .filter((d) => {
      const at = Date.parse(d.date);
      return Number.isFinite(at) && at < cutoff;
    })
    .map((d) => d.file);
}

/** Goal-specific findings: an unjudgeable goal, and one that is closed but still counted as live. */
function goalFindings(record: GoalRecord, undeclared: boolean, briefError: string | null): Finding[] {
  const out: Finding[] = [];
  if (undeclared) {
    out.push({
      rule: 'goal/not-judgeable',
      severity: 'warn',
      message: `goal ${record.id} has no machine-checkable \`done_when\``,
      hint: 'add a ```json block under `## Done when` in its BRIEF.md — an unjudgeable goal cannot finish',
    });
  }
  if (briefError !== null) {
    out.push({
      rule: 'goal/brief-unreadable',
      severity: 'error',
      message: `goal ${record.id}: ${briefError}`,
      hint: 'fix the BRIEF.md `## Done when` block: a typo must not read as "not declared"',
    });
  }
  if (record.wake !== null && record.wake.handled) {
    // A latched wake that was already consumed is a stuck timer: the record says "waiting on this
    // token" while the engine will refuse that token as a duplicate.
    out.push({
      rule: 'goal/handled-wake-latched',
      severity: 'error',
      message: `goal ${record.id} still holds wake ${record.wake.token}, which is already handled`,
      hint: 'the wait can never fire — `engram goal check --id ' + record.id + '` re-arms or escalates it',
    });
  }
  return out;
}

/** The severity that decides the exit code: an `error` fails, a `warn` or `info` does not. */
export function hasErrors(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === 'error');
}

/** Counts per severity, so a caller can summarise without re-scanning. */
export function tally(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) out[f.severity] += 1;
  return out;
}
