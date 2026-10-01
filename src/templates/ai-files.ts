/**
 * The `.ai/` skeleton: 3 root files + 4 knowledge directories + 4 skill specs.
 *
 * Files starting with `_` are templates/examples and are ignored by `engram dump`.
 */

export interface AiFile {
  /** Path relative to the project root, e.g. `.ai/README.md`. */
  path: string;
  content: string;
}

export interface SkeletonContext {
  projectName: string;
  /** ISO date, injected so templates are never stale-by-default. */
  today: string;
}

const mdTable = (rows: string[][]): string => {
  const [head, ...rest] = rows;
  if (!head) return '';
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...rest.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
};

export function aiReadme(ctx: SkeletonContext): string {
  return `# .ai/ — project memory bank

Portable, tool-independent memory for AI coding tools. Every supported tool (Claude Code, Codex,
Pi, Cursor, Windsurf, Copilot, Gemini CLI, OpenCode, …) reads and writes **this same directory**,
so switching tools never resets context.

## Layer model (how context is loaded)

| Layer | What | Size rule | Loaded when |
| --- | --- | --- | --- |
| L0 dynamic injection | \`engram dump\` fingerprint | ≤ 1.5 KB / 300–500 tokens | every new session, pasted or injected |
| L1 behaviour contract | \`AGENTS.md\` / \`CLAUDE.md\` / \`.cursor/rules/*.mdc\` … | < 2 KB | always, by the tool |
| L2 knowledge bank | this \`.ai/\` tree | unbounded | on demand, via file reads |
| L3 action specs | \`.ai/skills/*.md\` | ~1 KB each | on trigger, via \`/handoff\`, \`/audit\`, … |

## Map

| Path | Responsibility | Never store |
| --- | --- | --- |
| \`.ai/CURRENT_TASK.md\` | what is being done right now: goal, checklist, state, blockers | long history |
| \`.ai/ARCHITECTURE.md\` | stack, directory boundaries, core call topology, invariants | step-by-step plans |
| \`.ai/decisions/\` | proposals and decisions with a status machine | casual chat |
| \`.ai/sessions/\` | condensed handoff snapshots for a fresh session to resume | full transcripts |
| \`.ai/runbooks/\` | deploy / env / CI / incident SOPs | one-off trivia |
| \`.ai/pitfalls/cases/\` | decoded failure modes, each with cause → fix → guard | duplicate bugs |
| \`.ai/skills/\` | canonical, portable skill specs (\`/handoff\`, …) | tool-specific config |

## Operating contract (read before acting)

1. Read \`.ai/CURRENT_TASK.md\` first, then newest \`.ai/decisions/\`.
2. Pull \`.ai/ARCHITECTURE.md\` / \`runbooks/\` / \`pitfalls/cases/\` only when the trigger matches.
3. Write back in the same turn: decisions → \`decisions/\`, pitfalls → \`pitfalls/cases/\`, session
   ends → \`sessions/\`, state changes → \`CURRENT_TASK.md\`.
4. Status machine: \`💭 PROPOSAL\` → \`✅ ACCEPTED\` → \`🪦 REJECTED\`. Flip the line, keep the reasoning.
5. Never invent context you did not read. If the bank does not cover it, say so and ask.

## Naming

- \`decisions/YYYY-MM-DD-<topic>.md\`
- \`sessions/YYYY-MM-DD-<topic>-handoff.md\`
- \`runbooks/<topic>.md\`
- \`pitfalls/cases/<case>.md\`
- \`_TEMPLATE.md\` in each directory is the canonical shape — copy it, never edit in place.
- Skills: \`.ai/skills/<name>.md\`, \`name\` in \`kebab-case\` matching the command.

## Fresh-session bootstrap

\`\`\`bash
engram dump            # ≤1.5 KB fingerprint → paste as the first user message
engram dump --json     # same content, machine-readable
\`\`\`

Project: **${ctx.projectName}** · skeleton created ${ctx.today} by engram.
`;
}

export function aiArchitecture(): string {
  return `# Architecture

> Single file by design. Frontend + backend + infra live here; split only when a reader needs
> fewer than ~200 lines to answer "where does X live?".

## 1. Purpose

<!-- One paragraph: what this system does, for whom, and what it deliberately does not do. -->

## 2. Stack

${mdTable([
  ['Layer', 'Technology', 'Version', 'Why this one'],
  ['Frontend', '', '', ''],
  ['Backend', '', '', ''],
  ['Data', '', '', ''],
  ['Infra', '', '', ''],
])}

## 3. Repository map

<!-- Only directories that own a responsibility. One line each: path → responsibility → owner. -->

| Path | Responsibility | Touches |
| --- | --- | --- |
| \`src/\` | | |

## 4. Core topology

\`\`\`text
entry → handler → service → repository → store
\`\`\`

<!-- Describe the 2–4 critical flows and where they enter the system. -->

## 5. Invariants

<!-- Rules that must hold for the system to be correct. Each one testable. -->

1. …

## 6. Boundaries and known debts

<!-- What is deliberately not abstracted yet, and the trigger that would change that. -->
`;
}

