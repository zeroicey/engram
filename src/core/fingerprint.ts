import { CANONICAL_SKILL_NAMES, skillCommandList } from './canon.js';
import type { DecisionEntry, MemoryBank } from './memory.js';

export interface FingerprintOptions {
  /** Hard byte ceiling for the rendered markdown. Default 1500. */
  maxBytes?: number;
  /** Recent sessions to mention. Default 3. */
  recentSessions?: number;
  /** Accepted decisions to mention. Default 3. */
  acceptedDecisions?: number;
  /** Proposals (unratified) to mention. Default 2. */
  proposals?: number;
  /** Pitfall cases to mention. Default 2. */
  pitfalls?: number;
  /** Project label shown in the header. */
  projectName?: string;
}

export interface Fingerprint {
  markdown: string;
  bytes: number;
  truncated: boolean;
  /** Parsed view for `--json` consumers and tests. */
  data: {
    project: string;
    generated: string;
    status: string;
    goal: string;
    nextAction: string;
    blockers: string[];
    decisions: Array<{ date: string; status: DecisionEntry['status']; title: string; file: string }>;
    sessions: Array<{ date: string; title: string; file: string }>;
    pitfalls: Array<{ title: string; severity: string; file: string }>;
    skills: string[];
    bytes: number;
    truncated: boolean;
  };
}

const MARK = { ACCEPTED: '✅', PROPOSAL: '💭', REJECTED: '🪦', UNKNOWN: '·' } satisfies Record<
  DecisionEntry['status'],
  string
>;

/**
 * Trim to a *byte* budget, never splitting a surrogate pair.
 *
 * The old version counted UTF-16 code units while the budget counted UTF-8 bytes: a CJK line of
 * "120 chars" was 360 bytes, and a run of emoji could be cut between a pair's halves, emitting a
 * lone surrogate that serialises as U+FFFD into the one artefact this product exists to produce.
 */
export const trimTo = (s: string, maxBytes: number): string => {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  const limit = Math.max(1, maxBytes - Buffer.byteLength('…', 'utf8'));
  let out = '';
  let used = 0;
  for (const ch of s) {
    const w = Buffer.byteLength(ch, 'utf8');
    if (used + w > limit) break;
    out += ch;
    used += w;
  }
  const sp = out.lastIndexOf(' ');
  const body = sp > limit * 0.6 ? out.slice(0, sp) : out;
  return `${body.trimEnd()}…`;
};

const line = (label: string, value: string, max = 110): string =>
  value ? `${label}: ${trimTo(value, max)}` : '';

interface FingerprintSection {
  heading: string;
  lines: string[];
  priority: number;
}

