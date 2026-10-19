import path from 'node:path';
import { isDir, isTemplateName, listIfPresent, readIfPresent, type ListResult, type ReadResult } from './project.js';
import { readSections, type CustomSection } from './sections.js';
import { activeGoal, damagedGoals, readGoalBrief } from './goal-store.js';
import type { GoalBrief, GoalRecord } from './goal.js';

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
  /**
   * The contract **headings** this file does not have at all.
   *
   * A real project drifts away from the template, and the old parser degraded silently: `clip`,
   * `research` and `teleport` have no `## Goal` / `## Next action` / `## Blockers` / `## Code state`
   * at all, so their fingerprints lost `project:`, `next:` and `branch:` and a fresh session was told
   * nothing about what to do — while `dump` reported success.
   *
   * Absent, not empty. A freshly scaffolded repository has every heading and no content, which is the
   * normal first state and must stay quiet; a project that rewrote its `CURRENT_TASK.md` into prose has
   * lost the contract and must not.
   */
  missing: string[];
  /** Contract headings that exist but hold nothing yet — the freshly-scaffolded state. */
  empty: string[];
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
   * Extra L2 partitions the project declared in `.ai/sections.json`.
   *
   * Read-only from engram's side: the file is the project's, and this is how a section the tool
   * did not invent still reaches the fingerprint and the rule-file contract.
   */
  sections: CustomSection[];
  /**
   * The project's live goal, when one exists.
   *
   * Loaded with the rest of the bank rather than on demand, because an active goal outranks every
   * other line in the fingerprint: a fresh session that does not know it is the baton holder will
   * start an unrelated task in the middle of someone's twenty-round run.
   */
  goal: { id: string; record: GoalRecord; brief: GoalBrief } | null;
  /** Goal directories present but unreadable — a damaged goal is not an absent one. */
  goalErrors: string[];
  /**
   * Paths that exist but could not be read (EACCES, EMFILE, …).
   * A non-empty list means the bank is *partially* unreadable, not empty — `dump` says so.
   */
  readErrors: string[];
  /**
   * Content problems in project-owned inputs — a malformed `sections.json`, an invalid declared
   * name. These are *not* read failures, and reporting them as "unreadable" (which `dump` did) sent
   * the reader looking for a permissions bug that did not exist.
   */
  warnings: string[];
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
  // Searched over parsed lines, not the raw text: a decision whose first block is a fenced snippet whose
  // opening line is `# install deps` had that line published as its title in BINDING.
  const h1 = contentLines(content).find((l) => !l.inert && l.heading === 1);
  if (h1 === undefined) return fallback;
  const text = (HEADING_RE.exec(h1.text)?.[2] ?? '').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
  return text || fallback;
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
/**
 * The first match of `re` on a line that is **not inert** (not inside a fence or an HTML comment).
 *
 * `titleOf()` was deliberately switched to the inert-aware `contentLines()` because a fenced example was
 * being read as the real heading. The status, severity and `Updated` lookups were left on the raw text, so
 * the same class of bug survived in three more places: a template-shaped example *above* the real header
 * won, because these regexes are `m`-anchored over the whole document and the first match wins.
 */
function firstInertAware(re: RegExp, content: string): RegExpExecArray | null {
  const source = re.source.replace(/^\^/, '^');
  const flags = re.flags.includes('m') ? re.flags : `${re.flags}`;
  for (const line of contentLines(content)) {
    if (line.inert) continue;
    const one = new RegExp(source, flags.replace('g', ''));
    const m = one.exec(line.text);
    if (m) return m;
  }
  return null;
}

