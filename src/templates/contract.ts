/**
 * Layer 0 + Layer 1 contract blocks.
 *
 * Layer 0 = the dynamic fingerprint (`engram dump`), injected by the user or a
 *            system prompt. It is never written into rule files by engram.
 * Layer 1 = the static contract that every tool-native rule file MUST carry so
 *            that a memory bank actually gets read and written back.
 *
 * Every function here is *non-destructive by construction*: a marker that cannot be paired with
 * its closing delimiter is left untouched, never sliced. A scaffolder that eats a user's prose is
 * worse than one that writes nothing.
 */

export const CONTRACT_VERSION = 1;

export const CONTRACT_START = `<!-- engram:contract:start v${CONTRACT_VERSION} -->`;
export const CONTRACT_END = `<!-- engram:contract:end -->`;

/**
 * A row in one of the contract's two tables.
 *
 * The block is *derived*, never authored: `sync` regenerates it from this module plus whatever
 * `.ai/sections.json` declares. That is the whole reason a project can extend the contract without
 * fighting `sync` — the project owns the input, engram owns the rendering.
 */
export interface ContractRow {
  /** Left column: a read trigger or a write event. */
  label: string;
  /** Right column, rendered inside backticks. */
  target: string;
}

export interface ContractExtensions {
  /** Extra `trigger → path` rows appended to the read-on-demand table. */
  read?: ContractRow[];
  /** Extra `event → path` rows appended to the write-back table. */
  write?: ContractRow[];
}

const BASE_READ_ROWS: readonly string[] = [
  '| changing architecture, stack, module boundaries | `.ai/ARCHITECTURE.md` |',
  '| deploy, env vars, CI, incidents, ops | `.ai/runbooks/<topic>.md` |',
  '| a bug that feels familiar / "we fixed this before" | `.ai/pitfalls/cases/<case>.md` |',
  '| resuming after context loss, compaction or a long session | newest `.ai/sessions/*-handoff.md` |',
  '| brainstorming a direction, before writing code | `.ai/decisions/` (write a `💭 PROPOSAL`) |',
];

const BASE_WRITE_ROWS: readonly string[] = [
  '| a choice that is expensive to reverse | `.ai/decisions/YYYY-MM-DD-<topic>.md` via `/remember-decision` |',
  '| a pitfall you hit, or a silent failure mode you decoded | `.ai/pitfalls/cases/<case>.md` via `/remember-pitfall` |',
  '| ending a session with unfinished or fragile work | `.ai/sessions/YYYY-MM-DD-<topic>-handoff.md` via `/handoff` |',
  '| any change to goal, state or blockers | `.ai/CURRENT_TASK.md` (same edit turn, never "later") |',
];

const contractRow = (r: ContractRow): string => `| ${r.label} | \`${r.target}\` |`;

/**
 * The `.ai/` memory-bank contract, with project-declared sections appended.
 *
 * `aiContract()` with no extensions is byte-identical to the v1 block engram has always written, so
 * upgrading never rewrites an existing rule file. A project that declares sections gets extra rows
 * in both tables — and because those rows are derived from `.ai/sections.json`, deleting the
 * declaration (or syncing with an older engram) can lose the *rendering*, never the source.
 */
