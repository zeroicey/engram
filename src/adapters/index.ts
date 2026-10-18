/**
 * The adapter registry — one entry, Pi.
 *
 * This file used to describe nine tools. It now describes one, and that is a product decision with
 * a recorded history: `.ai/decisions/2026-10-18-reduce-supported-clients-to-pi-claude-code-and-codex.md`
 * cut nine to three, and `.ai/decisions/2026-10-18-serve-pi-only.md` cut three to one.
 *
 * The registry shape is kept rather than inlined into `init` for one reason: **adding a client is a
 * decision, not an edit.** `test/adapters.test.ts` asserts this array has exactly one entry and that
 * it is `pi`, so a second adapter cannot appear without a new decision file — which is the review
 * step that the previous nine adapters never had, and the reason six of them shipped stale claims.
 */

/** Where a canonical skill spec (`.ai/skills/<name>.md`) gets materialised. */
export type SkillSink =
  | {
      /**
       * The Agent Skills standard: `<dir>/<name>/SKILL.md`. Pi invokes one as `/skill:<name>`.
       */
      kind: 'agent-skills';
      dir: string;
      note?: string;
    }
  | {
      /** A Markdown slash command: `<dir>/<name>.md` with `description` + `argument-hint`. */
      kind: 'prompt-md-args';
      dir: string;
      note?: string;
    };

export interface RuleFileDef {
  /** Path relative to the project root. */
  path: string;
  /** Why this file exists, shown in the meta-prompt. */
  note: string;
}

export interface ToolDef {
  id: string;
  label: string;
  ruleFiles: RuleFileDef[];
  skillSinks: SkillSink[];
  /** Tool-specific best practices injected into the bootstrap meta-prompt. */
  styleGuide: string;
  /** Paths/dirs whose presence means this tool is already in use here. */
  detect: string[];
  /** Human-readable extras, printed after init. */
  notes?: string[];
}

export const TOOLS: ToolDef[] = [
  {
    id: 'pi',
    label: 'Pi (earendil-works)',
    detect: ['.pi', '.agents', 'AGENTS.md'],
    ruleFiles: [
      {
        path: 'AGENTS.md',
        note: 'The context file. Pi loads AGENTS.md (or CLAUDE.md) from the agent directory, the cwd and its parents.',
      },
    ],
    skillSinks: [
      // Two carriers, and no `.pi/skills`:
      //
      // Pi scans `.pi/skills` **and** `.agents/skills`, keeping the first copy of a duplicated name
      // while warning. Shipping the same skill into both made every Pi session print a collision
      // warning for all four skills, with the effective copy decided by scan order. `.agents/skills`
      // is the Agent Skills standard dir Pi reads natively, so that is the one engram writes.
      {
        kind: 'agent-skills',
        dir: '.agents/skills',
        note: 'Agent Skills standard dir, read natively by Pi; invoked as /skill:<name>.',
      },
      { kind: 'prompt-md-args', dir: '.pi/prompts', note: 'Prompt templates become /<name> slash commands.' },
    ],
    notes: [
      'Skills load from `.agents/skills/` — Pi reads it natively, so engram never duplicates them into `.pi/skills/`, where the second copy collides and warns.',
      'Project resources require trust; run `/reload` after adding skills, prompts or the goal extension in a live session.',
      'Skills are advertised by name+description and loaded on demand — keep descriptions routing-precise.',
      'The goal engine is an opt-in carrier: `engram config --goal on`, then `engram sync` writes `.pi/extensions/engram-goal.ts`.',
    ],
    styleGuide: `- AGENTS.md is the context file, loaded from the agent directory, the cwd and its parents; subdirectory files apply only when Pi runs there.
- Keep it under ~200 lines: long documents are skimmed, short ones are followed. Scope down with AGENTS.md files in subdirectories, not by growing the root file.
- Skills: frontmatter \`name\` + \`description\` (max 1024 chars) decides when the model loads them — say what it does *and* when it applies.
- Prefer bundled references over long instructions; Pi loads SKILL.md only when routed to.
- Skills live in \`.agents/skills/\`; Pi reads that alongside \`.pi/skills/\`, so never add a second copy of the same skill name under \`.pi/skills/\`.
- Project trust gates project resources (\`.agents/skills/\`, \`.pi/prompts/\`, \`.pi/extensions/\`); mention this to humans, not to the model.`,
  },
];

/**
 * Rule files engram owns, in a stable order.
 *
 * Was `ruleFilesFor(toolIds)`, de-duplicating AGENTS.md across whichever tools shared it. With one
 * tool the de-duplication had nothing to do, and keeping it would have implied otherwise.
 */
export function ruleFiles(): RuleFileDef[] {
  return TOOLS.flatMap((t) => t.ruleFiles);
}

/** The single supported tool. Kept as a lookup so a call site reads as intent, not as an index. */
export function getTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}

/** Every carrier directory engram writes, de-duplicated, stable order. */
export function allSinkDirs(): string[] {
  return [...new Set(TOOLS.flatMap((t) => t.skillSinks.map((s) => s.dir)))];
}

/**
 * Carrier directories engram no longer writes, kept so `sync` can clean up after itself.
 *
 * One rule applies to every entry: **only a file engram itself generated is ever deleted.** The
 * marker check lives in `commands/prune-carriers.ts`; a hand-written skill in one of these dirs
 * survives untouched.
 *
 * - `.pi/skills` — Pi reads `.agents/skills` natively; materialising both printed a collision warning
 *   for every skill at every startup.
 * - the rest belong to clients dropped on 2026-10-18 (Claude Code, Cursor, GitHub Copilot, Gemini
 *   CLI). Without them those directories keep advertising skills for tools engram cannot install
 *   for, and nothing would ever report them.
 */
export const RETIRED_SINK_DIRS: readonly string[] = [
  '.pi/skills',
  '.claude/skills',
  '.cursor/skills',
  '.github/prompts',
  '.gemini/commands',
];

/**
 * Rule files engram used to write for other clients.
 *
 * Reported by `sync`, **never deleted**. A rule file may contain a human-authored body — `init`
 * preserves it deliberately — so there is no marker that would make removal safe. Warning is not
 * optional either: the file keeps injecting a contract block that this `sync` no longer refreshes,
 * and it is the one artefact of the old multi-client setup a person has to clean up by hand.
 */
export const RETIRED_RULE_FILES: readonly string[] = [
  'CLAUDE.md',
  '.cursor/rules/engram-memory.mdc',
  '.windsurf/rules/engram-memory.md',
  '.github/copilot-instructions.md',
  '.github/instructions/engram-memory.instructions.md',
  'GEMINI.md',
];
