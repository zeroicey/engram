# The contract block is machine-owned, never model-authored

**Status:** ✅ ACCEPTED · **Date:** 2026-10-01 · **Deciders:** lead architect

## Context

Layer 1 rule files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, …) are written in two very
different ways. The *body* is house style, tech-stack specifics, and team norms — content only the
project's own AI assistant (fed the meta-prompt) can produce. The *contract* that binds the tool to
`.ai/` is identical everywhere and must be byte-identical across tools, or the memory bank silently
stops being read.

An earlier instinct was to hand the model a copy of the contract in the meta-prompt and trust it to
paste it correctly. Models paraphrase. A paraphrased contract loses the trigger table, the status
machine, or the write-back rule — and the failure is invisible: the assistant simply stops writing
back, days later.

## Options

| Option | Upside | Downside | Reversibility |
| --- | --- | --- | --- |
| A. Model writes the whole file, contract included in the prompt | one step | contract drifts per tool; unfixable once shipped | hard |
| B. Model writes only the body; CLI appends the contract, `sync` rewrites it | contract is identical everywhere and always current | two-phase workflow | easy |
| C. Contract lives in a separate file each tool imports (`@.ai/RULE.md`) | DRY | Cursor/Copilot/Windsurf have no import mechanism; must duplicate anyway | medium |

## Decision

The model authors only the body, above `<!-- engram:contract:start -->`. The CLI owns everything
between the delimiters, and `engram sync` replaces that block in place, preserving the body
byte-for-byte. The meta-prompt shows the contract as *read-only reference* and states that editing
it is pointless because `sync` overwrites it.

## Consequences

- `renderRuleFile` wraps an existing body with `withContract`; `refreshContract` replaces only the
  delimited span. Both are idempotent — running them twice changes nothing (asserted in tests).
- `init` on a repo with hand-written `AGENTS.md` appends the contract instead of overwriting.
- The contract text is a shipped constant (`AI_CONTRACT`), versioned by `CONTRACT_VERSION`.
- `engram sync` is mandatory after any model edit of a rule file; `init` output says so.

## Revisit when

A tool adds real import semantics (Cursor rules, Copilot `applyTo`) strong enough to make option C
work everywhere.