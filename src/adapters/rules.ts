import {
  CONTRACT_END,
  CONTRACT_START,
  GENERATED_MARKER,
  MANAGED_MARKER,
  inspectMarkers,
  replaceContractBlock,
  withContract,
  withoutContract,
} from '../templates/contract.js';
import type { RuleFileDef, RuleFileKind } from './index.js';

export interface RuleRenderContext {
  projectName: string;
  /** Sibling tools sharing the same file, e.g. AGENTS.md → codex, pi. */
  alsoReadBy: string[];
}

const TODO_BLOCK = (projectName: string): string => `# ${projectName} — agent instructions

<!-- engram:todo v1 -->
**This section is a placeholder.** Open \`.engram/BOOTSTRAP.md\` and let your AI assistant author
this file for your real project (stack, commands, conventions, boundaries), then delete this block.

A good replacement contains, in this order:
1. Build / run / test commands, copy-pasteable, with how to run a single test.
2. Directory map with one line of responsibility each.
3. Hard conventions: naming, error handling, forbidden operations.
4. Definition of done: what must pass before a change is considered complete.
<!-- /engram:todo -->`;

/**
 * Claude Code's @-import is deliberately NOT used for the bank.
 *
 * An `@.ai/README.md` line is not a pointer: Claude loads the target in full, every session —
 * roughly 6.5 KB of always-on context, ~2,300 tokens — on top of the contract itself. That is
 * exactly what the contract tells the model not to do ("read on demand, never paste wholesale").
 * These stubs name the files and the trigger instead.
 */
const CLAUDE_POINTERS = [
  '> Memory lives in `.ai/`. Read on demand with file tools, never wholesale:',
  '> `.ai/CURRENT_TASK.md` (state), `.ai/ARCHITECTURE.md` (boundaries),',
  '> `.ai/decisions/` (binding), `.ai/skills/` (actions).',
];

/** Only these tool formats have YAML frontmatter that must stay the very first bytes. */
const NEEDS_FRONTMATTER = new Set<RuleFileKind>(['cursor', 'windsurf', 'copilot']);

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;
const SHARED_LINE_RE = /^_Read by: .*_$/m;

/** Frontmatter engram generates for a rule file that does not have one yet. */
function defaultFrontmatter(def: RuleFileDef): string {
  switch (def.kind) {
    case 'cursor':
      // With alwaysApply, Cursor ignores globs and description. Emitting them anyway is noise.
      return ['---', 'alwaysApply: true', '---', ''].join('\n');
    case 'windsurf':
      return ['---', 'trigger: always_on', '---', ''].join('\n');
    case 'copilot':
      return def.path.includes('/instructions/') ? ['---', 'applyTo: "**"', '---', ''].join('\n') : '';
    default:
      return '';
  }
}

/**
 * Merge engram's defaults into *existing* frontmatter, key by key.
 *
 * A user's narrowed `globs` scope or `alwaysApply: false` is a deliberate decision. Silently
 * promoting it to an always-on global rule is data loss with no warning, so existing keys win.
 */
function mergeFrontmatter(existing: string, defaults: string): string {
  // No defaults to merge (e.g. `.github/copilot-instructions.md`, which has no frontmatter at
  // all) means there is no frontmatter to emit. Returning `existing` here would splice the whole
  // file back in ahead of the body and duplicate it on every render — the marker count is what
  // exposed it: 1 → 3 after a few runs.
  if (!defaults.trim()) return '';
  const parsed = FRONTMATTER_RE.exec(existing);
  if (!parsed) return defaults;
  const keys = new Set(
    (parsed[1] ?? '')
      .split('\n')
      .map((l) => /^([A-Za-z0-9_-]+)\s*:/.exec(l)?.[1])
      .filter((k): k is string => Boolean(k)),
  );
  const additions = defaults
    .replace(/^---\n/, '')
    .replace(/\n---\n?$/, '')
    .split('\n')
    .filter((l) => l.trim() && !keys.has(/^([A-Za-z0-9_-]+)\s*:/.exec(l)?.[1] ?? ''));
  // Always return *only* the frontmatter block. Returning the whole file here silently duplicated
  // the entire body on the next render.
  const merged = `${parsed[1] ?? ''}${additions.length ? `\n${additions.join('\n')}` : ''}`;
  return `---\n${merged.trim()}\n---\n`;
}

