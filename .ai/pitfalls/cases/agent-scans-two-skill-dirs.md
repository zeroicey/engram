# A tool can scan two carrier dirs, so a "portable" duplicate collides

**Severity:** 🟠 medium · **Date:** 2026-10-06

## Symptom

Pi printed a `Skill conflicts` panel on every session start, once per skill, listing the same
skill in two directories and marking one `(skipped)`. Nothing failed; the skill still loaded.
Only the *first discovered* copy was used, so which one won was an accident of scan order.

## Root cause

Writing a skill into two directories is only safe if no single agent reads both. Pi reads
`.pi/skills/` **and** `.agents/skills/` — the portable Agent Skills dir it supports natively. So
"one carrier per tool, one dir each" was wrong: `pi` and `agents` were not different consumers,
they were the same consumer with overlapping directories.

The trap is that each half looks reasonable on its own. `.agents/skills` is the standard dir
(Codex, several agents read it); `.pi/skills` is Pi's native dir. Neither is wrong alone. And
"duplicate the canonical skill per tool" is a *feature* in every other pair, so the instinct that
produced the bug is the instinct that makes engram work.

## Fix

One carrier dir per skill, chosen so no single agent scans two of them. Pi keeps the shared
`.agents/skills` and loses its native copy; see
`.ai/decisions/2026-10-06-single-skill-carrier-dir.md`.

## Guard

`test/adapters.test.ts` → "REGRESSION no two sinks of one tool write the same skill into dirs Pi
scans" asserts the `pi` tool has no `.pi/skills` sink and that no tool repeats a sink dir. The
pairing rule itself — which dirs one agent scans — lives in that test's comment, because it comes
from another project's docs, not from this codebase.

Also check `RETIRED_SINK_DIRS` in `src/adapters/index.ts` before adding a carrier dir: a dir that
was retired still holds generated files in every existing repo.

## Related trap

`engram sync` had no record of the selected tools, so its default (every tool) silently created
carriers for tools the project never chose — the amplifier that made this fire everywhere.
Fix: `.engram/config.json`, see the same decision file.