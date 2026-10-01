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
 * The `.ai/` memory-bank contract. Appended verbatim to every generated rule
 * file and preserved (idempotently re-written) by `engram sync`.
 */
export const AI_CONTRACT = `## Project memory bank (\`.ai/\`) — required contract

This repository keeps a portable, tool-independent memory bank in \`.ai/\`. It outranks chat
history and your own recollection. Read it on demand with file tools; never paste it wholesale.

### Read before you act

1. \`.ai/CURRENT_TASK.md\` — the current goal, in-progress state and blockers. Read this first.
2. Newest-first scan of \`.ai/decisions/\` for \`💭 PROPOSAL\` / \`✅ ACCEPTED\` entries that touch
   your task. An accepted decision is binding; a proposal needs a verdict, not silent adoption.

### Read on demand (trigger → file, not a bulk preload)

| Trigger | Read |
| --- | --- |
| changing architecture, stack, module boundaries | \`.ai/ARCHITECTURE.md\` |
| deploy, env vars, CI, incidents, ops | \`.ai/runbooks/<topic>.md\` |
| a bug that feels familiar / "we fixed this before" | \`.ai/pitfalls/cases/<case>.md\` |
| resuming after context loss, compaction or a long session | newest \`.ai/sessions/*-handoff.md\` |
| brainstorming a direction, before writing code | \`.ai/decisions/\` (write a \`💭 PROPOSAL\`) |

### Write back (not optional)

| Event | Write |
| --- | --- |
| a choice that is expensive to reverse | \`.ai/decisions/YYYY-MM-DD-<topic>.md\` via \`/remember-decision\` |
| a pitfall you hit, or a silent failure mode you decoded | \`.ai/pitfalls/cases/<case>.md\` via \`/remember-pitfall\` |
| ending a session with unfinished or fragile work | \`.ai/sessions/YYYY-MM-DD-<topic>-handoff.md\` via \`/handoff\` |
| any change to goal, state or blockers | \`.ai/CURRENT_TASK.md\` (same edit turn, never "later") |

Rules of the bank:

- One file per topic, \`YYYY-MM-DD-<kebab-topic>.md\`, status header on line 1 of the body:
  \`💭 PROPOSAL\` → \`✅ ACCEPTED\` → \`🪦 REJECTED\`. Flip the status, never rewrite history.
- Keep entries short and factual. The bank is an index of decisions, not a diary.
- Canonical skill specs live in \`.ai/skills/*.md\`. If your tool can load them, load them; if
  it cannot, this table is the fallback contract — follow it literally.
- If the bank and the code disagree, the bank is stale: fix the bank in the same change.
`;

/** Generated-file marker used by `engram sync` to avoid clobbering hand edits. */
export const GENERATED_MARKER = '<!-- engram:generated -->';

/**
 * Marker written into every rule file whose contract block engram owns.
 * Lets `init` tell "this file already exists because engram made it" apart from
 * "this file pre-existed and must be preserved", which keeps `init` idempotent.
 */
export const MANAGED_MARKER = '<!-- engram:managed -->';

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/** Offset of a line inside the source text, plus whether it sits inside a fenced code block. */
interface LineInfo {
  text: string;
  start: number;
  end: number;
  inFence: boolean;
}

/**
 * Split text into lines, flagging the ones that live inside fenced code blocks.
 * A documentation file that *shows* an engram marker inside a ``` fence must never have it
 * treated as the real thing — that is exactly how a scaffolder deletes user prose.
 */
function scanLines(text: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let fence: string | null = null;
  let offset = 0;
  for (const raw of text.split('\n')) {
    const match = FENCE_RE.exec(raw);
    if (fence === null && match?.[1]) {
      fence = match[1][0] ?? '`';
    } else if (fence !== null && match?.[1]?.[0] === fence) {
      fence = null;
    }
    lines.push({ text: raw, start: offset, end: offset + raw.length, inFence: fence !== null || Boolean(match?.[1]) });
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
 * Locate the contract block. Returns `null` when it is absent, unbalanced, or ambiguous.
 * Refusing to guess is the point: a wrong span is data loss.
 */
export function findContractSpan(text: string): ContractSpan | null {
  let open: number | null = null;
  for (const line of scanLines(text)) {
    if (line.inFence) continue;
    if (open === null) {
      const at = line.text.indexOf(CONTRACT_START);
      if (at !== -1) open = line.start + at;
      continue;
    }
    const at = line.text.indexOf(CONTRACT_END);
    if (at !== -1) return { start: open, end: line.start + at + CONTRACT_END.length };
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
    if (line.inFence) continue;
    starts += line.text.split(CONTRACT_START).length - 1;
    ends += line.text.split(CONTRACT_END).length - 1;
  }
  const span = findContractSpan(text);
  if (span === null) return { health: starts > 0 || ends > 0 ? 'unbalanced' : 'absent', starts, ends, span };
  return { health: 'balanced', starts, ends, span };
}

/** Replace the contract block in place. A no-op when the block is absent or unpaired. */
export function replaceContractBlock(text: string): string {
  const span = findContractSpan(text);
  if (!span) return text;
  const block = `${CONTRACT_START}\n${AI_CONTRACT}${CONTRACT_END}`;
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
export function withContract(body: string): string {
  const trimmed = body.trim();
  const block = `${CONTRACT_START}\n${AI_CONTRACT}${CONTRACT_END}`;
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