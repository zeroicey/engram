/**
 * Project-declared L2 sections — the supported way to extend `.ai/` past the built-in dirs.
 *
 * Why this exists. The contract block in every rule file is machine-owned, so a project that adds
 * a new bank partition (`.ai/journal/`, `.ai/benchmarks/`, …) had two bad options: hand-edit the
 * block and have `sync` overwrite it, or hand-edit the rule-file *body* and repeat the same row in
 * eight tool files that then drift apart.
 *
 * `.ai/sections.json` is the third option and the intended one. It is **project-owned**: engram
 * reads it and never writes it, so editing it is the supported path rather than a fight with the
 * tool. `sync` renders the declared sections into the contract of every rule file at once, and
 * `dump` advertises them, so one declaration reaches every tool.
 *
 * Everything here is non-fatal by construction: a malformed file produces warnings and an empty
 * section list, never an exception. A scaffolder that refuses to sync because the user's
 * extension file has a typo is worse than one that ignores the typo and says so.
 */

import path from 'node:path';
import { readIfPresent } from './project.js';

export const SECTIONS_PATH = '.ai/sections.json';

export interface CustomSection {
  /** Kebab-case id, also the argument to `engram new <name>`. */
  name: string;
  /** Project-relative directory, always inside `.ai/`. */
  dir: string;
  /** Trigger text for the contract's read-on-demand table. */
  trigger: string;
  /** Event text for the contract's write-back table. Omit for a read-only section. */
  writeWhen?: string;
  /** Filename pattern, documentation only: `YYYY-MM-DD-night-<slug>.md`. */
  file?: string;
  /** Status machine, documented verbatim, e.g. `['📝 DRAFT(auto)', '✅ REVIEWED']`. */
  status?: string[];
}

export interface SectionsResult {
  sections: CustomSection[];
  warnings: string[];
}

/** Skill-name rule, shared with the Agent Skills spec. */
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Built-in partitions a project section may not shadow: engram owns their shape. */
const RESERVED_DIRS = new Set([
  '.ai/decisions',
  '.ai/sessions',
  '.ai/runbooks',
  '.ai/pitfalls',
  '.ai/pitfalls/cases',
  '.ai/skills',
]);

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Section names that would shadow a built-in `engram new` verb.
 *
 * `engram new session …` must keep meaning `.ai/sessions/`. A section named `session` pointing
 * somewhere else would take priority in the CLI dispatch and silently change what an existing
 * command does, which is the one kind of extension that must be refused rather than warned about.
 */
/**
 * Names a section may not take.
 *
 * The singular built-in verbs (`engram new decision`) are the obvious collision. The *plural*
 * partition names are the subtle one: `{name: "decisions", dir: ".ai/dec2"}` was accepted, and then
 * `engram new decisions` wrote to `.ai/dec2/` while the contract's read table still sent agents — and
 * `/remember-decision` — to `.ai/decisions/`. The contract ended up with two contradictory rows for
 * "decisions", which is worse than refusing the declaration.
 */
const RESERVED_NAMES = new Set([
  'decision',
  'session',
  'pitfall',
  'runbook',
  'decisions',
  'sessions',
  'pitfalls',
  'runbooks',
  'skills',
  'sections',
]);

/**
 * A path segment engram is willing to hand to `fs`.
 *
 * Rejecting `..` alone is not enough: a control character (including NUL) survives JSON parsing and
 * makes `fs.writeFile` throw `ERR_INVALID_ARG_VALUE` from deep inside `engram new`, and a Windows
 * drive letter or a UNC prefix would resolve outside the project on another platform. The allowlist
 * is deliberate — a bank directory name has no legitimate reason to need anything else.
 */
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Normalise a declared dir: project-relative, no trailing slash, no traversal, no surprises. */
function normaliseDir(raw: string): string | null {
  const dir = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!dir.startsWith('.ai/')) return null;
  if (dir === '.ai') return null;
  const segments = dir.split('/');
  // `.ai` plus at least one real segment, every one of them safe.
  if (segments.length < 2) return null;
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (!SAFE_SEGMENT_RE.test(seg)) return null;
    // `NAME_MAX` is 255 bytes on ext4 and most other filesystems; a longer segment reached `fs` and
    // threw an uncaught `ENAMETOOLONG` out of `engram new`. The rendered row also went into every
    // rule file, so a 5000-character dir bloated all of them.
    if (Buffer.byteLength(seg, 'utf8') > 200) return null;
  }
  return dir;
}

