# Project-declared sections and skills: `.ai/` is an extension surface, not a fixed schema

**Status:** ✅ ACCEPTED · **Date:** 2026-10-10 · **Deciders:** user + agent · **Supersedes:** none

## Context

`research` asked for a new L2 partition, `.ai/journal/`, for night-by-night GPU experiment records.
They had three options and all of them were bad:

1. Hand-edit the `<!-- engram:managed -->` contract block → `engram sync` regenerates it, edit lost.
2. Hand-edit the rule-file body → the same row must be repeated in eight tool files, which then
   drift apart, and the row is invisible to `dump`.
3. Wait for an engram release → they cannot ship.

The user's framing is the actual requirement: *the plugin should encourage users to extend it, and
we must give them somewhere to extend that is not a fight with the generator.* A fixed schema with
a growing `MemoryKind` union is the wrong shape — every new partition would be an engram release.

Two facts forced the design:

- The contract block is **machine-owned** (`.ai/decisions/2026-10-01-contract-block-machine-owned.md`).
  Anything inside it must be derived, or the next `sync` deletes it.
- `materializeSkillSinks` only ever materialised `SKILL_SPECS`. A project-authored
  `.ai/skills/nightly.md` was silently ignored, and if a carrier was hand-written, `sync` treated it
  as an orphan. The canonical directory was documented as the source of truth but was not one.

## Options

| | Option | Upside | Downside | Verdict |
| --- | --- | --- | --- | --- |
| A | Per-project contract block, engram stops managing it | user owns everything | loses the one thing that makes the bank portable; 8 files drift | rejected |
| B | `engram.config.js` — a JS plugin file the user writes | arbitrarily powerful | arbitrary code execution in a scaffolder; untestable; zero-dep constraint broken | rejected |
| C | Declarative `.ai/sections.json` read by engram, rendered into the derived block | one edit reaches every tool; no code; degrades to a warning | one more file in `.ai/` | ✅ chosen |
| D | Add each partition to the built-in `MemoryKind` union | no new file | every project's schema decision becomes an engram release | rejected |

Skills take the same route with no new file: `.ai/skills/*.md` becomes the source of truth, and the
four built-ins are simply its first four files.

## Decision

Three zones, and the rule is which one a path is in:

| Zone | Paths | `sync` behaviour |
| --- | --- | --- |
| Z0 engram-owned | contract block, `engram:managed`/`engram:generated` markers, `_Read by:`, carriers, `.engram/` | regenerated; never hand-edit |
| Z1 project-owned input, engram-read | `.ai/**` (never clobbered), `.ai/sections.json`, `.ai/skills/*.md` | read, rendered from |
| Z2 project-owned, engram-invisible | rule-file body above the contract, `.ai/README.md`, `notes/` | never touched |

- **Sections.** `.ai/sections.json` (`version: 1`, `sections[]` with `name`, `dir`, `trigger`,
  optional `writeWhen`, `file`, `status`) is rendered by `sync` into the contract's read-on-demand
  and write-back tables of every rule file, into `engram dump`'s POINTERS, and into
  `engram new <section>` (from `<dir>/_TEMPLATE.md` when present). Sorted by name so `unchanged`
  stays meaningful. Built-in dirs are reserved; invalid entries warn and are skipped.
- **Skills.** `.ai/skills/<name>.md` is the source of truth; any valid file materialises into every
  carrier, not just `SKILL_SPECS`. Deleting it prunes the generated carrier.
- **The `dump` pointer is best-effort; the contract block is the guarantee.** The sections line sits
  in its own elastic tier (priority 3.5, dropped *before* `PITFALLS`/`RECENT`/`BINDING`) because it
  was first appended to `POINTERS` (priority 4, never dropped) and one declaration then evicted the
  whole pitfalls block — see `.ai/pitfalls/cases/new-line-evicts-elastic-content.md`. Consequence,
  measured: on `research` the fingerprint is already over budget, so the line is absent from `dump`
  while `AGENTS.md` still carries both `journal` rows. That is the intended precedence — the pointer
  is a convenience, the contract row is the contract. `dump` reports `truncated: true` when it drops.
- **Backwards compatibility is a test, not a hope.** `aiContract()` with no extensions is
  byte-identical to the v1 block, so upgrading rewrites nothing. `test/sections.test.ts` pins the
  v1 block by **sha256 and byte length** (a self-comparison `aiContract() === AI_CONTRACT` is a
  tautology and could not detect a changed base block), and asserts that stripping the extension rows
  reproduces it exactly. `sync` on `research` reported `unchanged AGENTS.md`.
- **`CONTRACT_VERSION` stays 1.** The block's *format* did not change; only its row count. Bumping
  to v2 was rejected after measuring what an older engram actually does with each marker — the
  guess that v2 would "append a second block" was **wrong**, and the real difference is smaller but
  still decisive:
  - **v1 (chosen).** An older engram recognises the marker, rewrites the block to its base rows, and
    keeps exactly one block. The extension rows vanish and the next sync with a current engram
    restores them. Degraded, self-healing, no user action.
  - **v2 (rejected).** `inspectMarkers` counts 0 starts / 1 end, reports `unbalanced`, and
    `refreshContract` returns `skipped` with a warning telling the user to delete the stray marker.
    Measured on the real build: `skipped   AGENTS.md … unbalanced contract marker (0 start / 1 end)`.
    No data loss, but the repository is **stuck** — `sync` can never refresh that file again until a
    human intervenes. A silent, self-healing downgrade beats a loud, manual one.

  Neither choice can lose a source: the rows are derived, so the worst case is a missing rendering.

## Consequences

- A new partition costs one JSON entry, zero engram releases, and reaches all nine adapters.
- `engram new` now dispatches on declared sections, so `NewSectionOptions` joins `MemoryKind` as a
  public entry point.
- Carrier pruning widened from "retired sink dirs" to "generated files whose canonical skill is
  gone". Still guarded by `GENERATED_MARKER`: `research/.agents/skills/net-access/SKILL.md` (hand
  written) is never a candidate.
- Two new leaf modules: `src/core/sections.ts`, `src/core/skill-source.ts`. `core/` still imports
  nothing from `templates/` — `templates/contract.ts` declares the row shape structurally instead.
- `engram 0.4.0`.

## Revisit when

- A project needs a section that is not a directory of files (a database, a generated index), or a
  `file` pattern richer than `<date>`/`<slug>` — that is the signal that a declarative format is
  being pushed past what JSON can express, and option B deserves a second look behind a flag.
- `.ai/sections.json` and the contract disagree in a repository after a sync — that would mean the
  rendering is no longer a pure function of the input, which this decision depends on.
