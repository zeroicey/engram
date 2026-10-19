import { CANONICAL_SKILL_NAMES, skillCommandList } from './canon.js';
import { sectionTarget } from './sections.js';
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
  /**
   * Bank paths that exist but could not be read.
   *
   * Carried into the fingerprint because the artefact is the thing that gets pasted into a session, and
   * its reader never sees stderr. Without it, an unreadable `.ai/decisions/` rendered as "a project with
   * no binding decisions" in the pasted digest *and* in `--json`, so `--out fp.json` and the `/audit`
   * consumer both saw a complete-looking document.
   */
  readErrors?: string[];
}
export interface Fingerprint {
  markdown: string;
  bytes: number;
  truncated: boolean;
  /**
   * What was left out to fit the budget, named.
   *
   * `truncated: true` was the only signal, and it is useless to a reader: it says *something* was
   * dropped without saying what, so the fix ("write less into CURRENT_TASK", "fewer decisions", "the
   * budget is too small for this project") cannot be chosen. Several of the seven adopting repositories
   * render within 12 bytes of the ceiling, so this is not hypothetical — it is the next thing to break.
   */
  dropped: Dropped[];
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
    /**
     * How many pitfall cases the bank holds, vs how many `pitfalls` above could be shown.
     *
     * Without it a JSON consumer saw a two-element array and had no way to learn that nine more
     * existed — the same "silently partial" state the markdown's `omitted:` notice exists to prevent,
     * one output channel over.
     */
    pitfallsTotal: number;
    skills: string[];
    /** The live goal, when the project has one. Distinct from `goal`, which is CURRENT_TASK's prose. */
    activeGoal: {
      id: string;
      status: string;
      text: string;
      verdict: string;
      blocked: string | null;
      waitingUntil: string | null;
    } | null;
    bytes: number;
    truncated: boolean;
    dropped: Dropped[];
    /** Bank paths that could not be read; non-empty means the document above is partial. */
    readErrors: string[];
  };
}

/**
 * One thing the budget took, and how much of it.
 *
 * `lines` distinguishes "the whole block is gone" (0) from "two of its three lines are gone" (2), because
 * the two have different fixes: a dropped block means the project writes too much of that *kind* of
 * content, a shortened block means one entry is too long.
 */
