import path from 'node:path';
import { isTemplateName, listFiles, pathExists, readFileSafe } from './project.js';

export type DecisionStatus = 'PROPOSAL' | 'ACCEPTED' | 'REJECTED' | 'UNKNOWN';

export interface MemoryEntry {
  /** File name, e.g. `2026-01-02-retry-backoff.md`. */
  file: string;
  /** ISO date parsed from the file name, `''` when absent. */
  date: string;
  /** Kebab topic from the file name, `''` when absent. */
  topic: string;
  /** First H1, cleaned of markdown decoration. */
  title: string;
}

export interface DecisionEntry extends MemoryEntry {
  status: DecisionStatus;
}

export interface PitfallEntry extends MemoryEntry {
  severity: 'high' | 'medium' | 'low' | 'unknown';
}

export interface CurrentTask {
  status: string;
  updated: string;
  goal: string;
  nextAction: string;
  blockers: string[];
  /** Raw markdown of the file, for audits. */
  raw: string;
}

export interface MemoryBank {
  root: string;
  dir: string;
  exists: boolean;
  currentTask: CurrentTask | null;
  decisions: DecisionEntry[];
  sessions: MemoryEntry[];
  pitfalls: PitfallEntry[];
  runbooks: MemoryEntry[];
  /** Names of `.ai/skills/*.md`. */
  skills: string[];
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})-(.+?)(\.md|-handoff\.md)$/;

function baseName(file: string): { date: string; topic: string } {
  const m = DATE_RE.exec(file);
  if (!m) return { date: '', topic: file.replace(/\.md$/, '') };
  const topic = (m[2] ?? '').replace(/-handoff$/, '');
  return { date: m[1] ?? '', topic };
}

function titleOf(content: string, fallback: string): string {
  const h1 = /^#\s+(.+)$/m.exec(content);
  if (!h1?.[1]) return fallback;
  return h1[1].replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

function decisionStatus(content: string): DecisionStatus {
  const m = /💭\s*PROPOSAL|✅\s*ACCEPTED|🪦\s*REJECTED/.exec(content);
  if (!m?.[0]) return 'UNKNOWN';
  const s = m[0];
  if (s.includes('PROPOSAL')) return 'PROPOSAL';
  if (s.includes('ACCEPTED')) return 'ACCEPTED';
  return 'REJECTED';
}

function severityOf(content: string): PitfallEntry['severity'] {
  const m = /🔴\s*high|🟠\s*medium|🟡\s*low/i.exec(content);
  if (!m?.[0]) return 'unknown';
  if (/high/i.test(m[0])) return 'high';
  if (/medium/i.test(m[0])) return 'medium';
  return 'low';
}

const byDateDesc = (a: MemoryEntry, b: MemoryEntry): number =>
  b.date.localeCompare(a.date) || b.file.localeCompare(a.file);

async function readEntries(dir: string): Promise<Array<MemoryEntry & { content: string }>> {
  const files = (await listFiles(dir)).filter((f) => f.endsWith('.md') && !isTemplateName(f));
  const out: Array<MemoryEntry & { content: string }> = [];
  for (const file of files) {
    const content = (await readFileSafe(path.join(dir, file))) ?? '';
    const { date, topic } = baseName(file);
    out.push({ file, date, topic, title: titleOf(content, topic), content });
  }
  return out;
}

function section(content: string, heading: string): string[] {
  const lines = content.split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (start === -1) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^#{1,3}\s/.test(line)) break;
    const t = line.trim();
    if (!t || t.startsWith('<!--')) continue;
    if (t.startsWith('|') || /^-{3,}$/.test(t)) continue; // tables and rules carry no field data
    out.push(t.replace(/^-\s*\[[ xX]\]\s*/, '').replace(/^[-*]\s*/, '').replace(/^>\s*/, ''));
  }
  return out;
}

const cleanInline = (s: string): string =>
  s
    .replace(/<!--.*?-->/g, '')
    .replace(/\*\*/g, '')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export function parseCurrentTask(content: string): CurrentTask {
  const statusM = /\*{0,2}Status\*{0,2}\s*:?\s*([^\n·]+)/i.exec(content);
  const updatedM = /\*{0,2}Updated\*{0,2}\s*:?\s*([^\n]+)/i.exec(content);
  const goal = cleanInline(section(content, '## Goal')[0] ?? '');
  const nextAction = cleanInline(section(content, '## Next action')[0] ?? '');
  const blockers = section(content, '## Blockers')
    .map(cleanInline)
    .filter((l) => l && l.toLowerCase() !== 'none' && !/^todo$/i.test(l) && !/^<!--/.test(l))
    .slice(0, 3);
  return {
    status: cleanInline(statusM?.[1] ?? ''),
    updated: cleanInline(updatedM?.[1] ?? ''),
    goal,
    nextAction,
    blockers,
    raw: content,
  };
}

export async function loadMemory(root: string): Promise<MemoryBank> {
  const dir = path.join(root, '.ai');
  const exists = await pathExists(dir);
  if (!exists) {
    return {
      root,
      dir,
      exists: false,
      currentTask: null,
      decisions: [],
      sessions: [],
      pitfalls: [],
      runbooks: [],
      skills: [],
    };
  }

  const currentRaw = await readFileSafe(path.join(dir, 'CURRENT_TASK.md'));
  const decisionRaw = await readEntries(path.join(dir, 'decisions'));
  const sessionRaw = await readEntries(path.join(dir, 'sessions'));
  const runbookRaw = await readEntries(path.join(dir, 'runbooks'));
  const pitfallRaw = await readEntries(path.join(dir, 'pitfalls', 'cases'));

  const sevRank: Record<PitfallEntry['severity'], number> = { high: 0, medium: 1, low: 2, unknown: 3 };

  return {
    root,
    dir,
    exists: true,
    currentTask: currentRaw ? parseCurrentTask(currentRaw) : null,
    decisions: decisionRaw
      .map((e) => ({ ...e, status: decisionStatus(e.content) }))
      .sort(byDateDesc),
    sessions: sessionRaw.sort(byDateDesc),
    pitfalls: pitfallRaw
      .map((e) => ({ ...e, severity: severityOf(e.content) }))
      .sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || byDateDesc(a, b)),
    runbooks: runbookRaw.sort(byDateDesc),
    skills: (await listFiles(path.join(dir, 'skills'))).filter((f) => f.endsWith('.md') && !isTemplateName(f)),
  };
}