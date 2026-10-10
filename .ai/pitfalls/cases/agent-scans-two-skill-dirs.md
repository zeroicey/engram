# One provider, two skill roots: the "native" carrier is the shadow, not the fix

**Severity:** 🟠 medium · **First hit:** 2026-10-06 (Pi) · **Hits since:** 1 (dsh, caught pre-ship)

## Symptom

An agent prints a skill-collision panel at startup, once per skill, listing the same name in two
directories with one marked skipped — for example dsh's registry, which logs

```text
skill "handoff" from project-dsh ignored because a higher-priority skill already exists
```

Nothing fails; the skill still loads. Which copy wins is decided by root rank, not by intent.

## Root cause

Writing a skill into two directories is only safe if no single agent reads both. Two consumers own
**two** scanning roots at once, so a duplicate name is a collision even though the two dirs look
like they belong to different tools:

- Pi reads `.pi/skills/` **and** `.agents/skills/` — the portable Agent Skills dir it supports
  natively. `pi` and `agents` were not different consumers; they were one consumer with two dirs.
- `dsh-skill-filesystem` reads `<project>/.dsh/skills` (rank 100) **and** `.agents/skills`
  (rank 200); `dsh-skill` resolves duplicates within one layer by rank, first-wins, with a warning.

The trap is that each half looks reasonable on its own. `.agents/skills` is the standard dir (Codex,
several agents read it); `.pi/skills` and `.dsh/skills` are the vendors' native dirs. Neither is
wrong alone, and "duplicate the canonical skill per tool" is a *feature* in every other pair — so
the instinct that produced the bug is the instinct that makes engram work. `.dsh/skills` was avoided
only because this file existed before the dsh adapter was designed.

## Fix

One carrier dir per skill, chosen so no single agent scans two of them. Both `pi` and `dsh` keep the
shared `.agents/skills` and lose their native copy; engram writes nothing under `.dsh/`. See
`.ai/decisions/2026-10-06-single-skill-carrier-dir.md` and
`.ai/decisions/2026-10-10-dsh-adapter-shared-agent-skills.md`.

## Guard

`test/adapters.test.ts` → "REGRESSION no two sinks of one tool write the same skill into dirs Pi
scans" asserts the `pi` tool has no `.pi/skills` sink and that no tool repeats a sink dir; the dsh
test ("…only the shared .agents/skills carrier") pins `dsh.skillSinks` to `['.agents/skills']`. The
pairing rule itself — which dirs one agent scans — lives in those tests' comments, because it comes
from another project's docs, not from this codebase.

Before adding any carrier dir, read the target agent's **skill-root table** (rank order, not just
the headline path). If two rows can be scanned by one agent, only one may hold an engram skill.

Also check `RETIRED_SINK_DIRS` in `src/adapters/index.ts` before adding a carrier dir: a dir that
was retired still holds generated files in every existing repo.

## Related trap

`engram sync` had no record of the selected tools, so its default (every tool) silently created
carriers for tools the project never chose — the amplifier that made this fire everywhere.
Fix: `.engram/config.json`, see the same decision file.