export interface Dropped {
  /** The section heading, or `NOW` / `POINTERS` for the two that are never fully dropped. */
  section: string;
  /** How many lines of it did not fit. `0` means the whole section was dropped. */
  lines: number;
  /** `dropped` when the block is gone, `shortened` when only some of its lines are. */
  how: 'dropped' | 'shortened';
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
  // `Math.max(0, …)`, not `1`: the old floor made `trimTo('abcd', 2)` return `'a…'` — four bytes for a
  // two-byte budget. Not reachable from `dump` (every call site passes ≥ 60), but the helper is exported
  // and directly asserted, so its own contract has to hold.
  const marker = Buffer.byteLength('…', 'utf8');
  if (maxBytes <= marker) return '';
  const limit = maxBytes - marker;
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
  /**
   * Omitted for a *continuation*: lines appended to the block above without a heading of their own.
   * Declared sections use this so the extra line can be dropped on a tight budget without leaving a
   * dangling heading behind.
   */
  heading?: string;
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
  // Named second, for the same reason as `missing:` below: a tightening budget shortens NOW from the
  // tail, and a warning that the digest is *partial* must not be the first thing evicted.
  if (opts.readErrors?.length) {
    now.push(line('unreadable', `${opts.readErrors.length} path(s) — the rest of this digest is partial`, 100));
  }
  // Say what is absent, instead of rendering a thinner digest that looks complete.
  //
  // Three of the seven repositories that adopted the bank have no `## Goal` / `## Next action` /
  // `## Code state` at all, so their fingerprints quietly lost `project:`, `next:` and `branch:` — and
  // `dump` reported success. A fresh session in `research` opened the fingerprint and saw decisions but
  // **zero bytes of NOW**: the file that exists to say "what am I doing" said nothing, and nothing said
  // so. One line naming the fields the reader is missing.
  //
  // Placed second, not last, because a tightening budget shortens NOW from the *tail*: a warning about
  // the digest's own incompleteness must not be the first thing evicted. `state:` and this line are the
  // two "meta" lines; everything after them is content whose absence is already visible.
  // Absent headings only: an `init`-fresh repository has every heading and no content, which is normal
  // and quiet. A project that rewrote `CURRENT_TASK.md` into prose has lost the contract, and a reader
  // must be told rather than handed a thinner digest that looks complete.
  // Compressed on purpose: the field names are the information, the file is obvious from the pointer
  // line, and this line is competing for bytes with the content it is warning about.
  if (t && t.missing.length) now.push(line('missing', `CURRENT_TASK has no ${t.missing.join(' / ')} heading`, 110));
  // Headings present, nothing in them: `init` ran and nobody ever wrote state. Two of the seven
  // repositories that adopted the bank are in exactly this state (byte-identical templates, one of them
  // untouched for 16 days) and their fingerprints were indistinguishable from a project mid-flight —
  // same shape, same silence, 314 bytes. This is a different diagnosis from `missing:`: the file obeys
  // the contract and is simply unfilled.
  if (t && !t.missing.length && t.empty.length === 3) {
    now.push(line('empty', 'no Goal / Next action / Code state recorded yet', 100));
  }
  // `project:` and not `goal:`, because the goal engine added a second thing that is called a goal —
  // `.ai/goal/<id>/BRIEF.md`, rendered as the GOAL block below. Two lines labelled `goal` in one
  // 1400-byte fingerprint is a fresh session being told there are two tasks and not which one to work
  // on. The distinction is real and worth the byte: `project:` is where the **repository** stands
  // (durable, human-owned), the GOAL block is the **current run** (bounded, and judged by `done_when`).
  if (t?.goal) now.push(line('project', t.goal, 120));
  if (t?.codeState) now.push(line('branch', t.codeState, 110));
  if (t?.nextAction) now.push(line('next', t.nextAction, 120));
  for (const b of t?.blockers ?? []) now.push(line('blocked', b, 100));
  if (now.length) sections.push({ heading: 'NOW', lines: now, priority: 0 });

  const decisionLines = [
    ...proposals.map((d) => `  ${MARK.PROPOSAL} ${d.date} ${trimTo(d.title, 70)} [proposal: needs verdict]`),
    ...accepted.map((d) => `  ${MARK.ACCEPTED} ${d.date} ${trimTo(d.title, 70)}`),
  ];

  // The live goal outranks everything but NOW. A fresh session that does not learn it is the baton
  // holder will start an unrelated task in the middle of someone's twenty-round run, and a parked
  // goal in `waiting` is indistinguishable from an abandoned one without its deadline.
  const goal = bank.goal;
  if (goal) {
    const g = goal.record;
    const goalLines = [
      `  id: ${g.id} · ${g.status}${g.closedAt ? ` (${g.closeReason})` : ''} · ${g.rounds} rounds`,
      `  run: ${trimTo(g.goal, 100)}`,
    ];
    if (g.blocker) goalLines.push(`  blocked: ${trimTo(`${g.blocker.reason}${g.blocker.needs ? ` — needs ${g.blocker.needs}` : ''}`, 80)}`);
    if (g.wake) goalLines.push(`  waiting since ${g.wake.requestedAt} · deadline ${g.wake.deadlineAt}`);
    if (goal.brief.error) goalLines.push(`  verdict: ⚠ ${trimTo(goal.brief.error, 90)}`);
    else if (goal.brief.doneWhen === null) goalLines.push('  verdict: not declared — classify before working');
    else goalLines.push(`  verdict: ${trimTo(describeVerdict(goal.brief.doneWhen), 90)}`);
    // Pushed before BINDING: the render order is the priority order, and an active goal is the one
    // thing a fresh session must not miss. A 0.5 priority alone would not do it — `fitToBudget` drops
    // whole tiers when the budget is tight, and a `sections.push` after BINDING would have rendered
    // the goal *below* the decisions it outranks.
    sections.push({ heading: 'GOAL', lines: goalLines, priority: 0.5 });
  }

