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
  /**
   * Engine limits, when the project needs different ones from the defaults.
   *
   * The waiting decision says the liveness deadline is "default 24h, **configurable**", and until this
   * existed it was not: every call to `reduce` used `DEFAULT_LIMITS`, so the number was a constant with
   * a decision pointing at it. A day is the right default for a real training run and the wrong one for
   * anything that wants to notice a dead wait sooner — and it is not testable at all without waiting a
   * day.
   *
   * Only fields that are present are applied, so a project that sets one keeps the default for the
   * rest. Every value is validated: a negative or non-finite number is dropped rather than used, because
   * `livenessMs: 0` would make every wait expire instantly and `NaN` would make none expire.
   */
  limits?: Partial<Record<LimitKey, number>>;
}

/** The knobs `GoalLimits` exposes, named here so `config` does not depend on `core/goal.ts`'s type. */
export type LimitKey = 'livenessMs' | 'stuckRounds' | 'blockedRepeats' | 'silentSettles';

const LIMIT_KEYS: LimitKey[] = ['livenessMs', 'stuckRounds', 'blockedRepeats', 'silentSettles'];

/**
 * The `limits` block, filtered to values that can be used.
 *
 * Returns `undefined` when nothing valid is left, so an empty or nonsense block does not look like a
 * deliberate configuration.
 */
function parseLimits(raw: unknown): EngramConfig['limits'] | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const out: Partial<Record<LimitKey, number>> = {};
  for (const key of LIMIT_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    // Counts are counts: a fractional `stuckRounds` would compare `2.5 >= 2.5` and fire one round late.
    out[key] = key === 'livenessMs' ? value : Math.floor(value);
  }
  return Object.keys(out).length ? out : undefined;
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
    const limits = parseLimits((parsed as { limits?: unknown }).limits);
    // A v1 file is accepted as-is: `tools` carries no information a Pi-only engram can use, and
    // refusing the file would also drop the `goal` opt-in next to it.
    return { version: 2, goal, ...(limits ? { limits } : {}) };
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

/**
 * Write the config, preserving the limits block.
 *
 * The old signature was `writeConfig(root, goal)`, and it *replaced* the whole document — which was
 * harmless while the opt-in was the only key. With `limits` in the file, toggling the goal would have
 * silently deleted a project's tuned liveness deadline: a write that drops a field it does not own is
 * the same shape as the `clear-wake` leaks, one layer down.
 */
export async function writeConfig(
  root: string,
  goal = false,
  limits?: EngramConfig['limits'],
): Promise<void> {
  const payload: EngramConfig = {
    version: 2,
    ...(goal ? { goal: { enabled: true } } : {}),
    ...(limits ? { limits } : {}),
  };
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

/** Flip the goal opt-in, preserving the limits block it does not own. */
export async function setGoalEnabled(root: string, enabled: boolean): Promise<void> {
  const existing = await readConfig(root);
  await writeConfig(root, enabled, existing?.limits);
}
