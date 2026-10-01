/**
 * Canonical skill names, kept in the leaf layer.
 *
 * `core/fingerprint.ts` needs these to advertise the skill commands when a bank has no
 * `.ai/skills/` yet, and the layering rule says `core/` must not import from `templates/`.
 * Previously the four names were hardcoded in the fingerprint's fallback branch, so adding a
 * fifth skill to `templates/skills.ts` left the fingerprint advertising four — a bug no test could
 * see because a populated bank never hits that branch.
 *
 * `test/adapters.test.ts` locks `SKILL_SPECS` to this list.
 */
export const CANONICAL_SKILL_NAMES = ['handoff', 'remember-pitfall', 'remember-decision', 'audit'] as const;

export type CanonicalSkillName = (typeof CANONICAL_SKILL_NAMES)[number];

/** `skills: /handoff /audit …` for the fingerprint pointer line. */
export const skillCommandList = (names: readonly string[] = CANONICAL_SKILL_NAMES): string =>
  names.map((n) => `/${n}`).join(' ');