export function aiContract(ext: ContractExtensions = {}): string {
  const readRows = [...BASE_READ_ROWS, ...(ext.read ?? []).map(contractRow)].join('\n');
  const writeRows = [...BASE_WRITE_ROWS, ...(ext.write ?? []).map(contractRow)].join('\n');
  return `## Project memory bank (\`.ai/\`) — required contract

This repository keeps a portable, tool-independent memory bank in \`.ai/\`. It outranks chat
history and your own recollection. Read it on demand with file tools; never paste it wholesale.

### Read before you act

1. \`.ai/CURRENT_TASK.md\` — the current goal, in-progress state and blockers. Read this first.
2. Newest-first scan of \`.ai/decisions/\` for \`💭 PROPOSAL\` / \`✅ ACCEPTED\` entries that touch
   your task. An accepted decision is binding; a proposal needs a verdict, not silent adoption.

### Read on demand (trigger → file, not a bulk preload)

| Trigger | Read |
| --- | --- |
${readRows}

### Write back (not optional)

| Event | Write |
| --- | --- |
${writeRows}

Rules of the bank:

- One file per topic, \`YYYY-MM-DD-<kebab-topic>.md\`, status header on line 1 of the body:
  \`💭 PROPOSAL\` → \`✅ ACCEPTED\` → \`🪦 REJECTED\`. Flip the status, never rewrite history.
- Keep entries short and factual. The bank is an index of decisions, not a diary.
- Canonical skill specs live in \`.ai/skills/*.md\`. If your tool can load them, load them; if
  it cannot, this table is the fallback contract — follow it literally.
- If the bank and the code disagree, the bank is stale: fix the bank in the same change.
`;
}

/**
 * The default contract, for consumers that only need the built-in block (tests, tools that render
 * without a project). Call `aiContract(extensions)` when a project declares extra sections.
 */
export const AI_CONTRACT = aiContract();

/** Generated-file marker used by `engram sync` to avoid clobbering hand edits. */
export const GENERATED_MARKER = '<!-- engram:generated -->';

/**
 * Marker written into every rule file whose contract block engram owns.
 * Lets `init` tell "this file already exists because engram made it" apart from
 * "this file pre-existed and must be preserved", which keeps `init` idempotent.
 */
export const MANAGED_MARKER = '<!-- engram:managed -->';

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;

/** One source line, flagged when it is *inert*: inside a code fence or an HTML comment. */
interface LineInfo {
  text: string;
  start: number;
  end: number;
  /** A marker on an inert line is documentation, never structure. */
  inert: boolean;
}

/**
 * Split text into lines and flag the inert ones.
 *
 * Three details here are load-bearing, each from a bug that actually shipped:
 *
 * - Fences compare by **length**, not by first character. CommonMark says a four-backtick block
 *   is closed only by a fence of at least four backticks; comparing one character let a
 *   three-backtick line close a four-backtick fence, so a marker inside it read as real and the
 *   user's prose was deleted.
 * - HTML comments are tracked as **state**. A documented marker inside a multi-line comment
 *   otherwise made a rule file permanently unmanageable.
 * - CRLF input is normalised, so Windows-authored files behave like Unix ones.
 */
function scanLines(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let fence: { char: string; len: number } | null = null;
  let inComment = false;
  let offset = 0;

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const marker = inComment ? undefined : FENCE_RE.exec(line)?.[1];
    const isDelimiter = marker !== undefined;
    const inFenceNow = fence !== null || isDelimiter;
    // A marker line is structural *unless* it sits in a code fence. `<!-- engram:contract:start
    // v1 -->` is written as an HTML comment, so treating any `<!--` as a comment opener made the
    // contract invisible to its own parser; but the fence case must keep winning over both.
    const structural =
      !inFenceNow && (ownsMarker(line, CONTRACT_START) || ownsMarker(line, CONTRACT_END));
    const opensComment = !isDelimiter && !inComment && line.includes('<!--');
    const inert = !structural && (inFenceNow || inComment || opensComment);

    if (fence !== null) {
      if (isDelimiter && marker[0] === fence.char && marker.length >= fence.len) fence = null;
    } else if (isDelimiter) {
      fence = { char: marker[0]!, len: marker.length };
    }

    if (!isDelimiter) {
      if (!inComment && line.includes('<!--')) inComment = true;
      else if (inComment && line.includes('-->')) inComment = false;
    }

    lines.push({ text: line, start: offset, end: offset + line.length, inert });
    offset += raw.length + 1; // +1 for the newline that split() removed
  }
  return lines;
}

export interface ContractSpan {
  /** Offset of the opening marker. */
  start: number;
  /** Offset just past the closing marker. */
  end: number;
}