  if (decisionLines.length) sections.push({ heading: 'BINDING', lines: decisionLines, priority: 1 });

  if (sessions.length) {
    sections.push({
      heading: 'RECENT',
      lines: sessions.map((s) => `  ${s.date} ${trimTo(s.title, 78)} → .ai/sessions/${s.file}`),
      priority: 2,
    });
  }

  if (pitfalls.length) {
    const lines = pitfalls.map((p) => `  ⚠ ${trimTo(p.title, 70)} → .ai/pitfalls/cases/${p.file}`);
    // Name what the CAP left out, exactly as the budget path names what the budget left out.
    //
    // `pitfallN` defaults to 2, so a bank with eleven cases rendered two lines and said nothing about
    // the other nine — the artefact read exactly like a project that has two pitfalls. That is the
    // single failure the `omitted:` notice exists to prevent, and it was guarded only on the byte
    // path: a *count* limit is the same loss with a different cause. Measured: a 13-decision,
    // 11-pitfall bank rendered `PITFALLS` with 2 lines, no notice, and `--json` reporting
    // `pitfalls: 2` — both agreeing on a number that was wrong.
    if (bank.pitfalls.length > pitfalls.length) {
      lines.push(`  … ${bank.pitfalls.length - pitfalls.length} more — .ai/pitfalls/cases/`);
    }
    sections.push({ heading: 'PITFALLS', lines, priority: 3 });
  }

  const skillNames = bank.skills.map((s) => s.replace(/\.md$/, ''));
  // Bounded: a bank with dozens of skill files must not spend the whole budget on one pointer line.
  const shown = skillNames.slice(0, 8);
  const skillsText = shown.length ? [...shown, ...(skillNames.length > 8 ? ['…'] : [])] : [...CANONICAL_SKILL_NAMES];
  const pointers = [
    '  state: .ai/CURRENT_TASK.md · map: .ai/README.md · architecture: .ai/ARCHITECTURE.md',
    `  skills: ${skillCommandList(skillsText)} (specs: .ai/skills/)`,
  ];
  // Project-declared sections are the one part of the bank engram did not invent, so the
  // fingerprint names them: an agent that never learns `.ai/journal/` exists will not read it.
  const pointerSection: FingerprintSection = { heading: 'POINTERS', lines: pointers, priority: 4 };
  sections.push(pointerSection);
  if (bank.sections.length) {
    const shownSections = bank.sections.slice(0, 4);
    const tail = bank.sections.length > shownSections.length ? ' · …' : '';
    // Priority 3.5 — its own elastic tier, so it is dropped *before* PITFALLS, RECENT and BINDING.
    // Putting it in POINTERS (priority 4, never dropped) made a one-line declaration evict the whole
    // PITFALLS block, then RECENT, then the binding decisions: the new feature outranked the content
    // it exists to complement. Learning that `.ai/journal/` exists is worth less than the pitfalls.
    sections.push({
      lines: [`  sections: ${shownSections.map((s) => `${s.name} → ${sectionTarget(s)}`).join(' · ')}${tail}`],
      priority: 3.5,
    });
  }

  const header = (): string[] => [
    `# engram v1 · ${project} · ${generated.slice(0, 10)}`,
    'Read .ai/CURRENT_TASK.md first. Follow AGENTS.md for the full contract.',
  ];