/**
 * A declared filename pattern must stay inside its own directory.
 *
 * Without this, `"file": "../../../etc/passwd"` was joined straight onto the section dir by
 * `engram new` and written outside the repository — a traversal that needs no hostile input beyond
 * a typo in a project-owned JSON file. `<date>` and `<slug>` are the only placeholders engram
 * substitutes, so a `/` or `\\` has no legitimate use here either.
 */
function normaliseFilePattern(raw: string): string | null {
  const file = raw.trim();
  if (!file) return null;
  if (file.includes('/') || file.includes('\\')) return null;
  if (file === '.' || file === '..') return null;
  // Control characters, NUL included, would reach `fs` and throw there instead of here.
  if (hasControlChars(file)) return null;
  // `NAME_MAX` is 255 bytes on ext4 and most other filesystems; a longer pattern produced an
  // uncaught `ENAMETOOLONG` from `engram new` and a 322-character row in every rule file.
  if (Buffer.byteLength(file, 'utf8') > 200) return null;
  return file;
}

/** Control characters, newlines and NUL — none of which belong in a path or a table cell. */
// eslint-disable-next-line no-control-regex
const hasControlChars = (v: string): boolean => /[\u0000-\u001f\u007f]/.test(v);

/**
 * A contract table cell: one line, and safe to interpolate between two `|` characters.
 *
 * `trigger` and `writeWhen` are rendered verbatim into a Markdown table row. A newline in one of
 * them does not merely break the table — it injects a line, and since the contract block is
 * regenerated on every `sync`, a `\n<!-- engram:contract:end -->\n` inside a trigger produced a
 * second end marker and then grew the file by the size of the block on *every subsequent sync*
 * (2889 → 4004 → 5119 bytes), with `inspectMarkers` reporting `balanced` throughout. An unescaped
 * `|` splits the row into extra columns; an unescaped backtick breaks the code span.
 */
