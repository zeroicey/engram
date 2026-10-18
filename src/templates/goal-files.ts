/**
 * Templates for `.ai/goal/<id>/` — the two files a human reads.
 *
 * `goal.json` has no template: it is machine-owned and written from `GoalRecord`. What needs a shape
 * is `BRIEF.md` (the goal text plus the one machine-checkable `done_when` block) and `TASKS.md` (the
 * checklist backing a `checklist`-shaped verdict).
 *
 * The brief is deliberately explicit about the three shapes and about the rule that a goal which
 * cannot produce one is blocked *before* any work happens — because that file is where the gate
 * either exists or does not, and a scaffold that leaves the block out produces a goal that can never
 * be finished.
 */

import type { DoneWhen } from '../core/goal.js';

export interface GoalBriefContext {
  goal: string;
  /** ISO date. */
  today: string;
  /** Pre-declared verdict, from `engram goal new --cmd …`. Omitted leaves the block to the agent. */
  doneWhen?: DoneWhen;
  /** Set when the user asked for a checklist shape, so the brief points at the right file. */
  checklistFile?: string;
}

const doneWhenJson = (doneWhen: DoneWhen): string => JSON.stringify(doneWhen, null, 2);

const SHAPES = `\`\`\`json
{ "kind": "cmd", "commands": ["npm test", "npm run typecheck"] }
\`\`\`

\`\`\`json
{ "kind": "metric", "file": "out/eval.json", "path": "eval.mAP", "op": ">=", "value": 0.85 }
\`\`\`

\`\`\`json
{ "kind": "checklist", "file": "TASKS.md" }
\`\`\``;

export function goalBrief(ctx: GoalBriefContext): string {
  const declared = ctx.doneWhen
    ? `\nThe verdict was declared when this goal was created:\n\n\`\`\`json\n${doneWhenJson(ctx.doneWhen)}\n\`\`\`\n`
    : `\n**This block is empty on purpose.** The first run classifies the goal and does not work: fill
it with exactly one of the three shapes below. If none of them can be produced, report \`blocked\`
immediately — an unverifiable goal is not a goal.\n`;

  return `# ${ctx.goal}

**Status:** 🎯 ACTIVE · **Created:** ${ctx.today}

## Goal

${ctx.goal}

## Done when

The engine owns this verdict. It runs it; the agent never reports its own success.

${declared}
### The three shapes, strongest first

${SHAPES}

- **\`cmd\`** — every command must exit 0. The project's own gate belongs here.
- **\`metric\`** — the engine reads a machine-written artifact (JSON, JSONL/NDJSON, CSV/TSV) and does
  the comparison itself, so no shell quoting is involved. A bare \`mAP\` against a JSONL log means
  *the latest record*; \`[0].mAP\` and \`[-1].mAP\` address a specific one.
- **\`checklist\`** — every item must be checked **and** carry evidence that the engine can verify:
  a backticked path (\`docs/goal.md\`), a backticked command (\`npm test\`), or an explicit
  \`evidence: path:<file>\` / \`evidence: cmd:<command>\`. A path must exist; a command must exit 0.

## Not the goal

- Work that only *looks* finished. "Tests pass" is a verdict; "the code looks right" is not.
- A route. How the goal is reached is the agent's choice; this file only says how it is judged.

## Notes

<!-- Anything the agent needs that is not a step-by-step plan. Delete this comment when you add text. -->
`;
}

export function goalTasks(title: string, today: string): string {
  return `# Tasks — ${title}

**Created:** ${today}

Every item needs evidence the engine can verify, and an item without evidence may not be added:

- a backticked **path** — must exist (\`docs/goal.md\`, \`out/eval.json\`)
- a backticked **command** — must exit 0 (\`npm test\`, \`git diff --quiet\`)
- or an explicit \`evidence: path:<file>\` / \`evidence: cmd:<command>\`

\`engram goal check\` verifies all three; a checked box with an unverifiable claim still fails.

- [ ] first item — \`path/to/artifact\`
`;
}
