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
import {
  detectProject,
  isDir,
  listIfPresent,
  pathExists,
  readFileSafe,
  todayISO,
  writeFile,
  writeFileGuarded,
  writeIfMissing,
} from '../core/project.js';
import { readSections, sectionTarget, type CustomSection } from '../core/sections.js';
import { readSkillSources, SKILLS_DIR, type SkillSource } from '../core/skill-source.js';
import type { ContractExtensions, ContractRow } from '../templates/contract.js';

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
  // `readFileSafe` swallows EISDIR, so a *directory* at this path read as "absent" and the report
  // said `created` for a file that was never written. A false success is worse than a refusal.
  if (await isDir(abs)) return 'skipped';
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
  if (await isDir(abs)) return 'skipped';
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
  // Project-owned input: engram reads it and never writes it, so a bad declaration degrades to a
  // warning instead of blocking the run.
  const { sections, warnings: sectionWarnings } = await readSections(opts.root);
  warnings.push(...sectionWarnings);
  const extensions = contractExtensions(sections);
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
    const ctxRender = { projectName: facts.name, alsoReadBy, extensions };

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

  // Read *after* the skeleton is written: on a fresh init the canonical skills did not exist a
  // moment ago, and reading them earlier is what silently produced no carriers at all.
  const { skills, warnings: skillWarnings, dirExists } = await readSkillSources(opts.root);
  warnings.push(...skillWarnings);
  // An absent directory means "this init just wrote the built-ins"; an empty one means the project
  // deleted them, and resurrecting carriers for those would be the wrong kind of helpful.
  await materializeSkillSinks(opts.root, skills.length === 0 && !dirExists ? SKILL_SPECS : skills, tools, dryRun);

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

/**
 * Turn project-declared sections into the contract rows every rule file will carry.
 *
 * This is the whole extension mechanism in one function: the project owns `.ai/sections.json`,
 * engram owns the rendering, and `sync` pushes the result into every tool's rule file at once
 * instead of the user repeating a row in eight files that then drift apart.
 */
export function contractExtensions(sections: readonly CustomSection[]): ContractExtensions {
  const read: ContractRow[] = [];
  const write: ContractRow[] = [];
  for (const s of sections) {
    const target = sectionTarget(s);
    read.push({ label: s.trigger, target });
    if (s.writeWhen) write.push({ label: s.writeWhen, target });
  }
  return { read, write };
}

/**
 * Fill in the built-in argument hint for a skill that does not declare one.
 *
 * The canonical `.ai/skills/*.md` files carry only `name` and `description` — the argument hint is
 * a prompt-template detail that never belonged in the portable spec. But the prompt sinks *do* use
 * it, so reading the directory as the source of truth silently downgraded every built-in carrier's
 * `argument-hint` to the neutral placeholder. Falling back by name keeps the generated output
 * identical to what it was before the directory became authoritative, without adding a field to
 * files that already exist in every repository (which `init` never clobbers).
 */
export function withBuiltinArgumentHints(skills: readonly SkillSource[]): SkillSource[] {
  return skills.map((s) => {
    if (s.argumentHint) return s;
    const spec = SKILL_SPECS.find((b) => b.name === s.name);
    return spec ? { ...s, argumentHint: spec.argumentHint } : s;
  });
}

/**
 * Copy every canonical `.ai/skills/*.md` into every tool-native skill/command directory.
 *
 * The canonical directory is the source of truth, not the in-code `SKILL_SPECS`: a project that
 * adds `.ai/skills/nightly.md` gets it materialised on the next `sync`. Unparseable files are
 * reported by `readSkillSources` and simply do not get a carrier.
 */
export async function materializeSkillSinks(
  root: string,
  skills: readonly SkillSource[],
  tools: ToolDef[],
  dryRun = false,
): Promise<{ written: string[]; refused: string[] }> {
  const written: string[] = [];
  const refused: string[] = [];
  const resolved = withBuiltinArgumentHints(skills);
  if (resolved.length === 0) return { written, refused };
  for (const tool of tools) {
    for (const sink of tool.skillSinks) {
      for (const file of materialize(sink, resolved)) {
        if (!dryRun && !(await writeFileGuarded(root, path.join(root, file.path), file.content))) {
          // A symlinked carrier directory is a real setup (people redirect generated dirs into a
          // shared location). Refusing to write is the only safe answer, but it must be loud.
          refused.push(file.path);
          continue;
        }
        written.push(file.path);
      }
    }
  }
  return { written, refused };
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
  /** Section names declared in `.ai/sections.json`, for reporting. */
  declaredSections: string[];
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
      declaredSections: [],
    };
  }

  // `loadMemory` is no longer needed here: both facts this used to supply (`bank.exists` and the
  // skill list) are now cheaper and more honest as direct checks — `needsInit` is "does `.ai/`
  // exist", and the skills come from the canonical directory itself, which is the source of truth.
  const needsInit = !(await isDir(path.join(root, '.ai')));
  const { sections, warnings: sectionWarnings } = await readSections(root);
  const { skills, warnings: skillWarnings, authoritative, unresolved } = await readSkillSources(root);
  warnings.push(...sectionWarnings, ...skillWarnings);
  const extensions = contractExtensions(sections);
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
    const next = refreshContract(existing, def, extensions);
    if (next.health !== 'ok') {
      warnings.push(`${def.path}: ${next.note ?? 'left untouched'}`);
      ruleFiles.push({ path: def.path, action: 'skipped' });
      continue;
    }
    if (next.content !== existing && !dryRun) await writeFile(abs, next.content);
    ruleFiles.push({ path: def.path, action: next.content === existing ? 'unchanged' : 'updated' });
  }

  const { written, refused } = await materializeSkillSinks(root, skills, tools, dryRun);
  for (const rel of refused) warnings.push(`${rel}: refusing to write through a symlinked directory — nothing outside the project is modified`);
  // Only a *readable* `.ai/skills/` is authority to call a carrier an orphan. `.ai/` existing is not
  // enough: delete or chmod `.ai/skills/` and the carriers become the only copy of every skill body,
  // so pruning on an empty list would destroy the last copy of the thing it is comparing against.
  // The retired-sink branch below runs unconditionally and is safe by construction: a fixed list of
  // built-in names, and only files carrying engram's own generated header.
  // A file that exists but did not parse still *exists*: the user is mid-edit, not deleting. Counting
  // only the successfully parsed names made a `chmod` or a frontmatter typo delete that skill's
  // carriers in every tool directory — the only remaining copy of the body.
  const canonicalNames = [...skills.map((s) => s.name), ...unresolved];
  const pruned = (
    await pruneStaleCarriers(root, tools, canonicalNames, { dryRun, skillsDirAuthoritative: authoritative })
  ).removed;
  const missing = SKILL_SPECS.filter((s) => !skills.some((x) => x.name === s.name)).map((s) => s.name);
  if (needsInit) warnings.push('No .ai/ memory bank here — run `engram init` first.');
  else if (!authoritative) warnings.push(`Cannot read ${SKILLS_DIR}/ — carriers left alone (pruning needs a readable source of truth).`);
  if (resolved.scope === 'inferred') {
    warnings.push(`No ${CONFIG_PATH} yet — recorded the tool set found on disk: ${resolved.toolIds.join(', ')}.`);
  }
  return {
    ruleFiles,
    skills: written,
    missingSkills: missing,
    pruned,
    warnings,
    scope: resolved.scope,
    needsInit,
    declaredSections: sections.map((s) => s.name),
  };
}

export { commandNameFor, toolSummary };