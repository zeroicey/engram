/**
 * Layer 3 — canonical, tool-neutral skill specs.
 *
 * Stored once in `.ai/skills/<name>.md` with Agent-Skills-compatible frontmatter, then
 * materialised by `engram sync` into every tool that has native skill or slash-command support.
 * The body must stay tool-neutral: no tool-specific syntax except a plain `ARGUMENTS` line.
 */

export interface SkillSpec {
  name: string;
  description: string;
  /** Single positional argument, documented in the body. */
  argumentHint: string;
  body: string;
}

const frontmatter = (s: SkillSpec): string =>
  ['---', `name: ${s.name}`, `description: ${s.description}`, '---'].join('\n');

export const SKILL_SPECS: SkillSpec[] = [
  {
    name: 'handoff',
    argumentHint: '[topic] — short slug for the session, e.g. "auth-refresh"',
    description:
      'Compress the current session into .ai/sessions/YYYY-MM-DD-<topic>-handoff.md and refresh .ai/CURRENT_TASK.md so a fresh session resumes without re-deriving context. Use when ending a session, after a long debugging detour, after context compaction, or when the user says "wrap up", "handoff", "new session".',
    body: `Compress everything that matters about this session into the memory bank so the next
session starts warm. Never dump a transcript; reconstruct state.

ARGUMENTS: \`<ARGUMENTS>\` is the optional topic slug. If absent, derive one from the dominant task.

## Procedure

1. Gather, in this order: current goal, what actually changed (files, not intentions), what was
   verified vs assumed, loose ends, and dead ends worth not repeating.
2. Read \`.ai/CURRENT_TASK.md\`. Read the newest existing \`.ai/sessions/*-handoff.md\` if one covers
   this work, so you update state instead of forking a competing truth.
3. Write \`.ai/sessions/YYYY-MM-DD-<topic>-handoff.md\` using \`.ai/sessions/_TEMPLATE.md\`
   (create it if the repo predates it). Delete nothing: if today's handoff exists, extend it.
4. Rewrite \`.ai/CURRENT_TASK.md\`: status, goal, checklist reflecting reality, code state,
   blockers, pitfall reminders, and one concrete next action with file paths.
5. If a new irreversible choice was made during the session, it belongs in
   \`.ai/decisions/\` — write it now, do not defer it to "next session".

## Rules

- Every claim must be one the reader can verify from the repo: file paths, commands, commit refs.
- "Assumed, not tested" is mandatory content; it is the highest-value line in the file.
- Prefer deleting noise over summarising: three accurate bullets beat ten vague ones.
- Do not create a handoff file if nothing changed except chat — instead update CURRENT_TASK.md.

## Output to the user

The handoff path, the next action in one sentence, and any decision/pitfall you wrote.
Do not paste the file body back into chat.`,
  },
  {
    name: 'remember-pitfall',
    argumentHint: '<case> — short kebab-case name of the failure mode',
    description:
      'Record a decoded failure mode as .ai/pitfalls/cases/<case>.md: symptom, root cause, fix and a guard that makes it unrepeatable. Use when hitting a confusing bug, a silent wrong-result, a flaky test, an environment-only trap, or when the user says "remember this", "don\'t repeat that", "note this pitfall".',
    body: `Store one failure mode well enough that a future session recognises it before burning
time on it again. A pitfall without a guard is a diary entry; require the guard.

ARGUMENTS: \`<ARGUMENTS>\` is the case slug. If absent, propose one from the symptom and confirm.

## Procedure

1. Search \`.ai/pitfalls/cases/\` first. If a matching case exists, update it: append the new
   occurrence, refine the root cause, raise "hits since" — never create a near-duplicate.
2. Verify the fix actually works before writing. An unverified fix is recorded as hypothesis,
   in the Symptom block, not as a fix.
3. Write \`.ai/pitfalls/cases/<case>.md\` from \`.ai/pitfalls/cases/_TEMPLATE.md\`: symptom with the
   verbatim error string, root cause as a mechanism, the fix with paths, the guard.
4. State the guard as something a machine or a reviewer can enforce: a test, an assertion, a lint
   rule, a startup check. If none can be written now, add an explicit TODO with the trigger.
5. Update \`.ai/CURRENT_TASK.md\` "Pitfall reminders" if this case applies to the current branch.

## Severity

- 🔴 high: silent wrong results, data loss, security, prod-only breakage.
- 🟠 medium: hours lost, misleading errors, environment-only failures.
- 🟡 low: papercuts worth one line.

## Output to the user

Case path, one-line cause, one-line guard. Nothing else.`,
  },
  {
    name: 'remember-decision',
    argumentHint: '<topic> — short kebab-case topic for the decision',
    description:
      'Capture a proposal or an accepted decision in .ai/decisions/YYYY-MM-DD-<topic>.md with the 💭 PROPOSAL → ✅ ACCEPTED → 🪦 REJECTED status machine, options and consequences. Use when a choice is expensive to reverse, when the user asks for a plan/RFC/ADR, or when brainstorming a direction before implementation.',
    body: `Capture one decision with enough alternatives and consequences that it is never
re-litigated from scratch. This replaces ad-hoc ideas directories and ad-hoc chat plans.

ARGUMENTS: \`<ARGUMENTS>\` is the topic slug. If absent, derive it from the choice under discussion.

## Procedure

1. Separate the **context** (facts, constraints, deadlines) from the **proposal** (a preference).
   If the user has not chosen yet, write \`💭 PROPOSAL\` — an unratified idea is a proposal, not a plan.
2. List the real options, at least two, in a table: upside, downside, reversibility. Do not invent
   options to pad the table; if there is genuinely one, say why the alternatives were rejected.
3. Write \`.ai/decisions/YYYY-MM-DD-<topic>.md\` from \`.ai/decisions/_TEMPLATE.md\`.
4. On acceptance, flip line 1 to \`✅ ACCEPTED\`, state the decision as a rule, and list the
   consequences plus what must now be true. Never delete a rejected option — that is the value.
5. If it supersedes an earlier decision, add \`Supersedes:\` pointing at that file and flip the older
   one to \`🪦 REJECTED\` with a pointer forward.
6. Give the decision a "Revisit when" trigger, an observable condition, not "if it stops working".

## Rules

- One decision per file. If it needs an "and", it is two files.
- Record rejected ideas. The cheapest future win is knowing what was already ruled out.
- Never store implementation steps here; those belong in \`.ai/CURRENT_TASK.md\`.

## Output to the user

File path, status, and the question still open (if PROPOSAL) that needs a verdict.`,
  },
  {
    name: 'audit',
    argumentHint: '[scope] — optional path or subsystem to focus on',
    description:
      'Check consistency between the code and the memory bank: architecture drift, decisions that were silently violated, stale runbooks, pitfalls without guards, handoffs that contradict CURRENT_TASK. Use before a release, before a large refactor, after returning from a long absence, or when the user says "audit", "is the doc still true", "drift check".',
    body: `Find where the bank and the code have drifted, and report it as a short, ranked list of
concrete fixes. An audit that only says "docs look fine" is a failed audit.

ARGUMENTS: \`<ARGUMENTS>\` optionally narrows the audit to a path or subsystem.

## Procedure

1. Establish ground truth first: repository layout, entry points, build/test commands, recent
   commits. Never audit against a stale mental model.
2. Check \`.ai/ARCHITECTURE.md\` claim by claim against the tree. For every path or stack entry,
   confirm it exists; for every named boundary, confirm nothing violates it.
3. Check every \`✅ ACCEPTED\` decision in \`.ai/decisions/\` (newest 10) for compliance in the
   current code. A violation is either a revert or a new superseding decision — not silence.
4. Check the latest \`.ai/sessions/*-handoff.md\` and \`.ai/CURRENT_TASK.md\` for contradictions:
   different "current" goal, different branch, or checklist items already done.
5. Check runbooks: does every command still exist? Is there a rollback? Is "last verified" older
   than the last deploy-related commit?
6. Check \`.ai/pitfalls/cases/\`: any case with no guard, or "hits since" still climbing, is an open
   defect, not documentation debt.
7. Report findings ranked by severity with file:line evidence and a one-line proposed fix each.
   Do not edit code in an audit unless asked. Fixing bank-vs-code drift in \`.ai/\` is allowed.

## Output

1. Verdict line: healthy / drifted / stale.
2. Ranked findings: severity, what disagrees, evidence, proposed fix.
3. Explicit list of what you verified and could not verify.`,
  },
];

/** Full canonical file content for `.ai/skills/<name>.md`. */
export function skillFile(spec: SkillSpec): string {
  return `${frontmatter(spec)}\n\n${spec.body.trim()}\n`;
}

export const SKILL_NAMES = SKILL_SPECS.map((s) => s.name);