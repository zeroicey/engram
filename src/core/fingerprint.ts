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

const trimTo = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
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
  const project = opts.projectName ?? path_label(bank);
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

  const pointers = [
    '  state: .ai/CURRENT_TASK.md · map: .ai/README.md · architecture: .ai/ARCHITECTURE.md',
    bank.skills.length
      ? `  skills: ${bank.skills.map((s) => `/${s.replace(/\.md$/, '')}`).join(' ')} (specs: .ai/skills/)`
      : '  skills: /handoff /remember-pitfall /remember-decision /audit (specs: .ai/skills/)',
  ];
  sections.push({ heading: 'POINTERS', lines: pointers, priority: 4 });

  const header = (): string[] => [
    `# engram v1 · ${project} · ${generated.slice(0, 10)}`,
    'Read .ai/CURRENT_TASK.md first. Follow the rule file (AGENTS.md/CLAUDE.md/…) for the full contract.',
  ];

  const markdown = fitToBudget(header, sections, maxBytes);

  const bytes = Buffer.byteLength(markdown, 'utf8');
  return {
    markdown,
    bytes,
    truncated: bytes >= maxBytes - 1,
    data: {
      project,
      generated,
      status: t?.status ?? '',
      goal: t?.goal ?? '',
      nextAction: t?.nextAction ?? '',
      blockers: t?.blockers ?? [],
      decisions: bank.decisions.slice(0, acceptedN + proposalN).map((d) => ({
        date: d.date,
        status: d.status,
        title: d.title,
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
      truncated: bytes >= maxBytes - 1,
    },
  };
}

/** Priorities whose sections may be dropped or shortened when the byte budget is tight. */
const ELASTIC_PRIORITIES = [3, 2, 1];

function fitToBudget(
  header: () => string[],
  sections: FingerprintSection[],
  maxBytes: number,
): string {
  const render = (kept: FingerprintSection[]): string =>
    [...header(), ...kept.flatMap((s) => [s.heading, ...s.lines]), ''].join('\n');

  const fits = (kept: FingerprintSection[]): boolean =>
    Buffer.byteLength(render(kept), 'utf8') <= maxBytes;

  let kept = [...sections];
  // 1. Drop the least valuable elastic sections, cheapest-first by priority.
  for (const p of ELASTIC_PRIORITIES) {
    if (fits(kept)) return render(kept);
    kept = kept.filter((s) => s.priority !== p);
  }
  if (fits(kept)) return render(kept);

  // 2. Still too big: shorten elastic lines, then NOW lines, one at a time.
  for (const p of [3, 2, 1, 0]) {
    const s = kept.find((x) => x.priority === p);
    while (s && s.lines.length > 1 && !fits(kept)) s.lines.pop();
  }
  return render(kept);
}

function path_label(bank: MemoryBank): string {
  const parts = bank.root.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? 'project';
}