export function decisionStatus(content: string): DecisionStatus {
  // The status line, read from the **non-inert** lines only. `STATUS_LINE_RE` over the raw text matched
  // inside fences and HTML comments, so a decision whose body documents the template shape
  // (a fenced `Status: 💭 PROPOSAL`) was published as an open proposal even though its real header said
  // ACCEPTED — dropped from BINDING, and reported by `doctor` as a stale proposal.
  const header = firstInertAware(STATUS_LINE_RE, content)?.[1] ?? '';
  // **No `|| content` fallback.** It re-introduced exactly the bug the header lookup exists to fix: a file
  // with no status line at all was classified from ordinary English prose. Measured: a decision titled
  // "Pick A over B" whose body says "We rejected option B because it was slower" loaded as REJECTED — a
  // tombstone, excluded from BINDING and from the live count — and "This was accepted after review" would
  // have promoted an unratified note into BINDING. A file with no status line is UNKNOWN, which is what
  // `doctor`'s `decisions/unclassified` finding exists to report.
  const scope = header;
  const m =
    /💭\s*PROPOSAL|✅\s*ACCEPTED|🪦\s*(?:REJECTED|SUPERSEDED)|\b(PROPOSAL|ACCEPTED|REJECTED|SUPERSEDED)\b/i.exec(
      scope,
    );
  if (!m?.[0]) return 'UNKNOWN';
  const s = m[0].toUpperCase();
  if (s.includes('PROPOSAL')) return 'PROPOSAL';
  if (s.includes('ACCEPTED')) return 'ACCEPTED';
  // `SUPERSEDED` is a *reason for* the tombstone, not a fourth state: a decision replaced by a later
  // one is retired exactly like a rejected one, and the two must behave identically everywhere that
  // reads a status (never in BINDING, never counted as live). Scanning all seven adopting repositories
  // showed the vocabulary actually in use is `✅ ACCEPTED` / `🪦 REJECTED` / `🪦 SUPERSEDED` /
  // `💭 PROPOSAL` — and the parser recognised only the first three, so this repository's own two
  // `🪦 SUPERSEDED` decisions were classified UNKNOWN and silently vanished from the fingerprint.
  // Found by `engram doctor` reporting them as unclassified.
  return 'REJECTED';
}

/** The pitfall template's own header line: `**Severity:** 🟠 medium · **Date:** …`. */
const SEVERITY_LINE_RE = /^[^\S\n]*\**\s*severity\**\s*:[^\S\n]*(.*)$/im;

/**
 * A pitfall's severity, from its `Severity:` header.
 *
 * `STATUS_LINE_RE` matches `status:`/`state:` **anywhere**, and looking for the emoji only inside that
 * one captured line meant a real pitfall was labelled `unknown`: this repository's own
 * `priority-is-not-render-order.md` has `**Severity:** 🟠 medium` (which that regex does not match —
 * "Severity" is not "status") plus a fenced `state: …` further down (which it does). The consequence is
 * not cosmetic: `SEV_RANK` sorts pitfalls by severity, so a medium pitfall became the first one evicted
 * when the budget trims PITFALLS, and `--json`'s `severity` field was wrong.
 *
 * A whole-document fallback is kept, because a hand-written case file may put the emoji on its title
 * line instead of in a `Severity:` field — the template is a shape, not a requirement.
 */
