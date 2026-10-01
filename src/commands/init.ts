import path from 'node:path';
import {
  aiArchitecture,
  aiCurrentTask,
  aiReadme,
  aiReadmeExample,
  decisionTemplate,
  pitfallTemplate,
  runbookTemplate,
  sessionTemplate,
  type AiFile,
  type SkeletonContext,
} from '../templates/ai-files.js';
import { SKILL_SPECS, skillFile } from '../templates/skills.js';
import { buildBootstrapPrompt, toolSummary } from '../templates/meta-prompt.js';
import { TOOLS, getTool, ruleFilesFor, type ToolDef } from '../adapters/index.js';
import { commandNameFor, materialize } from '../adapters/skills.js';
import { renderRuleFile, refreshContract } from '../adapters/rules.js';
import { detectProject, pathExists, readFileSafe, todayISO, writeIfMissing, writeFile } from '../core/project.js';
import type { MemoryBank } from '../core/memory.js';
import { loadMemory } from '../core/memory.js';

export interface InitOptions {
  root: string;
  toolIds: string[];
  notes?: string;
  /** Overwrite generated rule files instead of preserving existing bodies. */
  force?: boolean;
  dryRun?: boolean;
}

export interface InitResult {
  files: { path: string; action: 'created' | 'kept' | 'updated' }[];
  tools: ToolDef[];
  bootstrapPath: string;
  warnings: string[];
}

/** The `.ai/` skeleton: 3 root files, 4 knowledge dirs, 4 canonical skills. */
export function aiSkeleton(ctx: SkeletonContext): AiFile[] {
  return [
    { path: '.ai/README.md', content: aiReadme(ctx) },
    { path: '.ai/ARCHITECTURE.md', content: aiArchitecture() },
    { path: '.ai/CURRENT_TASK.md', content: aiCurrentTask(ctx) },
    { path: '.ai/decisions/_TEMPLATE.md', content: decisionTemplate() },
    { path: '.ai/decisions/_EXAMPLE.md', content: aiReadmeExample() },
    { path: '.ai/sessions/_TEMPLATE.md', content: sessionTemplate() },
    { path: '.ai/runbooks/_TEMPLATE.md', content: runbookTemplate() },
    { path: '.ai/pitfalls/cases/_TEMPLATE.md', content: pitfallTemplate() },
    ...SKILL_SPECS.map((s) => ({ path: `.ai/skills/${s.name}.md`, content: skillFile(s) })),
  ];
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const warnings: string[] = [];
  const unknown = opts.toolIds.filter((id) => !getTool(id));
  for (const id of unknown) warnings.push(`Unknown tool "${id}" — ignored.`);

  const tools = opts.toolIds.map(getTool).filter((t): t is ToolDef => Boolean(t));
  const facts = await detectProject(opts.root);
  const ctx: SkeletonContext = { projectName: facts.name, today: todayISO() };
  const files: InitResult['files'] = [];
  const write = async (relPath: string, content: string): Promise<void> => {
    const abs = path.join(opts.root, relPath);
    if (opts.dryRun) {
      files.push({ path: relPath, action: (await pathExists(abs)) ? 'kept' : 'created' });
      return;
    }
    const created = await writeIfMissing(abs, content);
    files.push({ path: relPath, action: created ? 'created' : 'kept' });
  };

  for (const f of aiSkeleton(ctx)) await write(f.path, f.content);

  for (const { toolId, def } of ruleFilesFor(tools.map((t) => t.id))) {
    const abs = path.join(opts.root, def.path);
    const existing = await readFileSafe(abs);
    const alsoReadBy = tools
      .filter((t) => t.id !== toolId && t.ruleFiles.some((f) => f.path === def.path))
      .map((t) => t.id);
    if (existing && !opts.force) {
      if (!opts.dryRun) {
        await writeFile(abs, renderRuleFile(def, { projectName: facts.name, alsoReadBy }, existing));
      }
      files.push({ path: def.path, action: 'kept' });
      continue;
    }
    await write(def.path, renderRuleFile(def, { projectName: facts.name, alsoReadBy }, existing ?? undefined));
  }

  const bank = await loadMemory(opts.root);
  await materializeSkillSinks(opts.root, bank, tools);

  const bootstrap = buildBootstrapPrompt({ facts, tools, notes: opts.notes });
  const bootstrapPath = '.engram/BOOTSTRAP.md';
  const bootstrapAbs = path.join(opts.root, bootstrapPath);
  const existingBootstrap = await readFileSafe(bootstrapAbs);
  const bootstrapAction = classifyWrite(existingBootstrap, bootstrap);
  if (!opts.dryRun && bootstrapAction !== 'kept') await writeFile(bootstrapAbs, bootstrap);
  files.push({ path: bootstrapPath, action: opts.dryRun ? 'created' : bootstrapAction });

  if (facts.existingRuleFiles.length && !opts.force) {
    warnings.push(
      `Existing rule file(s) preserved, contract appended only: ${facts.existingRuleFiles.join(', ')}`,
    );
  }

  return { files, tools, bootstrapPath, warnings };
}

/** Copy canonical `.ai/skills/*.md` into every tool-native skill/command directory. */
export async function materializeSkillSinks(
  root: string,
  bank: MemoryBank,
  tools: ToolDef[],
): Promise<string[]> {
  const written: string[] = [];
  const specs = SKILL_SPECS.filter((s) => bank.skills.includes(`${s.name}.md`));
  if (specs.length === 0) return written;
  for (const tool of tools) {
    for (const sink of tool.skillSinks) {
      for (const file of materialize(sink, specs)) {
        await writeFile(path.join(root, file.path), file.content);
        written.push(file.path);
      }
    }
  }
  return written;
}

export interface SyncResult {
  ruleFiles: { path: string; action: 'updated' | 'unchanged' }[];
  skills: string[];
  missingSkills: string[];
}

/** Write classification shared by every generated artifact. */
function classifyWrite(existing: string | null, next: string): 'created' | 'updated' | 'kept' {
  if (existing === null) return 'created';
  return existing === next ? 'kept' : 'updated';
}

export async function runSync(root: string, toolIds: string[]): Promise<SyncResult> {
  const bank = await loadMemory(root);
  const tools = (toolIds.length ? toolIds.map(getTool) : TOOLS).filter((t): t is ToolDef => Boolean(t));
  const ruleFiles: SyncResult['ruleFiles'] = [];
  for (const { def } of ruleFilesFor(tools.map((t) => t.id))) {
    const abs = path.join(root, def.path);
    const existing = await readFileSafe(abs);
    if (existing === null) {
      ruleFiles.push({ path: def.path, action: 'unchanged' });
      continue;
    }
    const next = refreshContract(existing, def);
    if (next !== existing) await writeFile(abs, next);
    ruleFiles.push({ path: def.path, action: next === existing ? 'unchanged' : 'updated' });
  }
  const written = await materializeSkillSinks(root, bank, tools);
  const missing = SKILL_SPECS.filter((s) => !bank.skills.includes(`${s.name}.md`)).map((s) => s.name);
  return { ruleFiles, skills: written, missingSkills: missing };
}

export { commandNameFor, toolSummary };