  const fitted = fitToBudget(header, sections, maxBytes, pointerSection);
  const markdown = fitted.markdown;
  const bytes = Buffer.byteLength(markdown, 'utf8');
  return {
    markdown,
    bytes,
    truncated: fitted.truncated,
    dropped: fitted.dropped,
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
      pitfallsTotal: bank.pitfalls.length,
      skills: bank.skills.map((s) => `/${s.replace(/\.md$/, '')}`),
      activeGoal: goal
        ? {
            id: goal.id,
            status: goal.record.status,
            text: goal.record.goal,
            verdict: goal.brief.doneWhen ? describeVerdict(goal.brief.doneWhen) : (goal.brief.error ?? 'not declared'),
            blocked: goal.record.blocker?.reason ?? null,
            waitingUntil: goal.record.wake?.deadlineAt ?? null,
          }
        : null,
      bytes,
      truncated: fitted.truncated,
      dropped: fitted.dropped,
      readErrors: opts.readErrors ?? [],
    },
  };
}

/**
 * Priorities whose sections may be dropped or shortened when the byte budget is tight, in drop
 * order. 3.5 is the declared-sections continuation: least important, so it goes first; 0.5 is the
 * live goal, which outlives the binding decisions but yields to NOW and POINTERS.
 */
const ELASTIC_PRIORITIES = [3.5, 3, 2, 1, 0.5];

/** One line describing how a goal will be judged, for the GOAL block. */
function describeVerdict(doneWhen: NonNullable<MemoryBank['goal']>['brief']['doneWhen']): string {
  if (doneWhen === null) return 'not declared';
  if (doneWhen.kind === 'cmd') return `cmd: ${doneWhen.commands.join(' && ')}`;
  if (doneWhen.kind === 'metric') return `metric: ${doneWhen.file}:${doneWhen.path} ${doneWhen.op} ${String(doneWhen.value)}`;
  return `checklist: ${doneWhen.file}`;
}

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
  pointers?: FingerprintSection,
): { markdown: string; truncated: boolean; dropped: Dropped[] } {
  const render = (kept: FingerprintSection[]): string =>
    [...header(), ...kept.flatMap((s) => (s.heading === undefined ? s.lines : [s.heading, ...s.lines])), ''].join('\n');

  const size = (kept: FingerprintSection[]): number => Buffer.byteLength(render(kept), 'utf8');
  const fits = (kept: FingerprintSection[]): boolean => size(kept) <= maxBytes;

  // Rendered before anything is dropped, so "was anything left out?" is a byte comparison rather than
  // a guess about which branch ran.
  const full = render(sections);

  // `dropToFit` is a pure function of the *original* section list, and the notice loop below calls it
  // repeatedly. Making it mutate its input instead meant the second call ran against an
  // already-shortened list, found everything fitting, and reported "nothing was dropped" — so the
  // omission line rendered empty, which is worse than not having one.
  let result = dropToFit(sections, fits);
  let { kept, dropped } = result;

  // Name the omissions **on the artefact**, not only on stderr: a fingerprint is pasted into a session,
  // and its reader never sees stderr. Without this, a digest whose PITFALLS block did not fit reads
  // exactly like a project that has no pitfalls — which is what happened to this repository the moment
  // its `CURRENT_TASK` grew. POINTERS is priority 4 and never dropped, so the notice always survives.
  if (pointers !== undefined) {
    // The notice costs bytes, and those bytes come out of the elastic content it is describing — so
    // printing it can drop one more section than the run that produced it. Iterate to a fixed point.
    //
    // Convergence is guaranteed, not hoped for: every pass adds the notice, and a longer notice can only
    // remove more, so the drop sets form an *increasing* sequence over a finite set of sections. The
    // first version compared `again.dropped` with itself after assigning it, so the loop could never run
    // twice and the notice named a strictly smaller set than `fp.dropped` reported — a budget that drops
    // content and does not name it on the artefact, which is the one thing this notice exists to prevent.
    for (let pass = 0; pass <= sections.length + 2; pass++) {
      const at = pointers.lines.findIndex((l) => l.startsWith('  omitted:'));
      if (at >= 0) pointers.lines.splice(at, 1);
      const notice = dropped.length > 0 ? omissionLine(dropped) : '';
      if (notice !== '') pointers.lines.push(notice);
      const again = dropToFit(sections, fits);
      kept = again.kept;
      dropped = again.dropped;
      // Compared as the *rendered text*, which is the thing that has to agree with `dropped`.
      if ((again.dropped.length > 0 ? omissionLine(again.dropped) : '') === notice) break;
    }
    // Belt and braces for the exit-by-exhaustion path. Convergence is not monotone in the notice's
    // *length*: `omissionLine` renders a shortened tier as `PITFALLS(10L)` and the same tier dropped
    // whole as `PITFALLS(all)`, so a longer drop set can yield a SHORTER notice and the loop can
    // oscillate instead of converging. Then it leaves through the pass counter with `pointers.lines`
    // holding the notice built from the *previous* drop set while `dropped` is the newer one — the
    // artefact and `--json` silently disagreeing, which is the one thing this notice exists to prevent.
    // Re-deriving the notice from the final `dropped` makes the two agree on every exit.
    const at = pointers.lines.findIndex((l) => l.startsWith('  omitted:'));
    if (at >= 0) pointers.lines.splice(at, 1);
    if (dropped.length > 0) pointers.lines.push(omissionLine(dropped));
  }

  let markdown = render(kept);
  if (!fits(kept)) {
    // The floor itself does not fit. Say so on the artefact rather than only in the exit code: a reader
    // of a pasted fingerprint cannot see stderr.
    //
    // The notice is **reserved for**, because the hard cut would otherwise remove the very line that
    // names what the cut took — leaving a truncated fragment that looks like a whole document. Below the
    // ~338-byte floor there is no room for the content, but there is always room for the sentence that
    // says content is missing.
    // Record the byte-cut in `dropped` BEFORE the notice is rendered from it. It used to be pushed
    // afterwards, so the artefact could never name the cut it had just made: measured, every budget from
    // 1 to 419 bytes produced a notice listing only the sections, while `--json` also reported
    // `(hard cut)(all)` — the artefact and its own accounting disagreeing, in the direction that makes a
    // pasted digest look more complete than it is.
    if (!dropped.some((d) => d.section === '(hard cut)')) {
      dropped.push({ section: '(hard cut)', lines: 0, how: 'dropped' });
    }
    const notice = dropped.length > 0 && pointers !== undefined ? `${omissionLine(dropped)}\n` : '';
    const reserve = Buffer.byteLength(notice, 'utf8');
    // A ceiling smaller than the sentence that reports the truncation has to choose, and `--max-bytes`
    // promises a ceiling: below it the artefact is a cut fragment and the reason is on stderr and in
    // `--json`. Never exceeding the budget wins over naming, because an unenforceable ceiling is the
    // worse of the two lies.
    if (reserve > 0 && maxBytes > reserve + 1) {
      markdown = `${hardTruncate(markdown, maxBytes - reserve).trimEnd()}\n${notice}`;
    } else {
      markdown = hardTruncate(markdown, maxBytes);
    }
  }
  // "Truncated" means content was left out to fit the budget — whether a section was dropped, a line was
  // elided, or bytes were cut. Reporting only byte-cuts claimed "under budget" while silently dropping
  // the binding decisions.
  return { markdown, truncated: markdown !== full, dropped };
}