function severityOf(content: string): PitfallEntry['severity'] {
  // Inert-aware for the header capture (a fenced `Severity: 🟡 low` above the real `**Severity:** 🔴 high`
  // made a high pitfall load as low, which then sorted it first out of the budget). The whole-document
  // fallback stays as-is: it only matches the emoji, so a quoted example in prose cannot reach it.
  const header = firstInertAware(SEVERITY_LINE_RE, content)?.[1] ?? content;
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
    // Fence delimiters and fence *body* are literal text: a fenced example that quotes an HTML comment
    // opener (this repository's own docs quote `<!-- engram:contract:start` to talk about it) must not
    // start a real comment. That was a state nothing could leave — `opensComment` suppressed `marker`,
    // so the closing fence was never recognised, `fence` stayed set forever, and every later line became
    // inert. Measured: a CURRENT_TASK.md with a fence containing `<!-- engram:contract:start` lost its
    // `## Next action` heading entirely; `doctor` reported the heading MISSING although it was present,
    // and the digest silently dropped `next:`.
    const inFenceBody = fence !== null && !isDelimiter;
    const opensComment = !isDelimiter && !inFenceBody && !inComment && line.includes('<!--');
    const inert = inFence || inComment || isDelimiter || opensComment;

    if (fence !== null) {
      if (isDelimiter && marker[0] === fence.char && marker.length >= fence.len) fence = null;
    } else if (isDelimiter) {
      fence = { char: marker[0]!, len: marker.length };
    }

    if (!isDelimiter && !inFenceBody) {
      // One line can both open and close a comment (`<!-- ... -->`), and the old state machine set
      // `inComment = true` without ever checking the same line for the closer — so everything after a
      // **single-line** comment was treated as comment body and silently disappeared. Measured: the
      // `CURRENT_TASK` template opens with exactly such a line, which made every `## Goal` heading in
      // every scaffolded repository invisible to the parser. Strip the closed spans first, then decide
      // from what is left.
      const withoutSpans = line.replace(/<!--[\s\S]*?-->/g, '');
      if (!inComment && withoutSpans.includes('<!--')) inComment = true;
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
 * A blocker line that the project already marked as dealt with.
 *
 * Real files keep the history in place instead of deleting it — `chime` had
 * `- ~~微信会话失效~~ ✅ 2026-10-18 16:15 已由用户 poke 解决`, which `dump` published as a live blocker in
 * every fresh session's fingerprint. Strikethrough is the writer's own signal that the line is history,
 * so it is honoured rather than stripped: a resolved blocker must not compete for the three slots that
 * real blockers need.
 */
const RESOLVED_BLOCKER = /^(~~.+?~~|✅|✔|\[x\])\s*/i;

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
      if (joined && !RESOLVED_BLOCKER.test(joined)) out.push(joined);
      continue;
    }
    // Strikethrough is checked on the *raw* line: `cleanInline` strips markdown emphasis, so testing
    // after cleaning would have thrown away the very marker that says "this one is done". The bullet
    // marker is stripped first, because a real line reads `- ~~thing~~ ✅ done` and an anchored test
    // against the raw line never matches.
    if (RESOLVED_BLOCKER.test(raw.trim().replace(/^[-*+]\s+/, ''))) continue;
    const line = stripBullet(cleanInline(raw));
    if (!line || /^none\b/i.test(line)) continue;
    out.push(line);
  }
  return out.slice(0, 3);
}

export function parseCurrentTask(content: string): CurrentTask {
  // Both read from non-inert lines. A `**Status:**` or `Updated:` shown *inside a fence* — which every
  // project's own docs do when they document the template — used to win over the real header above it,
  // because these were scanned over the raw text and the first match takes the file.
  const status = cleanInline(firstInertAware(STATUS_LINE_RE, content)?.[1] ?? '').split(/\s+·\s+/)[0] ?? '';
  const updatedM = firstInertAware(/\*{0,2}Updated\*{0,2}\s*:?\s*([^\n]+)/i, content);
  const blockers = extractBlockers(section(content, 'Blockers'));
  const task: Omit<CurrentTask, 'missing' | 'empty'> = {
    status: cleanInline(status),
    updated: cleanInline(updatedM?.[1] ?? ''),
    goal: paragraph(section(content, 'Goal')),
    nextAction: paragraph(section(content, 'Next action')),
    codeState: paragraph(section(content, 'Code state')),
    blockers,
    raw: content,
  };
  const headings = headingTitles(content);
  return { ...task, ...contractGaps(task, headings) };
}

/** Every heading title in the file, lowercased and stripped of decoration, for absence checks. */
function headingTitles(content: string): string[] {
  return contentLines(content)
    .filter((l) => !l.inert && l.heading !== null)
    .map((l) =>
      (HEADING_RE.exec(l.text)?.[2] ?? '')
        .toLowerCase()
        .split(/[:—–]/)[0]
        ?.trim()
        .replace(/[.!?]+$/, '') ?? '',
    );
}

/**
 * Which contract fields are absent, and which are present but empty.
 *
 * The two are different diagnoses and deserve different reports:
 *
 * - **absent** — the heading was never written, so the project is not following the contract, and a
 *   fresh session gets no `project:` / `next:` line at all. `clip`, `research` and `teleport` are all in
 *   this state.
 * - **empty** — every heading is there and holds nothing yet. That is what `init` produces, so it must be
 *   silent in the fingerprint; otherwise every newly scaffolded repository would open with a warning
 *   about work it has not done.
 *
 * `Blockers` is checked for neither: an empty blocker list is a legitimate, common state, and
 * `Status`/`Updated` are treated as the header line rather than as sections.
 */
