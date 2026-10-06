# engram

**Portable project memory + scaffold for AI coding tools.**
One memory bank (`.ai/`) that Claude Code, Codex, Pi, Cursor, Windsurf, Copilot and Gemini CLI all
read and write — plus a ≤1.5 KB fingerprint so a new session starts warm instead of blank.

> Why: AI does not get dumber because reasoning degrades. It gets dumber because context drifts,
> old decisions are forgotten, and the same trap is re-discovered every third session. `engram`
> makes that state physical, versioned and tool-independent.

---

## 中文速览

`engram` 是给 AI 编程工具用的**项目记忆与脚手架**：一个 `.ai/` 目录当唯一记忆库，各工具的规则
文件（`AGENTS.md` / `CLAUDE.md` / `.cursor/rules/*.mdc` …）里挂同一份「查阅 + 写回」契约，
`engram dump` 输出 ≤1.5KB 的动态指纹，新会话一句话接盘。

```bash
npx @zeroicey/engram init --tools agents,claude,cursor,pi   # 生成骨架 + 规则文件 + 元提示词
npx @zeroicey/engram dump                         # ≤1.5KB 指纹，贴到新会话第一句
npx @zeroicey/engram sync                         # 规则文件改动后刷新契约与技能载体
```

四个层：L0 动态注入（dump）· L1 行为契约（规则文件）· L2 知识库（`.ai/`）· L3 动作技能
（`/handoff` `/remember-pitfall` `/remember-decision` `/audit`）。

---

## Install & run

Requires Node ≥ 20. Zero runtime dependencies.

```bash
npx @zeroicey/engram init    # or: add --tools claude,cursor,pi --notes "our norms"
npx @zeroicey/engram dump    # ≤1.5 KB fingerprint
npx @zeroicey/engram dump --json
```

Or pin it: `npm i -D @zeroicey/engram` then `npx engram …`.

## The four layers

| Layer | What | Size | Loaded |
| --- | --- | --- | --- |
| **L0** dynamic injection | `engram dump` fingerprint | ≤ 1.5 KB (300–500 tokens) | every new session |
| **L1** behaviour contract | `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.mdc`, … | < 2 KB | always, by the tool |
| **L2** knowledge bank | `.ai/` | unbounded | on demand, by file read |
| **L3** action specs | `.ai/skills/*.md` → `/handoff`, `/audit`, … | ~1 KB each | on trigger |

```
.ai/
├── README.md          index + operating contract
├── ARCHITECTURE.md    stack, boundaries, call topology, invariants
├── CURRENT_TASK.md    goal, checklist, code state, blockers, next action
├── decisions/         YYYY-MM-DD-<topic>.md · 💭 PROPOSAL → ✅ ACCEPTED → 🪦 REJECTED
├── sessions/          YYYY-MM-DD-<topic>-handoff.md
├── runbooks/          env-setup.md, deploy.md, release.md
├── pitfalls/cases/    symptom → root cause → fix → guard
└── skills/            canonical, portable skill specs (one source for every tool)
```

## Commands

| Command | What it does |
| --- | --- |
| `engram init` | creates `.ai/`, rule-file contracts, skill carriers, `.engram/BOOTSTRAP.md` |
| `engram dump` | prints the ≤1.5 KB fingerprint (`--json`, `--max-bytes`, `--out`) |
| `engram new <kind> <title>` | scaffolds one `decision` / `session` / `pitfall` / `runbook` |
| `engram sync` | refreshes contract blocks in place, re-materialises skill carriers |
| `engram tools` | lists supported tools and their carriers |

Flags: `--tools a,b,c`, `--all`, `--notes "team norms"`, `--force`, `--dry-run`, `--root <dir>`.

## Supported tools

| id | Rule file | Skill carriers |
| --- | --- | --- |
| `agents` | `AGENTS.md` (Codex, OpenCode, Cline, Amp, Zed…) | `.agents/skills/` |
| `codex` | `AGENTS.md` | `.agents/skills/` (shared with `agents`) |
| `claude` | `CLAUDE.md` | `.claude/skills/`, `.claude/commands/` |
| `cursor` | `.cursor/rules/engram-memory.mdc` | `.cursor/skills/` |
| `windsurf` | `.windsurf/rules/engram-memory.md` | — |
| `copilot` | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md` | `.github/prompts/` |
| `gemini` | `GEMINI.md` | `.gemini/commands/*.toml` |
| `pi` | `AGENTS.md` | `.agents/skills/` (shared), `.pi/prompts/` |

## The two design problems, solved

**1. Rule files must be tool-idiomatic, but boilerplate is useless.** `engram init` does not write
your `CLAUDE.md` for you. It writes the part only it can know — the `.ai/` contract, byte-identical
in every tool, delimited by `<!-- engram:contract:start -->` / `<!-- engram:contract:end -->` — and
then generates `.engram/BOOTSTRAP.md`: a meta-prompt for whichever AI assistant you are already
talking to, containing your real project facts (stack, scripts, directories, existing rules, your
`--notes`), the per-tool style rules and the section list to write. Your assistant writes the body;
`engram sync` re-owns the contract. See `.ai/decisions/2026-10-01-contract-block-machine-owned.md`.

**2. Skills must not be copy-pasted eight times.** `.ai/skills/<name>.md` is the single canonical
spec, with Agent-Skills-compatible frontmatter. Each tool declares a *sink*
(`<name>/SKILL.md`, `$ARGUMENTS` slash command, Gemini `{{args}}` TOML) and `engram sync`
materialises it, stamped `<!-- engram:generated -->`. Tools without native skills get the Layer-1
contract, which points at `.ai/skills/*.md` as a passive fallback.
See `.ai/decisions/2026-10-01-canonical-skills-single-source.md`.

## Skills

| Command | Trigger | Effect |
| --- | --- | --- |
| `/handoff [topic]` | session ending, long detour, compaction | writes `.ai/sessions/…-handoff.md`, refreshes `.ai/CURRENT_TASK.md` |
| `/remember-pitfall <case>` | confusing bug, silent wrong result, flaky test | `.ai/pitfalls/cases/<case>.md` with a guard |
| `/remember-decision <topic>` | expensive-to-reverse choice, brainstorming | `.ai/decisions/…` with status machine |
| `/audit [scope]` | before a release, after long absence | ranked drift list: code vs bank |

## Working with it day to day

```bash
# start of a session  (or use the local install: npm i -D @zeroicey/engram)
npx @zeroicey/engram dump   # paste as the first message of a new conversation

# while working — the assistant follows the rule file and writes back on its own
/handoff parser-rewrite     # end of session

# after editing a rule file by hand, or after changing a skill
npx @zeroicey/engram sync
```

Commit `.ai/`, the rule files and `.engram/BOOTSTRAP.md` to git: the bank only works if it is
versioned. `.engram/drafts/` is gitignored.

## Develop

```bash
npm install      # devDependencies only
npm run typecheck
npm test         # build + node --test build/test/*.test.js
```

Design decisions, pitfalls and the project's own memory live in [`.ai/`](.ai/README.md) — engram
documents itself with engram.

## Release

```bash
npm test && npm pack --dry-run
npm publish --access public
git tag -a v0.2.1 -m "engram 0.2.0" && git push origin main --follow-tags
```

Full procedure: `.ai/runbooks/release.md`. Setup: `.ai/runbooks/dev-setup.md`.

## License

MIT