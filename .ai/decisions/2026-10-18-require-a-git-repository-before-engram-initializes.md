# Require a git repository before engram initializes

**Status:** ✅ ACCEPTED · **Date:** 2026-10-18 · **Deciders:** zeroicey

## Context

`engram init` currently writes wherever it is pointed. Two things make that untenable now that a
long-running agent will be the main consumer of `.ai/`:

- **The memory bank must be recoverable.** A 20-round autonomous run rewrites `.ai/CURRENT_TASK.md`,
  appends decisions, and writes handoffs. Without version control there is no diff, no bisect and no
  "what did it change while I slept". The bank is the audit trail, so the bank itself has to be
  under the same history as the code it describes.
- **A silent fallback is worse than a refusal.** Today a non-git directory gets a bank that looks
  identical to a managed one, and nobody discovers the gap until the day the history is needed.

`research` already proved the failure mode from the other side: a project that is "not a git repo"
was found in the registry and its experiment ledger had no history to fall back on.

## Options

- **A. Warn and continue.** Least friction, but produces banks that cannot be audited — exactly the
  state that is hard to notice.
- **B. Offer to `git init` for the user.** Convenient, but `engram` would be deciding version-control
  policy (branch name, ignore rules, whether the parent is a repo on purpose) that belongs to the
  project.
- **C. Refuse and say how to fix it.** *(chosen)*
- **D. Make it a `--force`-able warning.** Keeps an escape hatch, but then the guarantee is
  worthless — anything can be forced, and the "is this managed?" check degrades into "did someone
  pass a flag".

## Decision

1. **`engram init` refuses to run outside a git repository.** It detects the repository by walking
   up from the target directory, exactly as git does — a **`.git` directory** (normal checkout) and a
   **`.git` file** (linked worktree / `--separate-git-dir`) both count. Detection is one `stat` per
   ancestor: no `git` binary, no subprocess, no dependency.
2. **The check is the entry precondition**, performed in the `init` command handler before option
   parsing side effects and before the first write. Refusing later would mean either partial output
   or a rollback that can miss a file.
3. **The refusal exits 1 and names the remedy.** It prints the target directory, says it is not
   inside a git repository, gives the reason (a bank that cannot be diffed cannot be audited), and
   shows both fixes (`git init`, or `--root <path-inside-a-repository>`), then states
   `Nothing was written.` — verified by a test that asserts the directory listing is byte-identical
   before and after.
4. **A subdirectory target resolves to the enclosing repository** and keeps the bank **in the
   subdirectory it was pointed at**; the enclosing root is only reported. Nested `git init` is never
   proposed.
5. **`--dry-run` does not bypass the check.** A dry run that reports success where a real run would
   refuse is a lie about the outcome.
6. **No override flag in v1.** If a genuine non-git need appears, it comes back as a decision with a
   named use case, not as a pre-emptive `--force`.
7. **The rule is not retroactive.** An existing bank in a non-git directory is not deleted; `dump`,
   `sync` and `new` keep working there (verified: both exit 0 in a bank whose `.git` was removed).
8. **Only `init` is gated**, because `init` is the only command that decides where a bank comes into
   existence.

## Consequences

- Every new bank is auditable by construction: `git log` on `.ai/` is the memory bank's history, and
  an autonomous run can be diffed round by round.
- One more hard prerequisite at init time, so init failures now have a diagnosable cause instead of
  a silent downgrade.
- Projects that legitimately cannot be git (a data-only directory, a borrowed machine's scratch
  space) cannot host a bank. Those become pointers to a real project instead.
- `fundus-glaucoma-triage` is the known live example of a non-git project; it stays readable but
  cannot be re-initialised until it gains a repository.
- The test sandbox creates a `.git` marker by default, so every existing test now runs under the
  real precondition; one test asserts `hasGit` and one filters `.git` out of an "outside directory
  stayed empty" assertion. That is churn paid once for a guarantee that now holds for all of them.

## Revisit when

- A real project needs a bank but cannot be a git repository, and the reason is not "it should have
  been one".
- Multi-repository projects ask for a bank that spans several repositories.
