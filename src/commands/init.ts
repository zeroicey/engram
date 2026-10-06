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
import { getTool, ruleFilesFor, allToolIds, type ToolDef } from '../adapters/index.js';
import { commandNameFor, materialize } from '../adapters/skills.js';
import { pruneStaleCarriers } from './prune-carriers.js';
import { CONFIG_PATH, inferToolsFromDisk, knownTools, readConfig, writeConfig } from '../core/config.js';
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

/**
 * Write **only if absent**. Used for every file inside `.ai/`.
 *
 * The bank belongs to the user, not to engram. An earlier version used one `writeOnce` helper for
 * everything, which overwrote any file whose content differed from the template — so running
 * `engram init` on this repository replaced its hand-written CURRENT_TASK.md and ARCHITECTURE.md
 * with placeholders, and the damage landed in a commit. For a tool whose entire promise is "your
 * memory survives", that is the worst possible bug, and it needs a separate code path rather than
 * a shared one.
 */
async function writeNeverClobber(
  root: string,
  relPath: string,
  content: string,
  dryRun: boolean,
): Promise<WriteAction> {
  const abs = path.join(root, relPath);
  const existing = await readFileSafe(abs);
  if (existing !== null) return 'kept';
  if (!dryRun) await writeIfMissing(abs, content);
  return 'created';
}

/** Write when the content differs. Only for files engram owns end-to-end. */
async function writeGenerated(
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
  const facts = await detectProject(opts.root, ruleFilePaths(tools));
  const ctx: SkeletonContext = { projectName: facts.name, today: todayISO() };
  const files: InitResult['files'] = [];
  const dryRun = opts.dryRun === true;

  for (const f of aiSkeleton(ctx)) {
    files.push({ path: f.path, action: await writeNeverClobber(opts.root, f.path, f.content, dryRun) });
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
      files.push({ path: def.path, action: await writeGenerated(opts.root, def.path, stub, dryRun) });
      continue;
    }

    const rendered = renderRuleFile(def, ctxRender, existing ?? undefined);
    if (rendered.health !== 'ok') {
      warnings.push(`${def.path}: ${rendered.note ?? 'left untouched'}`);
      files.push({ path: def.path, action: 'skipped' });
      continue;
    }
    const action = await writeGenerated(opts.root, def.path, rendered.content, dryRun);
    files.push({ path: def.path, action: existing === null ? 'created' : action });
    void abs;
  }

  const bank = await loadMemory(opts.root);
  await materializeSkillSinks(opts.root, bank, tools);

  const bootstrap = buildBootstrapPrompt({ facts, tools, notes: opts.notes });
  const bootstrapPath = '.engram/BOOTSTRAP.md';
  files.push({ path: bootstrapPath, action: await writeGenerated(opts.root, bootstrapPath, bootstrap, dryRun) });

  // The tool set is a user decision; `sync` must inherit it instead of re-deciding "all tools".
  // Written through `writeGenerated` alone: a second `writeConfig` call would turn the very
  // first init into a `kept` action and make "everything is created" untrue.
  const toolIds = tools.map((t) => t.id);
  if (toolIds.length > 0) {
    const content = `${JSON.stringify({ version: 1, tools: toolIds }, null, 2)}\n`;
    files.push({ path: CONFIG_PATH, action: await writeGenerated(opts.root, CONFIG_PATH, content, dryRun) });
  }

  if (facts.existingRuleFiles.length && !opts.force) {
    warnings.push(
      `Existing rule file(s) preserved, contract appended only: ${facts.existingRuleFiles.join(', ')}`,
    );
  }

  return { files, tools, bootstrapPath, warnings };
}

/** Every rule-file path the selected tools know about, de-duplicated. */
export function ruleFilePaths(tools: ToolDef[]): string[] {
  return [...new Set(tools.flatMap((t) => t.ruleFiles.map((f) => f.path)))];
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
  /** Generated carriers removed because the recorded tool set no longer claims their dir. */
  pruned: string[];
  /** Where the tool scope came from: config, disk inference, or an explicit flag. */
  scope: 'config' | 'inferred' | 'flags' | 'all-tools';
  /** True when the repository has never been initialised. */
  needsInit: boolean;
}

/**
 * Which tools this sync is allowed to write.
 *
 * Precedence: explicit `--tools`, then `--all`, then the set recorded by `init`, then what the
 * disk already looks like. Only when nothing at all is on disk does it fall back to every tool —
 * and that fallback is what used to run unconditionally, silently generating carriers for eight
 * agents in a repo that asked for one.
 */
export async function resolveSyncTools(
  root: string,
  explicit: string[],
  dryRun = false,
): Promise<{ toolIds: string[]; scope: SyncResult['scope'] }> {
  if (explicit.length > 0) return { toolIds: knownTools(explicit), scope: 'flags' };
  const config = await readConfig(root);
  if (config) return { toolIds: config.tools, scope: 'config' };
  const inferred = await inferToolsFromDisk(root);
  if (inferred.length > 0) {
    if (!dryRun) await writeConfig(root, inferred);
    return { toolIds: inferred, scope: 'inferred' };
  }
  return { toolIds: allToolIds(), scope: 'all-tools' };
}

export async function runSync(root: string, toolIds: string[] = [], dryRun = false, all = false): Promise<SyncResult> {
  const warnings: string[] = [];
  const unknown = toolIds.filter((id) => !getTool(id));
  for (const id of unknown) warnings.push(`Unknown tool "${id}" — ignored.`);
  if (toolIds.length > 0 && toolIds.length === unknown.length) {
    return {
      ruleFiles: [],
      skills: [],
      missingSkills: [],
      pruned: [],
      warnings,
      scope: 'flags',
      needsInit: true,
    };
  }

  const bank = await loadMemory(root);
  const needsInit = !bank.exists;
  const resolved = all
    ? { toolIds: allToolIds(), scope: 'all-tools' as const }
    : await resolveSyncTools(root, toolIds, dryRun);
  if (toolIds.length === 0 && resolved.toolIds.length === 0) {
    warnings.push('No valid tools recorded — pass --tools or run `engram init` again.');
  }
  const tools = resolved.toolIds.map(getTool).filter((t): t is ToolDef => Boolean(t));
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
  const pruned = (await pruneStaleCarriers(root, tools, dryRun)).removed;
  const missing = SKILL_SPECS.filter((s) => !bank.skills.includes(`${s.name}.md`)).map((s) => s.name);
  if (needsInit) warnings.push('No .ai/ memory bank here — run `engram init` first.');
  if (resolved.scope === 'inferred') {
    warnings.push(`No ${CONFIG_PATH} yet — recorded the tool set found on disk: ${resolved.toolIds.join(', ')}.`);
  }
  return { ruleFiles, skills: written, missingSkills: missing, pruned, warnings, scope: resolved.scope, needsInit };
}

export { commandNameFor, toolSummary };