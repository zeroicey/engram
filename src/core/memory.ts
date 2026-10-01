import path from 'node:path';
import { isDir, isTemplateName, listIfPresent, readIfPresent, type ListResult, type ReadResult } from './project.js';

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
  codeState: string;
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
  /**
   * Paths that exist but could not be read (EACCES, EMFILE, …).
   * A non-empty list means the bank is *partially* unreadable, not empty — `dump` says so.
   */
  readErrors: string[];
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})-(.+?)(\.md|-handoff\.md)$/;

/** A heading of any level, so a `####` subsection correctly ends a `##` section. */
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;

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

const STATUS_LINE_RE = /^[^\S\n]*\**[^\S\n]*(?:status|state)\**[^\S\n]*:[^\S\n]*(.*)$/im;

/**
 * Read the status from its *header line*, not from the leftmost emoji token in the file.
 *
 * The old version scanned the whole document, so a ratified decision whose Context mentioned
 * "originally filed as 💭 PROPOSAL" was reported as an open proposal — the BINDING section of the
 * fingerprint, its most consequential output, silently wrong.
 *
 * Exported so `/audit` and tests can check a decision without loading the whole bank.
 */
export function decisionStatus(content: string): DecisionStatus {
  const header = STATUS_LINE_RE.exec(content)?.[1] ?? '';
  const scope = header || content;
  const m = /💭\s*PROPOSAL|✅\s*ACCEPTED|🪦\s*REJECTED|\b(PROPOSAL|ACCEPTED|REJECTED)\b/i.exec(scope);
  if (!m?.[0]) return 'UNKNOWN';
  const s = m[0].toUpperCase();
  if (s.includes('PROPOSAL')) return 'PROPOSAL';
  if (s.includes('ACCEPTED')) return 'ACCEPTED';
  return 'REJECTED';
}

function severityOf(content: string): PitfallEntry['severity'] {
  const header = STATUS_LINE_RE.exec(content)?.[1] ?? content;
  const m = /🔴\s*high|🟠\s*medium|🟡\s*low/i.exec(header);
  if (!m?.[0]) return 'unknown';
  if (/high/i.test(m[0])) return 'high';
  if (/medium/i.test(m[0])) return 'medium';
  return 'low';
}

const byDateDesc = (a: MemoryEntry, b: MemoryEntry): number =>
  b.date.localeCompare(a.date) || b.file.localeCompare(a.file);

/** One source line, flagged when it is inert (inside a code fence or an HTML comment). */
interface ContentLine {
  text: string;
  heading: number | null;
  inert: boolean;
}

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Parse lines, flagging the inert ones.
 *
 * Tracking HTML-comment **state** (not just a line starting with `<!--`) is what fixes the shipped
 * bug: `aiCurrentTask()`'s placeholders are multi-line comments, so their continuation lines used
 * to survive into the fingerprint and every fresh `init` reported the template's own prose as the
 * project's goal, branch, next action and blocker.
 */
function contentLines(content: string): ContentLine[] {
  const out: ContentLine[] = [];
  let fence: { char: string; len: number } | null = null;
  let inComment = false;

  for (const raw of content.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw; // CRLF
    const marker = inComment ? undefined : FENCE_RE.exec(line)?.[1];
    const isDelimiter = marker !== undefined;
    const inFence = fence !== null || isDelimiter;
    // A comment *opener* marks its own line inert too: the template's placeholder prose starts
    // with `<!--` on that line, and it was surfacing as the project's goal and next action.
    const opensComment = !isDelimiter && !inComment && line.includes('<!--');
    const inert = inFence || inComment || isDelimiter || opensComment;

    if (fence !== null) {
      if (isDelimiter && marker[0] === fence.char && marker.length >= fence.len) fence = null;
    } else if (isDelimiter) {
      fence = { char: marker[0]!, len: marker.length };
    }

    if (!isDelimiter) {
      if (!inComment && line.includes('<!--')) inComment = true;
      else if (inComment && line.includes('-->')) inComment = false;
    }

    const headingMatch = inert ? null : HEADING_RE.exec(line);
    out.push({
      text: line,
      heading: headingMatch ? (headingMatch[1] ?? '').length : null,
      inert,
    });
  }
  return out;
}

/**
 * Body lines of a `## Heading`, tolerant of decoration (`## Goal:`, `### Goal`, `## Goal — x`)
 * and terminated by *any* heading level, including `####`.
 *
 * Returns lines with comments, blanks, rules and table separators removed.
 */
