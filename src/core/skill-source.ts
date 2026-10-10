/**
 * Read `.ai/skills/*.md` as materialisable skill sources.
 *
 * Before this existed, `sync` only ever materialised the four built-in skills: `SKILL_SPECS` was
 * the sole input, so a project-authored `.ai/skills/nightly.md` was silently ignored and the only
 * way to get it into a tool was to hand-write the carrier — which `sync` then treated as an
 * orphan. The bank is supposed to be the project's, so the canonical directory is now the source
 * of truth and the built-in specs are just its first four files.
 *
 * Deliberately dependency-free: frontmatter is parsed by hand, the same way `yamlScalar` writes it.
 * A file that cannot be parsed produces a warning naming the fix, never an exception — one bad
 * skill must not stop `sync` from refreshing the contract.
 */

import path from 'node:path';
import { isDir, isTemplateName, listIfPresent, readIfPresent } from './project.js';

export interface SkillSource {
  name: string;
  description: string;
  /** Optional; the prompt-template sinks substitute it as the command's argument hint. */
  argumentHint?: string;
  body: string;
}

export interface SkillSourcesResult {
  skills: SkillSource[];
  warnings: string[];
  /**
   * Whether `.ai/skills/` exists at all.
   *
   * Callers need this to tell "fresh repository, the built-ins are about to be written" apart from
   * "the directory exists and the project emptied it on purpose". Treating both as empty would
   * resurrect carriers for skills a project deliberately deleted.
   */
  dirExists: boolean;
  /**
   * Whether the skill list can be trusted as the complete truth.
   *
   * `false` means the directory is missing or unreadable, so an empty `skills` array means "unknown",
   * not "none". The destructive caller (`pruneStaleCarriers`) must refuse to act on an untrusted
   * list: with `.ai/skills/` gone, the carriers are the only remaining copy of every skill body.
   */
  authoritative: boolean;
  /**
   * Stems of files that are present but did not parse (unreadable, bad frontmatter, name mismatch).
   *
   * These must count as *existing* skills for pruning purposes. A file engram cannot parse is a file
   * the user is mid-edit on, not a deletion — and treating it as absent made `sync` delete the
   * carriers of every tool, i.e. the only remaining copy of the skill body, on a `chmod` or a typo.
   */
  unresolved: string[];
}

export const SKILLS_DIR = '.ai/skills';

/** Skill names follow the Agent Skills rule, which is also DSH's `isSkillName`. */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m;

/**
 * Strip a UTF-8 BOM before parsing.
 *
 * `readFile(..., 'utf8')` keeps the BOM as `\uFEFF`, which is not whitespace and therefore stops
 * `^---` from matching at position 0 — a file that looks perfectly correct to the user was
 * reported as having no frontmatter at all. Windows editors and PowerShell's `>` redirection add
 * one routinely.
 */
const stripBom = (raw: string): string => (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);

/**
 * YAML block-scalar indicators (`>` folded, `|` literal).
 *
 * `description: >` with indented continuation lines parsed as the literal string `">"` and dropped
 * the continuation, so the skill loaded with a routing signal of `>` instead of its description —
 * silently. Full block-scalar support is not worth hand-rolling here; refusing the value and saying
 * so is honest, and the one-line form is what engram itself writes.
 */
const BLOCK_SCALAR_RE = /^[|>][-+]?\d*$/;

/** Marks a field whose value was a block scalar, so the caller can reject it by name. */
const BLOCK_KEY_PREFIX = '__block__';