/** Whether two drop reports describe the same content loss. */
function sameDropped(a: Dropped[], b: Dropped[]): boolean {
  return a.length === b.length && a.every((d, i) => d.section === b[i]?.section && d.lines === b[i]?.lines && d.how === b[i]?.how);
}

/** The drop-and-shorten pass, as a pure function so it can be run repeatedly. */
function dropToFit(
  sections: FingerprintSection[],
  fits: (k: FingerprintSection[]) => boolean,
): { kept: FingerprintSection[]; dropped: Dropped[] } {
  // A shallow copy per level: the caller's sections must survive for the next pass to start from.
  let kept = sections.map((s) => ({ ...s, lines: [...s.lines] }));
  const dropped: Dropped[] = [];

  /**
   * Shorten before dropping, one tier at a time, least valuable first.
   *
   * The old order dropped a whole section before shortening any, so 239 bytes over the ceiling (this
   * repository, the moment `CURRENT_TASK` grew) lost **all** pitfalls to keep three session titles.
   * Trimming each tier to its first entry first means the same budget buys one decision, one session
   * *and* one pitfall — three pointers instead of three of one kind, and the reader still learns that
   * the other sections exist. A whole section is only given up when shortening it to a single line
   * was not enough.
   *
   * `dropped` is built from the *original* line counts, so a report says "BINDING (2 lines)" rather
   * than naming a section that is still present.
   */
  const shorten = (p: number): void => {
    const section = kept.find((x) => x.priority === p);
    if (section === undefined) return;
    const before = section.lines.length;
    while (section.lines.length > 1 && !fits(kept)) section.lines.pop();
    const removed = before - section.lines.length;
    if (removed > 0) {
      dropped.push({ section: section.heading ?? `(continuation @${p})`, lines: removed, how: 'shortened' });
    }
  };

  // Pass 1 — trim every elastic tier to one entry, least valuable first. Trimming all of them before
  // sacrificing any one of them is what lets a tight budget buy *a* decision, *a* session and *a*
  // pitfall instead of three of one kind. Measured: this repository was 11 bytes over after PITFALLS
  // was trimmed to a single line, and the single-pass version dropped the whole block rather than
  // finding 11 bytes in RECENT.
  for (const p of ELASTIC_PRIORITIES) {
    if (fits(kept)) break;
    shorten(p);
  }

  // Pass 2 — still over, so a tier has to go, least valuable first.
  for (const p of ELASTIC_PRIORITIES) {
    if (fits(kept)) break;
    for (const gone of kept.filter((s) => s.priority === p)) {
      // Replace that tier's `shortened` note: reporting both "PITFALLS (1 line)" and "PITFALLS
      // (whole)" for one section is two statements about the same thing, and only one is still true.
      const at = dropped.findIndex((d) => d.section === (gone.heading ?? `(continuation @${p})`));
      if (at >= 0) dropped.splice(at, 1);
      dropped.push({ section: gone.heading ?? `(continuation @${p})`, lines: 0, how: 'dropped' });
    }
    kept = kept.filter((s) => s.priority !== p);
  }

  // NOW is never dropped, only shortened — it is the line that says what this project is doing.
  if (!fits(kept)) shorten(0);
  return { kept, dropped };
}