export function aiCurrentTask(ctx: SkeletonContext): string {
  return `# Current task

<!-- The single live surface. Keep it under ~60 lines: it is read on every session start. -->

**Status:** 🟡 active · **Updated:** ${ctx.today}

## Goal

<!-- One sentence. If you need two, the task is really two tasks.
     It may wrap across lines; the parser joins the paragraph rather than cutting at line 1. -->

## Checklist

- [x] …
- [ ] …

## Code state

<!-- What is actually true right now: branch, last merged change, half-finished edits.
     Read into the fingerprint as well, so lead with the branch. -->

## Blockers

<!-- Bullets, not a table: \`engram dump\` lifts this section straight into the session fingerprint.
     One blocker per line as "<what> — waiting on <whom>", or the single word: none -->

- none yet

## Pitfall reminders for the current branch

<!-- Link to \`.ai/pitfalls/cases/\` entries that apply to what you are touching right now.
     These reach the fingerprint too, so keep each title short and specific. -->

## Next action

<!-- The single next step, specific enough to execute without re-reading this file.
     Wrapped across several lines is fine: the parser joins the whole paragraph. -->
`;
}

export function decisionTemplate(): string {
  return `# <Decision title: imperative, specific>

**Status:** 💭 PROPOSAL · **Date:** YYYY-MM-DD · **Deciders:** <who> · **Supersedes:** <file or none>

<!-- Status machine: 💭 PROPOSAL → ✅ ACCEPTED → 🪦 REJECTED.
     Flip the word in the Status line above; never delete the file and never rewrite the reasoning. -->

## Context

<!-- The forcing function. Facts and constraints only — no preference yet. -->

## Options

| Option | Upside | Downside | Reversibility |
| --- | --- | --- | --- |
| A | | | easy / hard |

## Decision

<!-- Fill when ACCEPTED. State it as a rule, not as a preference. -->

## Consequences

<!-- What becomes easier, what becomes harder, what must now be true. -->

## Revisit when

<!-- The observable condition that should reopen this decision. -->
`;
}

export function sessionTemplate(): string {
  return `# <Session topic> — handoff

**Date:** YYYY-MM-DD · **Branch/Commit:** <branch @ sha> · **Duration:** <rough>

## Where we ended

<!-- One paragraph a fresh session can read cold and know the situation. -->

## What changed

| File / area | Change | Why |
| --- | --- | --- |

## Verified / unverified

- [x] tested: …
- [ ] assumed, NOT tested: …

## Loose ends

- [ ] …

## Do not repeat

<!-- Failed approaches, dead ends, wrong assumptions. Highest-value section in this file. -->

## Next step

<!-- Exactly what the next session does first, with file paths. -->
`;
}

export function runbookTemplate(): string {
  return `# <Runbook title>

**Applies to:** <env/service> · **Owner:** <who> · **Last verified:** YYYY-MM-DD

## When to use this

<!-- Trigger symptoms, not a description of the procedure. -->

## Preconditions

- access / credentials
- tools and versions

## Procedure

1. …

## Verification

<!-- How to prove the system is healthy afterwards. -->

## Rollback

<!-- Exact commands. If rollback is not possible, say so loudly here. -->
`;
}

export function pitfallTemplate(): string {
  return `# <Failure mode as a sentence: "X happens when Y">

**Severity:** 🔴 high / 🟠 medium / 🟡 low · **First hit:** YYYY-MM-DD · **Hits since:** 0

## Symptom

<!-- The exact error string, log line or wrong output, copy-pasteable. -->

## Root cause

<!-- The mechanism, not the symptom restated. -->

## Fix

<!-- The change that resolved it, with paths. -->

## Guard

<!-- The check, test or lint that makes this unrepeatable. If none exists, write the TODO. -->
`;
}

export function aiReadmeExample(): string {
  return `_TEMPLATE.md — copy this file to \`.ai/decisions/YYYY-MM-DD-<topic>.md\` and edit the copy.
Keep the section order. Delete nothing: a rejected decision stays as \`🪦 REJECTED\`.
`;
}