/** Undo the quoting `yamlScalar` writes, and tolerate plain or double-quoted user input. */
function unquote(value: string): string {
  const t = value.trim();
  if (t.length > 1 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replaceAll("''", "'");
  if (t.length > 1 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return t;
}

function fields(frontmatter: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on `\r?\n`, not `\n`: JavaScript's `.` does not match `\r`, so a CRLF file left a
  // carriage return at the end of every line and `(.*)$` failed to match at all. A skill saved by a
  // Windows editor, or checked out with `core.autocrlf=true`, was reported as having no
  // description — the file was fine, the parser was not.
  for (const line of frontmatter.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m?.[1]) continue;
    const value = (m[2] ?? '').trim();
    // The real value lives on the following indented lines, which this parser does not read.
    if (BLOCK_SCALAR_RE.test(value)) {
      out[`${BLOCK_KEY_PREFIX}${m[1]}`] = '1';
      continue;
    }
    out[m[1]] = unquote(value);
  }
  return out;
}

export interface ParsedSkill {
  source: SkillSource | null;
  warning: string | null;
}

/** Parse one canonical skill file. The name is the file stem; frontmatter may restate it. */
export function parseSkillFile(file: string, raw: string): ParsedSkill {
  const stem = file.replace(/\.md$/, '');
  const text = stripBom(raw);
  const fm = FRONTMATTER_RE.exec(text);
  if (!fm) {
    return {
      source: null,
      warning: `${SKILLS_DIR}/${file}: no YAML frontmatter — add \`---\\nname: ${stem}\\ndescription: …\\n---\` to materialise it`,
    };
  }
  const data = fields(fm[1] ?? '');
  const name = data.name ?? stem;
  if (!NAME_RE.test(name)) {
    return { source: null, warning: `${SKILLS_DIR}/${file}: invalid skill name "${name}" — kebab-case only` };
  }
  if (name !== stem) {
    return {
      source: null,
      warning: `${SKILLS_DIR}/${file}: frontmatter name "${name}" does not match the file name — rename one of them`,
    };
  }
  for (const key of Object.keys(data)) {
    if (!key.startsWith(BLOCK_KEY_PREFIX)) continue;
    const field = key.slice(BLOCK_KEY_PREFIX.length);
    return {
      source: null,
      warning: `${SKILLS_DIR}/${file}: "${field}" uses a YAML block scalar (\`>\` or \`|\`), which is not supported — put the value on one line`,
    };
  }
  const description = data.description ?? '';
  if (!description.trim()) {
    return { source: null, warning: `${SKILLS_DIR}/${file}: "description" is required — it is the routing signal the model sees` };
  }
  // `text`, not `raw`: the slice index came from a match against the BOM-stripped string, so using
  // `raw` here would be off by one for a BOM'd file and eat the first body character.
  const body = text.slice(fm.index + fm[0].length).trim();
  const argumentHint = data['argument-hint']?.trim();
  return {
    source: { name, description, ...(argumentHint ? { argumentHint } : {}), body },
    warning: null,
  };
}

/**
 * Every canonical skill file, in stable name order.
 *
 * Unreadable files are reported rather than skipped silently: a skill that vanished from the
 * carriers because of an EACCES looks exactly like a skill the user deleted on purpose.
 */
export async function readSkillSources(root: string): Promise<SkillSourcesResult> {
  const dir = path.join(root, SKILLS_DIR);
  const dirExists = await isDir(dir);
  const listing = await listIfPresent(dir);
  const warnings: string[] = listing.error ? [listing.error] : [];
  // Unreadable and absent are both "cannot enumerate"; neither is evidence that a skill is gone.
  const authoritative = dirExists && !listing.error;
  const skills: SkillSource[] = [];

  const unresolved: string[] = [];
  for (const file of listing.names.filter((f) => f.endsWith('.md') && !isTemplateName(f)).sort()) {
    const read = await readIfPresent(path.join(dir, file));
    if (read.error) {
      warnings.push(read.error);
      unresolved.push(file.replace(/\.md$/, ''));
      continue;
    }
    const parsed = parseSkillFile(file, read.text ?? '');
    if (parsed.warning) warnings.push(parsed.warning);
    if (parsed.source) skills.push(parsed.source);
    else unresolved.push(file.replace(/\.md$/, ''));
  }
  return { skills, warnings, dirExists, authoritative, unresolved };
}