export function buildFingerprint(bank: MemoryBank, opts: FingerprintOptions = {}): Fingerprint {
  const maxBytes = opts.maxBytes ?? 1500;
  const project = trimTo(opts.projectName ?? path_label(bank), 60);
  const recent = opts.recentSessions ?? 3;
  const acceptedN = opts.acceptedDecisions ?? 3;
  const proposalN = opts.proposals ?? 2;
  const pitfallN = opts.pitfalls ?? 2;
  const generated = new Date().toISOString();

  const accepted = bank.decisions.filter((d) => d.status === 'ACCEPTED').slice(0, acceptedN);
  const proposals = bank.decisions.filter((d) => d.status === 'PROPOSAL').slice(0, proposalN);
  const sessions = bank.sessions.slice(0, recent);
  const pitfalls = bank.pitfalls.slice(0, pitfallN);

  const t = bank.currentTask;

  // Sections are ordered by value-per-byte; the builder drops them from the bottom up
  // when the budget is exceeded, and never drops NOW or POINTERS.
  type Section = FingerprintSection;
  const sections: Section[] = [];

  const now: string[] = [];
  if (t?.status) now.push(line('state', t.status));
  if (t?.goal) now.push(line('goal', t.goal, 120));
  if (t?.codeState) now.push(line('branch', t.codeState, 110));
  if (t?.nextAction) now.push(line('next', t.nextAction, 120));
  for (const b of t?.blockers ?? []) now.push(line('blocked', b, 100));
  if (now.length) sections.push({ heading: 'NOW', lines: now, priority: 0 });

  const decisionLines = [
    ...proposals.map((d) => `  ${MARK.PROPOSAL} ${d.date} ${trimTo(d.title, 70)} [proposal: needs verdict]`),
    ...accepted.map((d) => `  ${MARK.ACCEPTED} ${d.date} ${trimTo(d.title, 70)}`),
  ];
  if (decisionLines.length) sections.push({ heading: 'BINDING', lines: decisionLines, priority: 1 });

  if (sessions.length) {
    sections.push({
      heading: 'RECENT',
      lines: sessions.map((s) => `  ${s.date} ${trimTo(s.title, 78)} → .ai/sessions/${s.file}`),
      priority: 2,
    });
  }

  if (pitfalls.length) {
    sections.push({
      heading: 'PITFALLS',
      lines: pitfalls.map((p) => `  ⚠ ${trimTo(p.title, 70)} → .ai/pitfalls/cases/${p.file}`),
      priority: 3,
    });
  }

  const skillNames = bank.skills.map((s) => s.replace(/\.md$/, ''));
  // Bounded: a bank with dozens of skill files must not spend the whole budget on one pointer line.
  const shown = skillNames.slice(0, 8);
  const skillsText = shown.length ? [...shown, ...(skillNames.length > 8 ? ['…'] : [])] : [...CANONICAL_SKILL_NAMES];
  const pointers = [
    '  state: .ai/CURRENT_TASK.md · map: .ai/README.md · architecture: .ai/ARCHITECTURE.md',
    `  skills: ${skillCommandList(skillsText)} (specs: .ai/skills/)`,
  ];
  sections.push({ heading: 'POINTERS', lines: pointers, priority: 4 });

  const header = (): string[] => [
    `# engram v1 · ${project} · ${generated.slice(0, 10)}`,
    'Read .ai/CURRENT_TASK.md first. Follow the rule file (AGENTS.md/CLAUDE.md/…) for the full contract.',
  ];

  const fitted = fitToBudget(header, sections, maxBytes);
  const markdown = fitted.markdown;
  const bytes = Buffer.byteLength(markdown, 'utf8');
  return {
    markdown,
    bytes,
    truncated: fitted.truncated,
    data: {
      project,
      generated,
      status: t?.status ?? '',
      goal: t?.goal ?? '',
      nextAction: t?.nextAction ?? '',
      blockers: t?.blockers ?? [],
      // Same set the markdown renders: proposals then accepted. A JSON consumer building a
      // "what am I bound by" view previously got a different, misleading answer.
      decisions: [...proposals, ...accepted].map((d) => ({
        date: d.date,
        status: d.status,
        title: trimTo(d.title, 120),
        file: `.ai/decisions/${d.file}`,
      })),
      sessions: sessions.map((s) => ({ date: s.date, title: s.title, file: `.ai/sessions/${s.file}` })),
      pitfalls: pitfalls.map((p) => ({
        title: p.title,
        severity: p.severity,
        file: `.ai/pitfalls/cases/${p.file}`,
      })),
      skills: bank.skills.map((s) => `/${s.replace(/\.md$/, '')}`),
      bytes,
      truncated: fitted.truncated,
    },
  };
}

/** Priorities whose sections may be dropped or shortened when the byte budget is tight. */
const ELASTIC_PRIORITIES = [3, 2, 1];

/**
 * Render sections into at most `maxBytes` UTF-8 bytes.
 *
 * Dropping elastic sections is not a guarantee: the header, one `NOW` line and the pointer line
 * have an irreducible floor (~338 bytes measured). When even that exceeds the budget the output is
 * hard-cut on a byte boundary with an explicit elision marker, because a documented ceiling that
 * silently overflows is worse than a short document that admits it was cut.
 */
function fitToBudget(
  header: () => string[],
  sections: FingerprintSection[],
  maxBytes: number,
): { markdown: string; truncated: boolean } {
  const render = (kept: FingerprintSection[]): string =>
    [...header(), ...kept.flatMap((s) => [s.heading, ...s.lines]), ''].join('\n');

  const size = (kept: FingerprintSection[]): number =>
    Buffer.byteLength(render(kept), 'utf8');
  const fits = (kept: FingerprintSection[]): boolean => size(kept) <= maxBytes;

  let kept = [...sections];
  // Rendered before anything is dropped, so "was anything left out?" is a byte comparison
  // rather than a guess about which branch ran.
  const full = render(kept);
  for (const p of ELASTIC_PRIORITIES) {
    if (fits(kept)) break;
    kept = kept.filter((s) => s.priority !== p);
  }
  // Shorten what remains: the elastic sections first, then NOW, never below one line each.
  for (const p of [...ELASTIC_PRIORITIES, 0]) {
    const s = kept.find((x) => x.priority === p);
    while (s && s.lines.length > 1 && !fits(kept)) s.lines.pop();
  }
  let markdown = render(kept);
  if (!fits(kept)) markdown = hardTruncate(markdown, maxBytes);
  // "Truncated" means content was left out to fit the budget — whether a section was dropped,
  // a line was elided, or bytes were cut. Reporting only byte-cuts claimed "under budget" while
  // silently dropping the binding decisions.
  return { markdown, truncated: markdown !== full };
}

/** Final safety net: cut on a byte boundary, never mid-codepoint. */
function hardTruncate(text: string, maxBytes: number): string {
  if (maxBytes <= 1) return '';
  const marker = '…';
  const limit = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = Buffer.byteLength(ch, 'utf8');
    if (used + w > limit) break;
    out += ch;
    used += w;
  }
  return `${out.replace(/\s+$/u, '')}${marker}`;
}

function path_label(bank: MemoryBank): string {
  const parts = bank.root.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? 'project';
}