export type RuleHealth = 'ok' | 'unbalanced-markers';

export interface RuleRenderResult {
  content: string;
  health: RuleHealth;
  /** Human-facing explanation when `health !== 'ok'`. */
  note?: string;
}

/**
 * Render a full rule file: frontmatter + authored body + the engram contract.
 *
 * `existing` content is preserved: its frontmatter keys, its body, and anything engram does not own.
 * Only the contract block, the managed marker and the shared-reader note are regenerated.
 *
 * When the input carries an unbalanced contract marker the file is returned **byte-identical**:
 * engram cannot repair it safely, so it reports instead of guessing.
 */
export function renderRuleFile(
  def: RuleFileDef,
  ctx: RuleRenderContext,
  existing?: string,
): RuleRenderResult {
  if (existing && inspectMarkers(existing).health === 'unbalanced') {
    return {
      content: existing,
      health: 'unbalanced-markers',
      note: `unbalanced contract marker (${countMarkers(existing)}); left untouched — remove the stray \`${CONTRACT_START}\` or \`${CONTRACT_END}\` line and re-run`,
    };
  }

  const isAuthored = Boolean(existing && existing.trim());
  let body: string;
  let head: string;

  if (isAuthored) {
    const current = existing ?? '';
    head = NEEDS_FRONTMATTER.has(def.kind) ? mergeFrontmatter(current, defaultFrontmatter(def)) : '';
    const stripped = current
      .replace(NEEDS_FRONTMATTER.has(def.kind) ? FRONTMATTER_RE : /^$/, '')
      .replace(SHARED_LINE_RE, '')
      .replaceAll(MANAGED_MARKER, '');
    body = withoutContract(stripped);
  } else {
    head = defaultFrontmatter(def);
    body = def.kind === 'claude' ? `${TODO_BLOCK(ctx.projectName)}\n\n${CLAUDE_POINTERS.join('\n')}` : TODO_BLOCK(ctx.projectName);
  }

  const shared = ctx.alsoReadBy.length > 0 ? `\n\n_Read by: ${ctx.alsoReadBy.join(', ')}._` : '';
  const composed = `${head}${body.trim()}${shared}`.trim();
  return { content: withContract(`${composed}\n\n${MANAGED_MARKER}`), health: 'ok' };
}

/** Convenience wrapper for callers that only need the text (tests, `--dry-run`). */
export function renderRuleText(
  def: RuleFileDef,
  ctx: RuleRenderContext,
  existing?: string,
): string {
  return renderRuleFile(def, ctx, existing).content;
}

/**
 * Replace the contract block of an existing file in place.
 * This is the *only* implementation of that splice; `renderRuleFile` composes, never splices.
 */
export function refreshContract(existing: string, def: RuleFileDef): RuleRenderResult {
  if (inspectMarkers(existing).health === 'unbalanced') {
    return {
      content: existing,
      health: 'unbalanced-markers',
      note: `unbalanced contract marker (${countMarkers(existing)}); left untouched — remove the stray \`${CONTRACT_START}\` or \`${CONTRACT_END}\` line and re-run`,
    };
  }
  if (inspectMarkers(existing).health === 'absent') {
    // No block yet: adopt the file, preserving everything that is already there.
    return renderRuleFile(def, { projectName: 'this project', alsoReadBy: [] }, existing);
  }
  return { content: replaceContractBlock(existing), health: 'ok' };
}

/** Header stamped on fully generated files (skill sinks) so they can be safely overwritten. */
export function generatedHeader(sourcePath: string): string {
  return `${GENERATED_MARKER} generated by engram from ${sourcePath} — do not edit; run \`engram sync\``;
}

function countMarkers(text: string): string {
  const report = inspectMarkers(text);
  return `${report.starts} start / ${report.ends} end`;
}