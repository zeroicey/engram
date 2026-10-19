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
import { TOOLS, ruleFiles, RETIRED_RULE_FILES, type ToolDef } from '../adapters/index.js';
import { commandNameFor, materialize } from '../adapters/skills.js';
import { pruneStaleCarriers } from './prune-carriers.js';
import { syncGoalCarrier, type GoalCarrierResult } from './goal-carrier.js';
import { GOAL_EXTENSION_PATH } from '../templates/goal-extension.js';
import { CONFIG_PATH, goalEnabled, isLegacyConfig, readConfig, readConfigDetailed, writeConfig } from '../core/config.js';
import { VERSION } from '../version.js';
import { CONTEXT_REMINDER_PERCENT } from '../core/goal.js';
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
  if (!dryRun) return (await writeFileGuarded(root, abs, content)) ? 'created' : 'skipped';
  return 'created';
}

/** Write when the content differs. Only for files engram owns end-to-end. */
/**
 * Create a file if it is absent, and leave it alone forever after.
 *
 * For files whose content a later engram command also writes: `init` owns only their existence. The
 * difference from `writeGenerated` is the whole point — that one replaces content it did not write, which
 * is right for a scaffold it owns and wrong for a file another command owns fields in.
 */
async function writeOnce(
  root: string,
  relPath: string,
  content: string,
  dryRun: boolean,
): Promise<WriteAction> {
  const abs = path.join(root, relPath);
  if (await isDir(abs)) return 'skipped';
  if (await pathExists(abs)) return 'kept';
  if (dryRun) return 'created';
  // Guarded, not raw. `pathExists` uses `fs.stat`, which FOLLOWS a symlink and reports `false` for a
  // *dangling* one — so this branch then wrote through the link and created the file at the external
  // target. Measured: `ln -s /tmp/outside/pwned.json .engram/config.json; engram init` created
  // `/tmp/outside/pwned.json`. The same escape `writeFileGuarded` was written for on the skill carriers,
  // applied there and not here — a guarded writer next to an unguarded one is half a fix.
  if (!(await writeFileGuarded(root, abs, content))) return 'skipped';
  return 'created';
}

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
  // Every write here goes through the guarded writer, both the create and the replace branch. A raw
  // `fs.writeFile` follows a symlink, so an unguarded replace next to a guarded create would still let a
  // symlinked rule file overwrite something outside `--root` — the shape that shipped once already.
  if (existing !== null && existing === content) return 'kept';
  if (!(await writeFileGuarded(root, abs, content))) return 'skipped';
  return existing === null ? 'created' : 'updated';
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const warnings: string[] = [];
  // One tool, from the registry. There is no selection step any more: `--tools` was removed with the
  // other eight adapters, and a flag whose only legal value is "pi" is noise in `--help`.
  const tools = [...TOOLS];
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

  for (const def of ruleFiles()) {
    const abs = path.join(opts.root, def.path);
    const existing = await readFileSafe(abs);
    const ctxRender = { projectName: facts.name, extensions };

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

  // **Written once, never replaced.** The config holds fields `init` does not own — `goal.enabled` and
  // the `limits` block — so a re-run must not touch it. It used to go through `writeGenerated`, which
  // replaces content whenever it differs, and the comment above the call claimed the opposite. Measured
  // consequence: `init` → `config --goal on` → `init` wrote `{"version": 2}`, and the **next `sync` then
  // deleted `.pi/extensions/engram-goal.ts`** (`goalEnabled(...) === false` → `syncGoalCarrier(false)`).
  // A re-run silently disarmed the goal engine. This is the same invariant `setGoalEnabled` was fixed
  // for, one layer up: a write must never drop a field it does not own.
  const content = `${JSON.stringify({ version: 2 }, null, 2)}\n`;
  files.push({ path: CONFIG_PATH, action: await writeOnce(opts.root, CONFIG_PATH, content, dryRun) });

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
  // De-duplicated by path, because `.agents/skills` is claimed by two tools at once. Codex and Pi
  // both read it, so a project selecting both used to render every SKILL.md twice: identical
  // content, one wasted write per file, and a doubled count in `sync`'s "N skill files
  // materialised" line. The first claiming tool wins; the content does not depend on which.
  const seen = new Set<string>();
  for (const tool of tools) {
    for (const sink of tool.skillSinks) {
      for (const file of materialize(sink, resolved)) {
        if (seen.has(file.path)) continue;
        seen.add(file.path);
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
  /** Generated carriers removed because engram no longer writes that dir. */
  pruned: string[];
  /** True when the repository has never been initialised. */
  needsInit: boolean;
  /** Section names declared in `.ai/sections.json`, for reporting. */
  declaredSections: string[];
  /** The opt-in pi goal extension: what happened to `.pi/extensions/engram-goal.ts`. */
  goalCarrier: GoalCarrierResult;
  /** True when `.engram/config.json` opted into the goal engine. */
  goalEnabled: boolean;
}

export async function runSync(root: string, dryRun = false): Promise<SyncResult> {
  const warnings: string[] = [];

  // `loadMemory` is no longer needed here: both facts this used to supply (`bank.exists` and the
  // skill list) are now cheaper and more honest as direct checks — `needsInit` is "does `.ai/`
  // exist", and the skills come from the canonical directory itself, which is the source of truth.
  const needsInit = !(await isDir(path.join(root, '.ai')));
  const { sections, warnings: sectionWarnings } = await readSections(root);
  const { skills, warnings: skillWarnings, authoritative, unresolved } = await readSkillSources(root);
  warnings.push(...sectionWarnings, ...skillWarnings);
  const extensions = contractExtensions(sections);
  // One tool. There is no scope to resolve: `sync` writes what the registry declares, and a stored
  // tool set from an older engram is meaningless rather than wrong.
  const tools: ToolDef[] = [...TOOLS];
  const ruleFilesResult: SyncResult['ruleFiles'] = [];
  const legacy = await isLegacyConfig(root);
  if (legacy && !dryRun) {
    // A v1 config naming six clients is rewritten to v2 while preserving everything v2 still has a use
    // for: the goal opt-in **and** the `limits` block. Passing only the opt-in deleted a project's tuned
    // liveness deadline on the first `sync` — `writeConfig` emits `limits` only when it is given one, and
    // a v1 file is a legal place to have written it.
    const legacyCfg = await readConfig(root);
    await writeConfig(root, goalEnabled(legacyCfg), legacyCfg?.limits);
  }

  for (const def of ruleFiles()) {
    const abs = path.join(root, def.path);
    const existing = await readFileSafe(abs);
    if (existing === null) {
      // Reporting "unchanged" for a file that does not exist is a lie an agent will believe.
      ruleFilesResult.push({ path: def.path, action: 'missing' });
      continue;
    }
    const next = refreshContract(existing, def, extensions);
    if (next.health !== 'ok') {
      warnings.push(`${def.path}: ${next.note ?? 'left untouched'}`);
      ruleFilesResult.push({ path: def.path, action: 'skipped' });
      continue;
    }
    if (next.content !== existing && !dryRun) await writeFile(abs, next.content);
    ruleFilesResult.push({ path: def.path, action: next.content === existing ? 'unchanged' : 'updated' });
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
  // The goal engine is opt-in: it runs code at every settlement boundary, so it is a separate
  // consent from tool support — which, being Pi-only, is no longer a consent at all.
  // A config that exists but cannot be parsed is **not** an opt-out. `readConfig` collapses absent and
  // broken into `null`, and acting on that collapse DELETED the carrier: measured, truncating
  // `.engram/config.json` to `{"version":2,"goal":{"enabled":true},` made the next `sync` print
  // `removed .pi/extensions/engram-goal.ts (goal disabled)` — silently disarming an engine the project
  // had enabled. Same class as the round-1 P0, reached by corruption instead of by a second `init`.
  // Refuse to change the carrier and say why; the project decides whether to repair the file.
  const goalConfig = await readConfigDetailed(root);
  const wantsGoal = goalEnabled(goalConfig.config);
  const goalCarrier = goalConfig.broken
    ? {
        action: 'unchanged' as const,
        path: GOAL_EXTENSION_PATH,
        planned: false,
        note: `config is unreadable (${goalConfig.error ?? 'unknown error'}) — the goal carrier was left exactly as it is. Repair ${CONFIG_PATH} to change it.`,
      }
    : await syncGoalCarrier(
        root,
        wantsGoal,
        { engramBin: 'engram', version: VERSION, reminderPercent: CONTEXT_REMINDER_PERCENT },
        dryRun,
      );
  if (goalCarrier.note) warnings.push(`${goalCarrier.path}: ${goalCarrier.note}`);

  // Rule files left behind by a removed adapter are reported, not deleted: `init` preserves whatever
  // body a human added, so there is no marker that would make deletion safe. Silence would be worse
  // than either — the file keeps injecting a contract block that this `sync` no longer refreshes.
  for (const rel of RETIRED_RULE_FILES) {
    if (await pathExists(path.join(root, rel))) {
      warnings.push(`${rel}: belongs to a tool engram no longer supports; its contract block is no longer refreshed — delete it if unused`);
    }
  }

  return {
    ruleFiles: ruleFilesResult,
    skills: written,
    missingSkills: missing,
    pruned,
    warnings,
    needsInit,
    declaredSections: sections.map((s) => s.name),
    goalCarrier,
    goalEnabled: wantsGoal,
  };
}

export { commandNameFor, toolSummary };