function section(content: string, heading: string): string[] {
  const wanted = heading.replace(/^#+\s*/, '').toLowerCase();
  const lines = contentLines(content);
  let inSection = false;
  const base: number[] = [];
  const out: string[] = [];

  for (const line of lines) {
    if (line.inert) continue;
    if (line.heading !== null) {
      const level = line.heading;
      const title = (HEADING_RE.exec(line.text)?.[2] ?? '')
        .toLowerCase()
        .split(/[:—–]/)[0]
        ?.trim()
        .replace(/[.!?]+$/, '');
      if (!inSection && title === wanted) {
        inSection = true;
        base.push(level);
        continue;
      }
      // Any heading ends the section, including a `####` subsection: its bullets are the
      // subsection's content, not the parent's. Continuing past it leaked "escalated yesterday"
      // into the blockers list and evicted real blockers via the 3-item cap.
      if (inSection) break;
      continue;
    }
    if (!inSection) continue;
    const t = line.text.trim();
    if (!t || /^-{3,}$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

const cleanInline = (s: string): string =>
  s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const stripBullet = (l: string): string =>
  l.replace(/^[-*+]\s+/, '').replace(/^(\[[ xX]\]|✔|✗)\s*/, '').trim();

/** Join the first paragraph of a section, so an 80-column wrapped goal is not cut mid-sentence. */
function paragraph(lines: string[]): string {
  const out: string[] = [];
  for (const raw of lines) {
    const line = stripBullet(cleanInline(raw));
    if (!line) continue;
    if (line.startsWith('|')) break; // a table, not prose
    out.push(line);
    if (out.length > 1 && /[.!?:]$/.test(line)) break;
  }
  return out.join(' ');
}

/**
 * Blockers, from either bullets or a Markdown table.
 *
 * The shipped template used a table while the parser skipped table rows, which made `blocked:`
 * a permanently dead field for every scaffolded repository. Both shapes are now supported, and
 * the template emits bullets so the common path stays unambiguous.
 */
function extractBlockers(lines: string[]): string[] {
  const out: string[] = [];
  let seenHeader = false;
  for (const raw of lines) {
    if (raw.startsWith('|')) {
      const cells = raw
        .split('|')
        .slice(1, -1)
        .map((c) => cleanInline(c));
      if (cells.length === 0) continue;
      // A separator row (`| --- | --- |`) is not a blocker. Check the cells, not the joined
      // string: joining first yields "--- — ---", which no character-class test can match.
      if (cells.every((c) => /^[-:]+$/.test(c))) continue;
      if (!seenHeader) {
        seenHeader = true;
        continue; // column headers are not blockers
      }
      const joined = cells.filter(Boolean).join(' — ');
      if (joined) out.push(joined);
      continue;
    }
    const line = stripBullet(cleanInline(raw));
    if (!line || /^none\b/i.test(line)) continue;
    out.push(line);
  }
  return out.slice(0, 3);
}

export function parseCurrentTask(content: string): CurrentTask {
  const headerLine = content.split('\n').find((l) => STATUS_LINE_RE.test(l)) ?? '';
  const status = cleanInline(STATUS_LINE_RE.exec(headerLine)?.[1] ?? '').split(/\s+·\s+/)[0] ?? '';
  const updatedM = /\*{0,2}Updated\*{0,2}\s*:?\s*([^\n]+)/i.exec(content);
  const blockers = extractBlockers(section(content, 'Blockers'));
  return {
    status: cleanInline(status),
    updated: cleanInline(updatedM?.[1] ?? ''),
    goal: paragraph(section(content, 'Goal')),
    nextAction: paragraph(section(content, 'Next action')),
    codeState: paragraph(section(content, 'Code state')),
    blockers,
    raw: content,
  };
}

interface LoadedEntries {
  entries: Array<MemoryEntry & { content: string }>;
  errors: string[];
}

async function readEntries(dir: string): Promise<LoadedEntries> {
  const listing: ListResult = await listIfPresent(dir);
  const names = listing.names.filter((f) => f.endsWith('.md') && !isTemplateName(f));
  const out: Array<MemoryEntry & { content: string }> = [];
  const errors: string[] = listing.error ? [listing.error] : [];
  for (const file of names) {
    const read: ReadResult = await readIfPresent(path.join(dir, file));
    if (read.error) errors.push(read.error);
    const content = read.text ?? '';
    const { date, topic } = baseName(file);
    out.push({ file, date, topic, title: titleOf(content, topic), content });
  }
  return { entries: out, errors };
}

const SEV_RANK: Record<PitfallEntry['severity'], number> = { high: 0, medium: 1, low: 2, unknown: 3 };

export async function loadMemory(root: string): Promise<MemoryBank> {
  const dir = path.join(root, '.ai');
  const errors: string[] = [];
  const exists = await isDir(dir);

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
      readErrors: errors,
    };
  }

  const currentRead = await readIfPresent(path.join(dir, 'CURRENT_TASK.md'));
  if (currentRead.error) errors.push(currentRead.error);
  const decisions = await readEntries(path.join(dir, 'decisions'));
  const sessions = await readEntries(path.join(dir, 'sessions'));
  const runbooks = await readEntries(path.join(dir, 'runbooks'));
  const pitfalls = await readEntries(path.join(dir, 'pitfalls', 'cases'));
  const skills = await listIfPresent(path.join(dir, 'skills'));

  return {
    root,
    dir,
    exists: true,
    currentTask: currentRead.text ? parseCurrentTask(currentRead.text) : null,
    decisions: decisions.entries
      .map((e) => ({ ...e, status: decisionStatus(e.content) }))
      .sort(byDateDesc),
    sessions: sessions.entries.sort(byDateDesc),
    pitfalls: pitfalls.entries
      .map((e) => ({ ...e, severity: severityOf(e.content) }))
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || byDateDesc(a, b)),
    runbooks: runbooks.entries.sort(byDateDesc),
    skills: skills.names.filter((f) => f.endsWith('.md') && !isTemplateName(f)),
    readErrors: [...errors, ...decisions.errors, ...sessions.errors, ...runbooks.errors, ...pitfalls.errors, ...(skills.error ? [skills.error] : [])],
  };
}