function normaliseCell(raw: string): string | null {
  const cell = raw.trim();
  if (!cell || hasControlChars(cell)) return null;
  return cell.replace(/\|/g, '\\|').replace(/`/g, "'");
}

export function parseSections(raw: string | null): SectionsResult {
  if (raw === null) return { sections: [], warnings: [] };
  // A UTF-8 BOM is not whitespace, so `JSON.parse` rejected the whole file and *every* declared
  // section silently disappeared — while the file looked perfectly correct to the user. Windows
  // editors and PowerShell's `>` redirection produce one routinely, and `parseSkillFile` already
  // stripped a BOM; this path did not.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      sections: [],
      warnings: [`${SECTIONS_PATH}: invalid JSON (${(err as Error).message}) — declared sections ignored`],
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { sections: [], warnings: [`${SECTIONS_PATH}: expected a JSON object with a "sections" array`] };
  }

  const obj = parsed as { version?: unknown; sections?: unknown };
  const warnings: string[] = [];
  // `"1"` is accepted: a quoted number is a plausible JSON mistake and the file is otherwise valid.
  // Rejecting it produced the self-contradictory "unsupported version 1 — expected 1".
  if (obj.version !== 1 && obj.version !== '1') {
    return {
      sections: [],
      warnings: [`${SECTIONS_PATH}: unsupported version ${JSON.stringify(obj.version)} — expected the number 1`],
    };
  }
  if (!Array.isArray(obj.sections)) {
    return { sections: [], warnings: [`${SECTIONS_PATH}: "sections" must be an array`] };
  }

  const out: CustomSection[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of obj.sections.entries()) {
    const where = `${SECTIONS_PATH} sections[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      warnings.push(`${where}: not an object — skipped`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const name = asString(e.name);
    const dir = asString(e.dir);
    const trigger = asString(e.trigger);

    if (!name || !NAME_RE.test(name)) {
      warnings.push(`${where}: "name" must be kebab-case — skipped`);
      continue;
    }
    if (seen.has(name)) {
      warnings.push(`${where}: duplicate name "${name}" — skipped`);
      continue;
    }
    if (RESERVED_NAMES.has(name)) {
      warnings.push(`${where}: "${name}" is a built-in partition or \`engram new\` verb and cannot be redeclared — skipped`);
      continue;
    }
    if (!dir) {
      warnings.push(`${where} (${name}): "dir" is required — skipped`);
      continue;
    }
    const normalised = normaliseDir(dir);
    if (!normalised) {
      warnings.push(`${where} (${name}): "dir" must be a project-relative path under .ai/ — skipped`);
      continue;
    }
    if (RESERVED_DIRS.has(normalised)) {
      warnings.push(`${where} (${name}): "${normalised}" is a built-in partition engram owns — skipped`);
      continue;
    }
    if (!trigger) {
      warnings.push(`${where} (${name}): "trigger" is required (it is the contract row the next agent reads) — skipped`);
      continue;
    }
    const triggerCell = normaliseCell(trigger);
    if (triggerCell === null) {
      warnings.push(`${where} (${name}): "trigger" must be a single line without control characters — skipped`);
      continue;
    }
    const rawWriteWhen = asString(e.writeWhen);
    const writeWhen = rawWriteWhen === undefined ? undefined : normaliseCell(rawWriteWhen) ?? undefined;
    if (rawWriteWhen !== undefined && writeWhen === undefined) {
      warnings.push(`${where} (${name}): "writeWhen" must be a single line without control characters — the write-back row was omitted`);
    }
    const status = Array.isArray(e.status)
      ? e.status.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : undefined;
    const rawFile = asString(e.file);
    const file = rawFile === undefined ? null : normaliseFilePattern(rawFile);
    if (rawFile !== undefined && file === null) {
      warnings.push(`${where} (${name}): "file" must be a bare filename without "/", ".." or control characters — ignored, defaulting to YYYY-MM-DD-<slug>.md`);
    }

    seen.add(name);
    out.push({
      name,
      dir: normalised,
      trigger: triggerCell,
      ...(writeWhen ? { writeWhen } : {}),
      ...(file ? { file } : {}),
      ...(status && status.length ? { status } : {}),
    });
  }

  // Sorted so the contract is stable across runs: an unordered map would rewrite every rule file
  // on each `sync` and make "unchanged" meaningless.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { sections: out, warnings };
}

export async function readSections(root: string): Promise<SectionsResult> {
  // `readIfPresent`, not `readFileSafe`: the latter collapses EACCES/EMFILE/EISDIR to `null`, and
  // `parseSections(null)` is an empty result with no warning — so an unreadable `sections.json`
  // silently downgraded the contract to base rows, contradicting "never throw, always warn".
  const read = await readIfPresent(path.join(root, SECTIONS_PATH));
  if (read.error) {
    // A missing file is the normal case and `readIfPresent` reports no error for it.
    return { sections: [], warnings: [`${SECTIONS_PATH}: ${read.error}`] };
  }
  return parseSections(read.text);
}

/** `dir/file` when a filename pattern is declared, `dir/` otherwise. */
export function sectionTarget(section: CustomSection): string {
  return section.file ? `${section.dir}/${section.file}` : `${section.dir}/`;
}

/** The template file a `engram new <section>` scaffolds from, when one is present. */
export function sectionTemplatePath(section: CustomSection): string {
  return `${section.dir}/_TEMPLATE.md`;
}

/**
 * Apply the declared filename pattern. Only `<date>` and `<slug>` are substituted; an unknown
 * placeholder is left verbatim rather than silently dropped, so a typo is visible in the path.
 */
export function sectionFileName(section: CustomSection, date: string, slug: string): string {
  const pattern = section.file ?? 'YYYY-MM-DD-<slug>.md';
  return pattern
    .replace(/YYYY-MM-DD/g, date)
    .replace(/<date>/g, date)
    .replace(/<slug>/g, slug);
}
