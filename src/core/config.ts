import path from 'node:path';
import { readFileSafe, writeFile } from './project.js';

/**
 * `.engram/config.json` — project-local settings.
 *
 * This file used to record *which tools* the project chose, because engram supported nine and
 * `sync` had no other way to know which carriers to write: without it one sync wrote 32 carrier
 * files, inventing `.gemini/commands` and a colliding `.pi/skills` copy for a repo that had asked
 * for one agent.
 *
 * Since 2026-10-18 engram supports exactly one tool (`pi`), so a `tools: ["pi"]` array would be a
 * list with one legal value — an extensibility story the product no longer tells. It is gone, and
 * `version: 1` files are still read: their `tools` key is ignored, which is the whole migration.
 *
 * What remains is the one thing that is genuinely per-project: the goal opt-in.
 */
export interface EngramConfig {
  version: 2;
  /**
   * Opt-in executable behaviour.
   *
   * The goal engine runs code at every settlement boundary, so it is off unless a project asks —
   * separate from tool support, which is not a choice any more.
   */
  goal?: { enabled: boolean };
}

export const CONFIG_PATH = '.engram/config.json';

function parseConfig(raw: string | null): EngramConfig | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    if (version !== 1 && version !== 2) return null;
    // An unknown `goal` shape is dropped rather than treated as `true`: a typo must never enable a
    // lifecycle hook the project did not ask for.
    const goalRaw = (parsed as { goal?: unknown }).goal;
    const goal =
      typeof goalRaw === 'object' && goalRaw !== null && (goalRaw as { enabled?: unknown }).enabled === true
        ? { enabled: true }
        : { enabled: false };
    // A v1 file is accepted as-is: `tools` carries no information a Pi-only engram can use, and
    // refusing the file would also drop the `goal` opt-in next to it.
    return { version: 2, goal };
  } catch {
    // A hand-edited or truncated config must never break sync; it only costs the goal opt-in.
    return null;
  }
}

/** Whether this project opted into the goal engine. Absent config means no. */
export function goalEnabled(config: EngramConfig | null): boolean {
  return config?.goal?.enabled === true;
}

export async function readConfig(root: string): Promise<EngramConfig | null> {
  return parseConfig(await readFileSafe(path.join(root, CONFIG_PATH)));
}

export async function writeConfig(root: string, goal = false): Promise<void> {
  const payload: EngramConfig = { version: 2, ...(goal ? { goal: { enabled: true } } : {}) };
  await writeFile(path.join(root, CONFIG_PATH), `${JSON.stringify(payload, null, 2)}\n`);
}

/**
 * Is the file a v1 one that still lists tools?
 *
 * `sync` rewrites it, so a project that upgraded does not keep a `tools` array naming six clients
 * engram can no longer install for. The information is unused either way — what matters is that the
 * file on disk stops disagreeing with `engram config`.
 */
export async function isLegacyConfig(root: string): Promise<boolean> {
  const raw = await readFileSafe(path.join(root, CONFIG_PATH));
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const version = (parsed as { version?: unknown }).version;
    const tools = (parsed as { tools?: unknown }).tools;
    return version === 1 || Array.isArray(tools);
  } catch {
    return false;
  }
}

/** Flip the goal opt-in, preserving nothing else — there is nothing else. */
export async function setGoalEnabled(root: string, enabled: boolean): Promise<void> {
  await writeConfig(root, enabled);
}