/**
 * One pointer line naming what the budget took.
 *
 * Deliberately names the *section* rather than only counting bytes: "PITFALLS (whole)" tells the reader
 * to open `.ai/pitfalls/`, while "truncated at 1424 B" tells them nothing they can act on.
 */
function omissionLine(dropped: Dropped[]): string {
  const named = dropped.map((d) => `${d.section}(${d.how === 'dropped' ? 'all' : `${d.lines}L`})`);
  return `  omitted: ${named.join(' ')} — full content is in .ai/`;
}

/** Final safety net: cut on a byte boundary, never mid-codepoint. */
function hardTruncate(text: string, maxBytes: number): string {
  if (maxBytes <= 1) return '';
  const marker = '…';
  // One byte is reserved for the framing newline the CLI appends to stdout. Without it,
  // `dump --max-bytes 50` emitted 51 bytes while reporting "50 bytes · at budget" — the `--out`
  // file was correct, so the discrepancy was invisible unless you piped to `wc -c`.
  const ceiling = maxBytes - 1;
  const budget = ceiling - Buffer.byteLength(marker, 'utf8');
  // The marker only fits if the ceiling can hold it; otherwise emit plain content. Returning
  // `'…'` unconditionally meant `--max-bytes 2` produced 3 bytes — a ceiling that overflowed by
  // exactly the amount it could not afford.
  const room = budget > 0 ? budget : ceiling;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = Buffer.byteLength(ch, 'utf8');
    if (used + w > room) break;
    out += ch;
    used += w;
  }
  const body = out.replace(/\s+$/u, '');
  if (budget <= 0) return `${body}\n`;
  return `${body}${marker}\n`;
}

function path_label(bank: MemoryBank): string {
  const parts = bank.root.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? 'project';
}