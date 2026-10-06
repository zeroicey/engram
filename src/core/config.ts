import path from 'node:path';
import { TOOLS, getTool } from '../adapters/index.js';
import { pathExists, readFileSafe, writeFile } from './project.js';

/**
 * `.engram/config.json` — what `init` was told to configure.
 *
 * Without it, `engram sync` had no memory of the user's choice and defaulted to *every* supported
 * tool: one sync wrote 32 carrier files, inventing `.gemini/commands`, `.windsurf/rules` and a
 * second `.pi/skills` copy for tools the project never opted into. The bank is supposed to be the
 * thing that survives; the tool set has to survive with it.
 */
export interface EngramConfig {
  version: 1;
  tools: string[];
}

export const CONFIG_PATH = '.engram/config.json';

function parseConfig(raw: string | null): EngramConfig | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    const tools = (parsed as { tools?: unknown }).tools;
    if (version !== 1 || !Array.isArray(tools)) return null;
    const ids = tools.filter((t): t is string => typeof t === 'string' && getTool(t) !== undefined);
    if (ids.length === 0) return null;
    return { version: 1, tools: [...new Set(ids)] };
  } catch {
    // A hand-edited or truncated config must never break sync; it only costs the recorded scope.
    return null;
  }
}

export async function readConfig(root: string): Promise<EngramConfig | null> {
  return parseConfig(await readFileSafe(path.join(root, CONFIG_PATH)));
}

export async function writeConfig(root: string, tools: string[]): Promise<void> {
  const ids = [...new Set(tools.filter((id) => getTool(id) !== undefined))];
  if (ids.length === 0) return;
  await writeFile(path.join(root, CONFIG_PATH), `${JSON.stringify({ version: 1, tools: ids }, null, 2)}\n`);
}

/**
 * Tool ids a pre-config repository already looks like it uses.
 *
 * Repos initialised before the config file existed have no recorded scope; re-guessing "every
 * tool" would keep the sync-everything behaviour that produced the collision, and re-guessing
 * nothing would silently drop carriers. Presence of a tool's rule file *or* one of its carrier
 * dirs is the evidence a human already chose it.
 */
export async function inferToolsFromDisk(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const tool of TOOLS) {
    const paths = [...tool.ruleFiles.map((f) => f.path), ...tool.skillSinks.map((s) => s.dir)];
    for (const rel of paths) {
      if (await pathExists(path.join(root, rel))) {
        found.push(tool.id);
        break;
      }
    }
  }
  return found;
}

/** Drop ids a newer engram no longer knows (tool removed, typo in config). */
export function knownTools(ids: string[]): string[] {
  return ids.filter((id) => getTool(id) !== undefined);
}