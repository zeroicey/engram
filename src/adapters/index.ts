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
  | {
      kind: 'agent-skills';
      dir: string;
      /** How the tool exposes the command: Pi uses `/skill:name`, Claude/Cursor use `/name`. */
      invoke?: 'skill-prefixed' | 'plain';
      note?: string;
    }
  | {
      kind: 'prompt-md-args';
      dir: string;
      prefix?: string;
      /** Filename suffix. Copilot requires `<name>.prompt.md`; a bare `.md` is not registered. */
      suffix?: string;
      /** `slash` → description + argument-hint; `copilot` → agent + description. */
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
    skillSinks: [
      {
        kind: 'agent-skills',
        dir: '.agents/skills',
        invoke: 'plain',
        note: 'Codex scans `.agents/skills` from cwd up to the repo root (same dir as the `agents` tool).',
      },
    ],
    notes: [
      'Codex supports project skills under `.agents/skills/`; the shared dir dedupes with the `agents` tool.',
      'User-level `~/.codex/prompts/<name>.md` still works but is deprecated in favour of skills.',
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
      {
        kind: 'agent-skills',
        dir: '.claude/skills',
        invoke: 'plain',
        note: 'Native Agent Skills, invoked as /<name>.',
      },
      // No `.claude/commands` sink on purpose: when a skill and a command share a name the skill
      // wins, so the command file would be a permanently shadowed dead file.
    ],
    styleGuide: `- Concise and imperative; Claude follows short checklists better than prose essays.
- Do NOT @-import \`.ai/\` files: an import is loaded in full every session, which contradicts the
  contract's own "read on demand". Name the path and the trigger instead.
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
      {
        kind: 'agent-skills',
        dir: '.cursor/skills',
        invoke: 'plain',
        note: 'Project-level skills; `.agents/skills/` is honoured as well.',
      },
    ],
    styleGuide: `- \`.mdc\` files need frontmatter: \`description\`, \`globs\`, \`alwaysApply\`.
- One topic per rule file; keep each under ~500 lines and use \`@path\` references for depth.
- Use \`globs\` for file-type-specific rules; for an always-on rule Cursor ignores \`globs\` and \`description\`, so emit \`alwaysApply: true\` alone.
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
    notes: [
      'Windsurf now prefers `.devin/rules/` and `.devin/workflows/`; `.windsurf/rules/` remains supported.',
      'Workspace rules are capped at ~12,000 characters per file — keep the appended contract short.',
    ],
    styleGuide: `- Rule frontmatter: \`trigger: always_on | model_decision | glob | manual\`, \`description\`, and \`globs:\` when the mode is \`glob\`.
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
        suffix: '.prompt.md',
        frontmatter: 'copilot',
        note: 'Reusable prompt files; available in VS Code, Visual Studio and JetBrains IDEs.',
      },
    ],
    styleGuide: `- Copilot instructions are short bullet lists; avoid narrative.
- Use \`.instructions.md\` files with \`applyTo\` globs for anything path-specific.
- Phrase as constraints ("never commit .env", "always run npm test before proposing a patch").
- Keep the two instruction files from duplicating each other: Copilot merges every matching file, so the same contract twice costs twice the tokens.`,
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