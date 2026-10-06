import path from 'node:path';
import { promises as fs } from 'node:fs';
import { SKILL_SPECS } from '../templates/skills.js';
import { GENERATED_MARKER } from '../templates/contract.js';
import { RETIRED_SINK_DIRS, type ToolDef } from '../adapters/index.js';
import { pathExists, readFileSafe } from '../core/project.js';

/**
 * Delete carriers for sink directories engram no longer writes.
 *
 * Retiring the `.pi/skills` sink (Pi reads `.agents/skills` natively) leaves orphaned files behind
 * in every repo that ever ran `sync`. Two properties make this safe:
 *
 * 1. Only files carrying `GENERATED_MARKER` are ever deleted. A hand-written skill that happens
 *    to sit in `.pi/skills/` — `research/.pi/skills/net-access/SKILL.md` — is left alone.
 * 2. Only directories engram itself used to write are walked, and only for skill names engram
 *    knows. `.ai/` is never a carrier dir, so the canonical bank is out of reach by construction.
 */
function isGeneratedCarrier(root: string, rel: string): Promise<boolean> {
  return readFileSafe(path.join(root, rel)).then((c) => c !== null && c.includes(GENERATED_MARKER));
}

/** Carrier paths the given tools write. A dir in here is never pruned, even if retired. */
function ownedDirs(tools: ToolDef[]): Set<string> {
  return new Set(tools.flatMap((t) => t.skillSinks.map((s) => s.dir)));
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    const entries = await fs.readdir(dir);
    if (entries.length === 0) await fs.rmdir(dir);
  } catch {
    // A non-empty or already-gone directory is the normal case.
  }
}

export interface PruneResult {
  /** Carrier paths that were removed, project-relative. */
  removed: string[];
}

/**
 * Remove generated carriers under sink dirs that the selected tools no longer claim.
 * Returns the removed paths; never touches a file it did not generate.
 */
export async function pruneStaleCarriers(
  root: string,
  tools: ToolDef[],
  dryRun = false,
): Promise<PruneResult> {
  const owned = ownedDirs(tools);
  const removed: string[] = [];

  for (const dir of RETIRED_SINK_DIRS) {
    if (owned.has(dir)) continue;
    let touched = false;
    for (const spec of SKILL_SPECS) {
      const rel = path.posix.join(dir, spec.name, 'SKILL.md');
      const promptRel = path.posix.join(dir, `${spec.name}.md`);
      const tomlRel = path.posix.join(dir, `${spec.name}.toml`);
      for (const candidate of [rel, promptRel, tomlRel]) {
        if (!(await pathExists(path.join(root, candidate)))) continue;
        if (!(await isGeneratedCarrier(root, candidate))) continue;
        if (!dryRun) await fs.rm(path.join(root, candidate));
        removed.push(candidate);
        touched = true;
        if (!dryRun && candidate.endsWith('SKILL.md')) await removeIfEmpty(path.join(root, dir, spec.name));
      }
    }
    // Drop the retired dir itself once it is empty, but only if we emptied it — an unrelated
    // empty directory the user made is not engram's to remove.
    if (touched && !dryRun) await removeIfEmpty(path.join(root, dir));
  }

  return { removed };
}