/**
 * A marker only counts when it *is* the line.
 *
 * A rule file that documents the contract legitimately mentions the markers inline in prose —
 * "never hand-edit the block between `<!-- engram:contract:start -->` and
 * `<!-- engram:contract:end -->`". Matching those inline occurrences made the file look
 * unbalanced, the safety check then refused to write, and `withContract` silently dropped the
 * real contract block. Structural means "owns its line".
 */
function ownsMarker(text: string, marker: string): boolean {
  return text.trim() === marker;
}

/**
 * Locate the contract block. Returns `null` when it is absent, unbalanced, or ambiguous.
 * Refusing to guess is the point: a wrong span is data loss.
 */
export function findContractSpan(text: string): ContractSpan | null {
  let open: number | null = null;
  for (const line of scanLines(text)) {
    if (line.inert) continue;
    if (open === null) {
      if (ownsMarker(line.text, CONTRACT_START)) open = line.start;
      continue;
    }
    if (ownsMarker(line.text, CONTRACT_END)) return { start: open, end: line.start + CONTRACT_END.length };
  }
  return null;
}

export type MarkerHealth = 'absent' | 'balanced' | 'unbalanced';

export interface MarkerReport {
  health: MarkerHealth;
  /** Opening markers found outside code fences. */
  starts: number;
  /** Closing markers found outside code fences. */
  ends: number;
  span: ContractSpan | null;
}

/** Diagnose contract markers before touching a file. Surfaced by `sync` and `audit`. */
export function inspectMarkers(text: string): MarkerReport {
  let starts = 0;
  let ends = 0;
  for (const line of scanLines(text)) {
    if (line.inert) continue;
    if (ownsMarker(line.text, CONTRACT_START)) starts += 1;
    if (ownsMarker(line.text, CONTRACT_END)) ends += 1;
  }
  const span = findContractSpan(text);
  if (span === null) return { health: starts > 0 || ends > 0 ? 'unbalanced' : 'absent', starts, ends, span };
  return { health: 'balanced', starts, ends, span };
}

/** Replace the contract block in place. A no-op when the block is absent or unpaired. */
export function replaceContractBlock(text: string, ext: ContractExtensions = {}): string {
  const span = findContractSpan(text);
  if (!span) return text;
  const block = `${CONTRACT_START}\n${aiContract(ext)}${CONTRACT_END}`;
  return text.slice(0, span.start) + block + text.slice(span.end);
}

/** Remove the contract block. A no-op when absent or unpaired — never deletes by arithmetic. */
export function stripContractBlock(text: string): string {
  const span = findContractSpan(text);
  if (!span) return text;
  return joinParts(text.slice(0, span.start), text.slice(span.end));
}

function joinParts(head: string, tail: string): string {
  const h = head.trimEnd();
  const t = tail.trimStart();
  return [h, t].filter(Boolean).join('\n\n');
}

/** Wrap an optional project-authored body with the engram contract. Idempotent.
 *
 * When the body already contains an *unpaired* marker the function refuses to act and returns the
 * input untouched. Appending a second opening marker cannot repair the file; it only makes the
 * damage harder to see. Callers detect this with `inspectMarkers` and tell the user.
 */
export function withContract(body: string, ext: ContractExtensions = {}): string {
  const trimmed = body.trim();
  const block = `${CONTRACT_START}\n${aiContract(ext)}${CONTRACT_END}`;
  if (!trimmed) return `${block}\n`;
  if (inspectMarkers(trimmed).health === 'unbalanced') return `${body}\n`;
  if (findContractSpan(trimmed)) {
    return `${joinParts(stripContractBlock(trimmed), block)}\n`;
  }
  return `${trimmed}\n\n${block}\n`;
}

/** Extract the human-authored part of a rule file (contract block removed). */
export function withoutContract(file: string): string {
  if (!findContractSpan(file)) return file.trim();
  return stripContractBlock(file).trim();
}