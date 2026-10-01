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
import { detectProject, readFileSafe, todayISO, writeIfMissing, writeFile } from '../core/project.js';
import type { MemoryBank } from '../core/memory.js';
import { loadMemory } from '../core/memory.js';

export interface InitOptions {
  root: string;
  toolIds: string[];
  notes?: string;
  /** Overwrite generated rule files instead of preserving existing bodies. */
  force?: boolean;
  dryRun?: boolean;
} export type WriteAction = 'created' | 'kept' | 'updated' | 'missing' | 'skipped';

export interface InitResult {
  files: { path: string; action: WriteAction }[];
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

async function writeOnce(
  root: string,
  relPath: string,
  content: string,
  dryRun: boolean,
): Promise<WriteAction> {
  const abs = path.join(root, relPath);
  const existing = await readFileSafe(abs);
  if (dryRun) return existing === null ? 'created' : existing === content ? 'kept' : 'updated';
  if (existing === null) {
    await writeIfMissing(abs, content);
    return 'created';
  }
  if (existing === content) return 'kept';
  await writeFile(abs, content);
  return 'updated';
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const warnings: string[] = [];
  const unknown = opts.toolIds.filter((id) => !getTool(id));
  for (const id of unknown) warnings.push(`Unknown tool "${id}" — ignored.`);

  const tools = opts.toolIds.map(getTool).filter((t): t is ToolDef => Boolean(t));
  if (tools.length === 0) {
    warnings.push('No valid tools selected — the .ai/ bank was created, but no rule file was written.');
  }
  const facts = await detectProject(opts.root);
  const ctx: SkeletonContext = { projectName: facts.name, today: todayISO() };
  const files: InitResult['files'] = [];
  const dryRun = opts.dryRun === true;

  for (const f of aiSkeleton(ctx)) {
    files.push({ path: f.path, action: await writeOnce(opts.root, f.path, f.content, dryRun) });
  }

  for (const { toolId, def } of ruleFilesFor(tools.map((t) => t.id))) {
    const abs = path.join(opts.root, def.path);
    const existing = await readFileSafe(abs);
    const alsoReadBy = tools
      .filter((t) => t.id !== toolId && t.ruleFiles.some((f) => f.path === def.path))
      .map((t) => t.id);
    const ctxRender = { projectName: facts.name, alsoReadBy };

    if (opts.force) {
      // --force means "regenerate from the stub": the previous content is intentionally discarded.
      const stub = renderRuleFile(def, ctxRender).content;
      files.push({ path: def.path, action: await writeOnce(opts.root, def.path, stub, dryRun) });
      continue;
    }

    const rendered = renderRuleFile(def, ctxRender, existing ?? undefined);
    if (rendered.health !== 'ok') {
      warnings.push(`${def.path}: ${rendered.note ?? 'left untouched'}`);
      files.push({ path: def.path, action: 'skipped' });
      continue;
    }
    const action = await writeOnce(opts.root, def.path, rendered.content, dryRun);
    files.push({ path: def.path, action: existing === null ? 'created' : action });
    void abs;
  }

  const bank = await loadMemory(opts.root);
  await materializeSkillSinks(opts.root, bank, tools);

  const bootstrap = buildBootstrapPrompt({ facts, tools, notes: opts.notes });
  const bootstrapPath = '.engram/BOOTSTRAP.md';
  files.push({ path: bootstrapPath, action: await writeOnce(opts.root, bootstrapPath, bootstrap, dryRun) });

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
  dryRun = false,
): Promise<string[]> {
  const written: string[] = [];
  const specs = SKILL_SPECS.filter((s) => bank.skills.includes(`${s.name}.md`));
  if (specs.length === 0) return written;
  for (const tool of tools) {
    for (const sink of tool.skillSinks) {
      for (const file of materialize(sink, specs)) {
        if (!dryRun) await writeFile(path.join(root, file.path), file.content);
        written.push(file.path);
      }
    }
  }
  return written;
}

export interface SyncResult {
  ruleFiles: { path: string; action: 'updated' | 'unchanged' | 'missing' | 'skipped' }[];
  skills: string[];
  missingSkills: string[];
  warnings: string[];
  /** True when the repository has never been initialised. */
  needsInit: boolean;
}

export async function runSync(root: string, toolIds: string[], dryRun = false): Promise<SyncResult> {
  const warnings: string[] = [];
  const unknown = toolIds.filter((id) => !getTool(id));
  for (const id of unknown) warnings.push(`Unknown tool "${id}" — ignored.`);
  if (toolIds.length > 0 && toolIds.length === unknown.length) {
    return {
      ruleFiles: [],
      skills: [],
      missingSkills: [],
      warnings,
      needsInit: true,
    };
  }

  const bank = await loadMemory(root);
  const needsInit = !bank.exists;
  const tools = (toolIds.length ? toolIds.map(getTool) : TOOLS).filter((t): t is ToolDef => Boolean(t));
  const ruleFiles: SyncResult['ruleFiles'] = [];

  for (const { def } of ruleFilesFor(tools.map((t) => t.id))) {
    const abs = path.join(root, def.path);
    const existing = await readFileSafe(abs);
    if (existing === null) {
      // Reporting "unchanged" for a file that does not exist is a lie an agent will believe.
      ruleFiles.push({ path: def.path, action: 'missing' });
      continue;
    }
    const next = refreshContract(existing, def);
    if (next.health !== 'ok') {
      warnings.push(`${def.path}: ${next.note ?? 'left untouched'}`);
      ruleFiles.push({ path: def.path, action: 'skipped' });
      continue;
    }
    if (next.content !== existing && !dryRun) await writeFile(abs, next.content);
    ruleFiles.push({ path: def.path, action: next.content === existing ? 'unchanged' : 'updated' });
  }

  const written = await materializeSkillSinks(root, bank, tools, dryRun);
  const missing = SKILL_SPECS.filter((s) => !bank.skills.includes(`${s.name}.md`)).map((s) => s.name);
  if (needsInit) warnings.push('No .ai/ memory bank here — run `engram init` first.');
  return { ruleFiles, skills: written, missingSkills: missing, warnings, needsInit };
}

export { commandNameFor, toolSummary };