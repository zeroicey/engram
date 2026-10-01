/**
 * Cross-tool adapter registry.
 *
 * Each entry describes how one AI coding tool consumes rules and skills. `engram` never
 * hardcodes a single house style: it (a) materialises the `.ai/` contract into every
 * tool-native rule file and (b) emits a meta-prompt telling the user's own AI assistant to
 * author the tool-idiomatic remainder.
 */

export type RuleFileKind = 'agents' | 'claude' | 'cursor' | 'windsurf' | 'copilot' | 'gemini';

/** Where a canonical skill spec (`.ai/skills/<name>.md`) gets materialised. */
export type SkillSink =
  | { kind: 'agent-skills'; dir: string; note?: string }
  | {
      kind: 'prompt-md-args';
      dir: string;
      prefix?: string;
      /** `slash` → description + argument-hint; `copilot` → mode + description. */
      frontmatter?: 'slash' | 'copilot';
      note?: string;
    }
  | { kind: 'prompt-toml'; dir: string; note?: string };

export interface RuleFileDef {
  /** Path relative to the project root. */
  path: string;
  kind: RuleFileKind;
  /** Why this file exists for that tool, shown in the meta-prompt. */
  note: string;
  /** Tool-native import lines that pull in memory without duplicating it. */
  imports?: string[];
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
    id: 'agents',
    label: 'AGENTS.md (Codex, OpenCode, Cline, Amp, Zed, Aider …)',
    detect: ['AGENTS.md', 'AGENTS.override.md', '.codex', '.opencode', '.aider.conf.yml'],
    ruleFiles: [
      {
        path: 'AGENTS.md',
        kind: 'agents',
        note: 'The vendor-neutral contract honoured by most non-Anthropic agents.',
      },
    ],
    skillSinks: [
      {
        kind: 'agent-skills',
        dir: '.agents/skills',
        note: 'Agent Skills standard directory — portable, recognised by several agents.',
      },
    ],
    styleGuide: `- Imperative, second-person-free prose. "Run \`npm test\`, do not skip typecheck."
- Order by frequency: build/run/test commands first, then conventions, then workflows.
- Reference real paths and real commands. Never describe code you have not read.
- Keep it under ~200 lines. Long documents are skimmed; short ones are followed.
- Scope narrowing is done by adding \`AGENTS.md\` files in subdirectories, not by growing the root file.`,
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    detect: ['.codex', 'AGENTS.md'],
    ruleFiles: [
      {
        path: 'AGENTS.md',
        kind: 'agents',
        note: 'Codex reads AGENTS.md from the repo root downwards.',
      },
    ],
    skillSinks: [],
    notes: [
      'Codex has no project-scoped skills. User-level prompts: `~/.codex/prompts/<name>.md`.',
      'Say explicitly in AGENTS.md which commands need network/elevated sandbox; Codex sandboxes by default.',
    ],
    styleGuide: `- Lead with the sandbox model: what Codex may run without approval, what needs it.
- Give copy-pasteable commands for build, test, lint, and "how to run just one test file".
- State the failure-handling contract: never commit secrets, never rewrite \`.ai/\` history, ask before force-push.
- Reference \`.ai/\` triggers exactly as the contract block does; Codex follows them literally.`,
  },
  {
    id: 'claude',
    label: 'Claude Code',
    detect: ['CLAUDE.md', '.claude'],
    ruleFiles: [
      {
        path: 'CLAUDE.md',
        kind: 'claude',
        note: 'Primary context file. Personal overrides belong in CLAUDE.local.md (gitignored).',
      },
    ],
    skillSinks: [
      { kind: 'agent-skills', dir: '.claude/skills', note: 'Native Agent Skills; invoked as /skill:<name>.' },
      { kind: 'prompt-md-args', dir: '.claude/commands', note: 'Slash commands: /handoff, /audit, …' },
    ],
    styleGuide: `- Concise and imperative; Claude follows short checklists better than prose essays.
- Use the @-import feature (\`@.ai/ARCHITECTURE.md\`) instead of duplicating content.
- Never restate the whole memory bank in CLAUDE.md: point at it, and describe when to read it.
- Prefer "do X, then verify with Y" over "best practices".`,
  },
  {
    id: 'cursor',
    label: 'Cursor',
    detect: ['.cursor', '.cursorrules'],
    ruleFiles: [
      {
        path: '.cursor/rules/engram-memory.mdc',
        kind: 'cursor',
        note: 'Rule file with alwaysApply so the memory contract is always in context.',
      },
    ],
    skillSinks: [
      { kind: 'agent-skills', dir: '.cursor/skills', note: 'Experimental skill support; harmless when unused.' },
    ],
    styleGuide: `- \`.mdc\` files need frontmatter: \`description\`, \`globs\`, \`alwaysApply\`.
- One topic per rule file; keep each under ~500 lines and use \`@path\` references for depth.
- Use \`globs\` for file-type-specific rules (e.g. \`**/*.test.ts\`), \`alwaysApply: true\` for the memory contract only.
- Do not repeat content between rules — Cursor merges all matching rules and duplicates waste context.`,
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    detect: ['.windsurf', '.windsurfrules'],
    ruleFiles: [
      {
        path: '.windsurf/rules/engram-memory.md',
        kind: 'windsurf',
        note: 'Rule file with trigger: always_on.',
      },
    ],
    skillSinks: [],
    notes: ['Windsurf workflows live in `.windsurf/workflows/`; keep them stateless and defer state to `.ai/`.'],
    styleGuide: `- Rule frontmatter: \`trigger: always_on | model_decision | manual\`, \`description\`, optional \`globs\`.
- Reserve \`always_on\` for the memory contract; everything else should be \`model_decision\`.
- Short, imperative, one rule per bullet. Windsurf cascades rules from the workspace root down.`,
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    detect: ['.github/copilot-instructions.md', '.github/instructions'],
    ruleFiles: [
      {
        path: '.github/copilot-instructions.md',
        kind: 'copilot',
        note: 'Repo-wide custom instructions; always applied to Copilot requests.',
      },
      {
        path: '.github/instructions/engram-memory.instructions.md',
        kind: 'copilot',
        note: 'Path-scoped instruction file with applyTo so the contract survives future edits.',
      },
    ],
    skillSinks: [
      {
        kind: 'prompt-md-args',
        dir: '.github/prompts',
        frontmatter: 'copilot',
        note: 'Reusable prompt files: /handoff, /audit, …',
      },
    ],
    styleGuide: `- Copilot instructions are short bullet lists; avoid narrative.
- Use \`.instructions.md\` files with \`applyTo\` globs for anything path-specific.
- Phrase as constraints ("never commit .env", "always run npm test before proposing a patch").
- Do not exceed ~200 lines total; Copilot truncates long instruction sets.`,
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    detect: ['GEMINI.md', '.gemini'],
    ruleFiles: [
      { path: 'GEMINI.md', kind: 'gemini', note: 'Primary context file loaded into every session.' },
    ],
    skillSinks: [
      { kind: 'prompt-toml', dir: '.gemini/commands', note: 'Custom slash commands: /handoff.toml, …' },
    ],
    styleGuide: `- GEMINI.md is always injected: keep it short and command-focused.
- Custom commands are TOML (\`description\` + \`prompt\`) in \`.gemini/commands/\`.
- Use explicit headings and bullets; state triggers as "when X happens, read Y".`,
  },
  {
    id: 'pi',
    label: 'Pi (earendil-works)',
    detect: ['.pi', 'AGENTS.md', 'CLAUDE.md'],
    ruleFiles: [
      {
        path: 'AGENTS.md',
        kind: 'agents',
        note: 'Pi loads AGENTS.md (or CLAUDE.md) as context files, cascading up the tree.',
      },
    ],
    skillSinks: [
      { kind: 'agent-skills', dir: '.pi/skills', note: 'Agent Skills spec; invoke with /skill:<name>.' },
      { kind: 'prompt-md-args', dir: '.pi/prompts', note: 'Prompt templates become /<name> slash commands.' },
    ],
    notes: [
      'Project resources require trust; run `/reload` after adding skills or prompts in a live session.',
      'Skills are advertised by name+description and loaded on demand — keep descriptions routing-precise.',
    ],
    styleGuide: `- AGENTS.md is the context file; subdirectory AGENTS.md files add local scope.
- Skills: frontmatter \`name\` + \`description\` (max 1024 chars) decides when the model loads them — say what it does *and* when it applies.
- Prefer bundled references over long instructions; Pi loads SKILL.md only when routed to.
- Project trust gates \`.pi/skills\` and \`.pi/prompts\`; mention this to humans, not to the model.`,
  },
];

export const DEFAULT_TOOL_IDS = ['agents', 'claude', 'cursor', 'pi'] as const;

export function getTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id);
}

export function allToolIds(): string[] {
  return TOOLS.map((t) => t.id);
}

/** Rule-file paths claimed by the selected tools, de-duplicated, stable order. */
export function ruleFilesFor(toolIds: string[]): Array<{ toolId: string; def: RuleFileDef }> {
  const seen = new Map<string, { toolId: string; def: RuleFileDef }>();
  for (const id of toolIds) {
    const tool = getTool(id);
    if (!tool) continue;
    for (const def of tool.ruleFiles) {
      if (!seen.has(def.path)) seen.set(def.path, { toolId: id, def });
    }
  }
  return [...seen.values()];
}

/** Tools that write the same rule file as `toolId` (AGENTS.md is shared). */
export function toolsSharingRuleFile(toolIds: string[], rulePath: string): string[] {
  return toolIds.filter((id) => getTool(id)?.ruleFiles.some((f) => f.path === rulePath));
}