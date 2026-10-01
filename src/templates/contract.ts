/**
 * Layer 0 + Layer 1 contract blocks.
 *
 * Layer 0 = the dynamic fingerprint (`engram dump`), injected by the user or a
 *            system prompt. It is never written into rule files by engram.
 * Layer 1 = the static contract that every tool-native rule file MUST carry so
 *            that a memory bank actually gets read and written back.
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

/** Wrap an optional project-authored body with the engram contract. Idempotent. */
export function withContract(body: string): string {
  const trimmed = body.trim();
  const block = `${CONTRACT_START}\n${AI_CONTRACT}${CONTRACT_END}`;
  if (!trimmed) return `${block}\n`;
  const start = trimmed.indexOf(CONTRACT_START);
  if (start !== -1) {
    const end = trimmed.indexOf(CONTRACT_END, start);
    if (end !== -1) {
      const head = trimmed.slice(0, start).trimEnd();
      const tail = trimmed.slice(end + CONTRACT_END.length).trimStart();
      return [head, block, tail].filter(Boolean).join('\n\n') + '\n';
    }
  }
  return `${trimmed}\n\n${block}\n`;
}

/** Extract the human-authored part of a rule file (contract block removed). */
export function withoutContract(file: string): string {
  const start = file.indexOf(CONTRACT_START);
  if (start === -1) return file.trim();
  const end = file.indexOf(CONTRACT_END, start);
  if (end === -1) return file.trim();
  return [file.slice(0, start).trimEnd(), file.slice(end + CONTRACT_END.length).trimStart()]
    .filter(Boolean)
    .join('\n\n');
}

/** Generated-file marker used by `engram sync` to avoid clobbering hand edits. */
export const GENERATED_MARKER = '<!-- engram:generated -->';

/**
 * Marker written into every rule file whose contract block engram owns.
 * Lets `init` tell "this file already exists because engram made it" apart from
 * "this file pre-existed and must be preserved", which keeps `init` idempotent.
 */
export const MANAGED_MARKER = '<!-- engram:managed -->';