function contractGaps(
  task: Omit<CurrentTask, 'missing' | 'empty'>,
  headings: string[],
): Pick<CurrentTask, 'missing' | 'empty'> {
  const fields: Array<[string, string]> = [
    ['Goal', task.goal],
    ['Next action', task.nextAction],
    ['Code state', task.codeState],
  ];
  const missing: string[] = [];
  const empty: string[] = [];
  for (const [name, value] of fields) {
    if (!headings.includes(name.toLowerCase())) missing.push(name);
    else if (!value) empty.push(name);
  }
  return { missing, empty };
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
      sections: [],
      goal: null,
      goalErrors: [],
      readErrors: errors,
      warnings: [],
    };
  }

  const currentRead = await readIfPresent(path.join(dir, 'CURRENT_TASK.md'));
  if (currentRead.error) errors.push(currentRead.error);
  const decisions = await readEntries(path.join(dir, 'decisions'));
  const sessions = await readEntries(path.join(dir, 'sessions'));
  const runbooks = await readEntries(path.join(dir, 'runbooks'));
  const pitfalls = await readEntries(path.join(dir, 'pitfalls', 'cases'));
  const skills = await listIfPresent(path.join(dir, 'skills'));
  const declared = await readSections(root);
  const live = await activeGoal(root);
  const goal = live === null ? null : { ...live, brief: await readGoalBrief(root, live.id) };
  const goalErrors = await damagedGoals(root);

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
    sections: declared.sections,
    goal,
    goalErrors,
    readErrors: [...errors, ...decisions.errors, ...sessions.errors, ...runbooks.errors, ...pitfalls.errors, ...(skills.error ? [skills.error] : [])],
    warnings: declared.warnings,
  };
}
// ---------------------------------------------------------------- the one mechanical fix

export interface CompactResult {
  /** `CURRENT_TASK.md` with completed milestones replaced by a pointer. Byte-identical when there is nothing to move. */
  currentTask: string;
  /** The lines that belong in the archive, in order, or `[]`. */
  moved: string[];
  /** How many `- [x]` entries were found (each may span several lines). */
  movedCount: number;
}

/**
 * Move completed milestones out of `CURRENT_TASK.md`, mechanically.
 *
 * This is the *only* rewrite `engram` performs on a project's own prose, and it is deliberately the
 * narrowest one that solves a measured problem: the file is read on every session start, and every
 * repository that used the bank let it grow (144–537 lines against a ~60-line guidance) because
 * appending a `- [x]` is free and deleting it feels like losing history.
 *
 * Three properties make it safe enough to be a command rather than advice:
 *
 * - **Nothing is deleted.** The lines leave this file and arrive in the archive verbatim — the reasoning
 *   in a completed milestone is exactly what a later reader wants when asking "did we already try that?".
 * - **Only checked items move.** `- [x]` and its indented continuation lines. Prose, open items, headings
 *   and tables are untouched, because a machine cannot tell which parts of a project's own summary are
 *   still load-bearing.
 * - **A placeholder is not a milestone.** The scaffold ships `- [x] …` as an example of the shape, and
 *   moving it would put a template's ellipsis in the archive and leave the next reader believing one
 *   milestone was completed. An item whose text is only an ellipsis is skipped.
 * - **Idempotent.** Running it twice changes nothing the second time: the items are already gone and the
 *   pointer is already there.
 */
export function compactCurrentTask(content: string): CompactResult {
  const lines = content.split('\n');
  // Inert lines are skipped for the same reason every other parser here skips them: a checked box inside
  // a fenced example or a multi-line HTML comment is documentation, not a milestone — moving it put an
  // example in the archive and made `doctor` report a completed milestone that never existed.
  const inert = new Set(contentLines(content).flatMap((l, i) => (l.inert ? [i] : [])));
  const moved: string[] = [];
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (inert.has(i) || !/^- \[[xX]\]\s/.test(line) || isPlaceholder(line)) {
      kept.push(line);
      continue;
    }
    // The item and every following line more indented than the bullet: a wrapped checkbox is one entry,
    // and splitting it would put half a sentence in each file.
    moved.push(line);
    while (i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1] ?? '')) {
      i += 1;
      moved.push(lines[i] ?? '');
    }
  }

  if (moved.length === 0) return { currentTask: content, moved: [], movedCount: 0 };

  const movedCount = moved.filter((l) => /^- \[[xX]\]/.test(l)).length;
  // The count **accumulates**. Replacing it with this run's number made a file whose pointer said `2`
  // claim `1` after one more milestone was added, while the archive held three.
  const existingPointer = content.split('\n').find((l) => l.startsWith(POINTER_PREFIX));
  const alreadyArchived = Number(/^(\d+)/.exec(existingPointer?.slice(POINTER_PREFIX.length) ?? '')?.[1] ?? 0);
  const total = Number.isFinite(alreadyArchived) ? alreadyArchived + movedCount : movedCount;
  const pointer = `${POINTER_PREFIX}${total} completed milestone(s) archived in ${ARCHIVE_PATH} — read it before asking "did we already try that?"_`;

  // The pointer goes at the **end of the `## Checklist` section**, which is where the entries came from.
  // Placing it before the next heading of any name put it above `## Goal` — the first thing a reader sees
  // would have been a note about history.
  const out = collapseBlankRunsIn(kept, 'Checklist');
  if (out.some((l) => l.startsWith(POINTER_PREFIX))) {
    // A previous run already left a pointer: update its count rather than adding a second one.
    return {
      currentTask: out.map((l) => (l.startsWith(POINTER_PREFIX) ? pointer : l)).join('\n'),
      moved,
      movedCount,
    };
  }
  const at = endOfChecklistSection(out);
  out.splice(at, 0, ...(out[at - 1]?.trim() === '' ? [] : ['']), pointer);
  return { currentTask: out.join('\n'), moved, movedCount };
}

/**
 * Whether a checkbox line is the scaffold's example rather than a real entry.
 *
 * `- [x] …` exists in the shipped template to show the shape. It is not history, and treating it as
 * history put an ellipsis in the archive and told the next reader a milestone had been completed.
 */
function isPlaceholder(line: string): boolean {
  const text = line.replace(/^- \[[xX]\]\s*/, '').trim();
  return text === '' || /^[….…]+$/.test(text);
}

/** Index of the first blank line at or after the last real line of `## Checklist`, else `out.length`. */
function endOfChecklistSection(lines: string[]): number {
  const start = lines.findIndex((l) => /^##\s+Checklist/i.test(l));
  if (start < 0) return lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? '')) {
      // Walk back over the blank lines the section already ended with.
      let at = i;
      while (at > start && (lines[at - 1] ?? '').trim() === '') at -= 1;
      return at;
    }
  }
  return lines.length;
}

/**
 * Collapse runs of blank lines to one **inside one section only**.
 *
 * Whole-file collapsing rewrote content it was not asked to touch — two consecutive blank lines inside a
 * fenced block in `CURRENT_TASK.md` were silently merged by the first `--fix`. The removals happen in
 * `## Checklist`, so the tidy-up is scoped there.
 */
function collapseBlankRunsIn(lines: string[], sectionName: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${sectionName}\\b`, 'i').test(l));
  if (start < 0) return lines;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  const out: string[] = [];
  let prevBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const blank = line.trim() === '' && i > start && i < end;
    if (blank && prevBlank) continue;
    prevBlank = blank;
    out.push(line);
  }
  return out;
}

/** Marks the generated pointer so a second run recognises it and does not add another. */
export const POINTER_PREFIX = '_Completed milestones: ';
/** The file `compactCurrentTask` moves entries into. Named with `_` so it stays out of the fingerprint's RECENT block. */
export const ARCHIVE_PATH = '`.ai/sessions/_milestone-log-archive.md`';
