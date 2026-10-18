#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TOOLS } from './adapters/index.js';
import { runInit, runSync } from './commands/init.js';
import { renderDump, runDump } from './commands/dump.js';
import { isMemoryKind, runNew, runNewSection, type MemoryKind } from './commands/new.js';
import {
  runGoalBaton,
  runGoalCheck,
  runGoalClose,
  runGoalEvent,
  runGoalList,
  runGoalNew,
  runGoalStatus,
  runGoalUnit,
  runGoalWake,
  identityFromEnv,
  runGoalHandoff,
} from './commands/goal.js';
import { parseDoneWhen } from './core/goal-store.js';
import type { DoneWhen, MetricOp } from './core/goal.js';
import { readSections } from './core/sections.js';
import { readConfig, setGoalEnabled } from './core/config.js';
import { findGitRepository, workingTreeDigest, type GitCheck } from './core/git.js';
import { SKILL_NAMES } from './templates/skills.js';
import { toolSummary } from './templates/meta-prompt.js';
import { writeFile } from './core/project.js';
import { VERSION } from './version.js';

/**
 * `engram dump | head -1` is the canonical way to preview the fingerprint. When the reader exits
 * early Node raises EPIPE asynchronously on stdout, and an unhandled stream 'error' is an
 * uncaught exception: the user got a stack trace instead of a preview.
 */
function ignoreBrokenPipe(): void {
  const swallow = (err: NodeJS.ErrnoException): void => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  };
  process.stdout.on('error', swallow);
  process.stderr.on('error', swallow);
}

type Args = { _: string[]; flags: Map<string, string | boolean> };

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(a.slice(2), next);
          i++;
        } else {
          flags.set(a.slice(2), true);
        }
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

const str = (flags: Args['flags'], name: string): string | undefined => {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
};
const flag = (flags: Args['flags'], name: string): boolean => flags.get(name) === true || flags.get(name) === 'true';
const num = (flags: Args['flags'], name: string): number | undefined => {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * An integer flag whose value must be positive.
 * `--max-bytes -5` used to drop the value entirely and quietly fall back to 1500.
 */
const positiveInt = (flags: Args['flags'], name: string): number | undefined => {
  const raw = flags.get(name);
  // A negative value like `--max-bytes -5` is parsed as a separate flag, so the option ends up
  // valueless. Saying so beats silently reverting to the default.
  if (raw === true) {
    console.error(`warn: --${name} needs a non-negative integer value; using the default`);
    return undefined;
  }
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  console.error(`warn: ignoring --${name}=${v} (expected a non-negative integer)`);
  return undefined;
};

const HELP = `engram v${VERSION} — portable project memory + scaffold for AI coding tools

USAGE
  engram init [options]        create .ai/, rule-file contracts, skills, bootstrap meta-prompt
  engram dump [options]        print the ≤1.5KB session fingerprint
  engram new <kind> <title>    scaffold one memory file (decision|session|pitfall|runbook,
                               plus any section declared in .ai/sections.json)
  engram goal <verb>           create / inspect / verify / close a long-running goal
  engram sync [options]        refresh contracts + re-materialise skill files
  engram config [options]      show or change the recorded config (incl. the goal opt-in)
  engram tools                 list supported AI tools
  engram --help | --version

INIT OPTIONS
  --notes <text>     team norms to bake into the bootstrap meta-prompt
  --force            regenerate rule files from stubs instead of preserving your text
  --dry-run          report planned writes only
  --root <dir>       operate on another directory (default: cwd)

DUMP OPTIONS
  --json             machine-readable output (always valid JSON, even on error)
  --max-bytes <n>    hard byte ceiling (default 1500; output never exceeds it)
  --project <name>   override the project label shown in the header
  --out <file>       write the fingerprint to a file, in the requested format

SYNC OPTIONS
  --dry-run          report planned actions only

GOAL VERBS
  engram goal new "<text>" [--cmd "npm test" ...] [--metric file:path:op:value] [--checklist]
  engram goal status | list | check [--id <id>] | close [--id <id>] [--abandoned]
  engram goal wake --reason "<why>" [--token <token>] [--id <id>] [--deliver]
  engram goal unit <id> --job "<command>" [--write] [--engram <path>]
  engram goal handoff [--id <id>] [--reason "<why now>"] [--json]   # open a successor pane
  engram goal baton --session <path> [--pane <pane-id>] [--id <id>]

  A goal is judged, not asserted: \`done\` requires the engine to observe \`done_when\`.
  \`unit\` emits a systemd unit that runs a long job and wakes the goal when it exits — the long job
  must not live in the agent's process tree, or closing the pane orphans it.

CONFIG OPTIONS
  --goal on|off      opt into the goal engine (writes .pi/extensions/engram-goal.ts on sync)
  --json             print the recorded config

SUPPORTED TOOLS
${TOOLS.map((t) => `  ${t.id.padEnd(9)} ${t.label}`).join('\n')}

SKILLS (canonical: .ai/skills/*.md)
  ${SKILL_NAMES.map((s) => `/${s}`).join('  ')}
`;

/**
 * Precondition for `init`: a git repository must enclose the target.
 *
 * A bank that cannot be diffed cannot be audited, and an autonomous run that rewrites
 * `.ai/CURRENT_TASK.md` for twenty rounds has no other record. The refusal therefore happens
 * **before any write** and leaves the filesystem untouched — a half-initialised project would be
 * the worst of both worlds. There is deliberately no override flag (see the decision of
 * 2026-10-18): if a real non-git need appears it comes back as a decision, not a `--force`.
 *
 * Only `init` is gated. `dump`, `sync` and `new` keep working in a bank that already exists in a
 * non-git directory, so an existing bank is never taken away from a project.
 */
async function requireGitRepository(root: string): Promise<GitCheck | null> {
  const check = await findGitRepository(root);
  if (check.hasRepository) {
    if (check.repositoryRoot !== root) {
      const kind = check.marker === 'file' ? 'linked worktree' : 'repository';
      console.log(`using enclosing git ${kind} at ${check.repositoryRoot}`);
    }
    return check;
  }

  console.error(`engram init refuses to run: ${root} is not inside a git repository.`);
  console.error('');
  console.error('  The memory bank is the audit trail: it has to be diffable and bisectable,');
  console.error('  and a non-git directory gives it no history at all.');
  console.error('');
  console.error('  Fix it in one of two ways:');
  console.error(`    git init            # make ${root} a repository`);
  console.error('    engram init --root <path-inside-a-repository>');
  console.error('');
  console.error('  Nothing was written.');
  return null;
}

/**
 * A break change must be loud.
 *
 * `--tools` and `--all` were removed with the other eight adapters. The argv parser ignores unknown
 * flags by design, so `engram init --tools claude` would otherwise *succeed* while doing something
 * different from what the caller asked — the worst possible outcome for a command that rewrites
 * files. Saying so costs one line.
 */
function warnRemovedToolFlags(args: Args): void {
  if (args.flags.has('tools') || args.flags.has('all')) {
    console.error(
      'warn: --tools/--all were removed — engram serves Pi only. The flag was ignored; AGENTS.md, ' +
        '.agents/skills/ and .pi/prompts/ are the carriers now.',
    );
  }
}

async function cmdInit(root: string, args: Args): Promise<number> {
  // Before option parsing side effects and before any write: refusing afterwards would mean
  // either partial output or a rollback, and a rollback that misses one file is worse than the flag.
  const repository = await requireGitRepository(root);
  if (repository === null) return 1;
  // A dry run must not report a success that a real run would refuse.
  if (repository.repositoryRoot !== root) {
    console.log(`note: the bank lives in ${root}; the enclosing repository root is ${repository.repositoryRoot}`);
  }

  warnRemovedToolFlags(args);

  const result = await runInit({
    root,
    notes: str(args.flags, 'notes'),
    force: flag(args.flags, 'force'),
    dryRun: flag(args.flags, 'dry-run'),
  });

  const created = result.files.filter((f) => f.action === 'created').map((f) => f.path);
  const kept = result.files.filter((f) => f.action === 'kept').map((f) => f.path);

  const updated = result.files.filter((f) => f.action === 'updated').length;
  const skipped = result.files.filter((f) => f.action === 'skipped').length;
  console.log(
    `engram init — ${created.length} created, ${kept.length} kept, ${updated} updated${skipped ? `, ${skipped} skipped` : ''}${flag(args.flags, 'dry-run') ? ' (dry run)' : ''}`,
  );
  if (flag(args.flags, 'dry-run')) for (const f of result.files) console.log(`  ${f.action.padEnd(7)} ${f.path}`);
  console.log('\nRule files:');
  console.log(toolSummary(result.tools));
  console.log(`\nNext: give .engram/BOOTSTRAP.md to your AI assistant, then run \`engram sync\`.`);
  for (const w of result.warnings) console.error(`warn: ${w}`);
  return 0;
}

async function cmdDump(root: string, args: Args): Promise<number> {
  const format = flag(args.flags, 'json') ? 'json' : 'markdown';
  const maxBytes = positiveInt(args.flags, 'max-bytes') ?? 1500;
  const result = await runDump({ root, format, maxBytes, projectName: str(args.flags, 'project') });

  if (result.exitCode === 2) {
    // --json must never emit prose on stdout: a consumer calling JSON.parse would throw.
    if (format === 'json') {
      process.stdout.write(`${JSON.stringify({ error: result.hint, bank: false }, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.hint ?? ''}\n`);
    }
    return 2;
  }
  for (const e of result.readErrors) console.error(`warn: unreadable ${e}`);
  for (const w of result.warnings) console.error(`warn: ${w}`);

  const out = renderDump(result, format);
  process.stdout.write(out.endsWith('\n') ? out : `${out}\n`);

  const outFile = str(args.flags, 'out');
  if (outFile) {
    // Honour the requested format: writing markdown into a .json file is a silent trap.
    const content = format === 'json' ? `${JSON.stringify(result.data, null, 2)}\n` : result.markdown;
    await writeFile(path.resolve(root, outFile), content);
    console.error(`wrote ${outFile} (${result.bytes} bytes)`);
  }
  if (format === 'markdown') {
    console.error(`# ${result.bytes} bytes · ${result.truncated ? 'at budget' : 'under budget'}`);
  }
  return 0;
}

async function cmdNew(root: string, args: Args): Promise<number> {
  const kind = args._[1] ?? '';
  const title = args._[2];
  // A declared section is scaffolded from the project's own `_TEMPLATE.md`, so `new` covers
  // `.ai/journal/` without engram knowing what a journal entry is.
  const { sections, warnings } = await readSections(root);
  for (const w of warnings) console.error(`warn: ${w}`);
  const section = sections.find((s) => s.name === kind);

  if (section && title) {
    try {
      const res = await runNewSection({ root, section, title, force: flag(args.flags, 'force') });
      console.log(res.created ? `created ${res.path}` : `exists (use --force to overwrite) ${res.path}`);
      return 0;
    } catch (err) {
      // Reachable only for a section that validated but still resolves outside its own directory —
      // a stack trace would bury the one line that matters.
      console.error(`error: ${(err as Error).message}`);
      return 1;
    }
  }
  if (!isMemoryKind(kind) || !title) {
    const declared = sections.map((s) => s.name).join('|');
    console.error(`usage: engram new <decision|session|pitfall|runbook${declared ? `|${declared}` : ''}> <title>`);
    return 1;
  }
  const res = await runNew({ root, kind: kind as MemoryKind, title, force: flag(args.flags, 'force') });
  console.log(res.created ? `created ${res.path}` : `exists (use --force to overwrite) ${res.path}`);
  return 0;
}

async function cmdGoal(root: string, args: Args): Promise<number> {
  const verb = args._[1] ?? '';
  const print = (r: { exitCode: number; lines: string[]; warnings: string[] }): number => {
    for (const l of r.lines) console.log(l);
    for (const w of r.warnings) console.error(`warn: ${w}`);
    return r.exitCode;
  };

  switch (verb) {
    case 'new': {
      const text = args._.slice(2).join(' ').trim();
      // `--cmd` is repeatable in intent but the arg parser keeps one value; a comma-free split would
      // silently drop the second gate, so every command must be passed as its own `--cmd`.
      const cmdFlag = args.flags.get('cmd');
      const commands = typeof cmdFlag === 'string' ? cmdFlag.split('&&').map((c) => c.trim()).filter(Boolean) : [];
      const metric = str(args.flags, 'metric');
      const checklist = flag(args.flags, 'checklist');

      let doneWhen: DoneWhen | undefined;
      if (commands.length) doneWhen = { kind: 'cmd', commands };
      else if (metric) {
        // `file:path:op:value` — parsed from the right so a path containing `:` survives.
        const m = /^(.+):(.+?):(>=|<=|==|!=|>|<):(.+)$/.exec(metric);
        if (!m) {
          console.error('error: --metric must look like <file>:<path>:<op>:<value>, e.g. out/eval.json:eval.mAP:>=:0.85');
          return 1;
        }
        const parsed = parseDoneWhen({ kind: 'metric', file: m[1], path: m[2], op: m[3] as MetricOp, value: Number.isFinite(Number(m[4])) ? Number(m[4]) : m[4] });
        if (parsed.error) {
          console.error(`error: ${parsed.error}`);
          return 1;
        }
        doneWhen = parsed.doneWhen ?? undefined;
      } else if (checklist) doneWhen = { kind: 'checklist', file: 'TASKS.md' };

      const identity = identityFromEnv();
      // The runtime already knows who is asking: pi exports its session file, herdr its pane id.
      // Recording them is what gives the goal a wake address to deliver to later; an explicit flag
      // wins, and a variable that is absent stays absent rather than claiming a holder named after
      // nothing.
      const sessionPath = str(args.flags, 'session') ?? identity.sessionPath;
      const paneId = str(args.flags, 'pane') ?? identity.paneId;

      return print(
        await runGoalNew({
          root,
          goal: text,
          today: new Date().toISOString().slice(0, 10),
          ...(doneWhen ? { doneWhen } : {}),
          force: flag(args.flags, 'force'),
          ...(sessionPath ? { sessionPath } : {}),
          ...(paneId ? { paneId } : {}),
        }),
      );
    }
    case 'status':
      return print(await runGoalStatus(root));
    case 'list':
      return print(await runGoalList(root));
    case 'check':
      return print(await runGoalCheck(root, str(args.flags, 'id')));
    case 'wake': {
      const reason = str(args.flags, 'reason');
      if (!reason) {
        console.error('error: goal wake needs --reason "<what ended>"');
        return 1;
      }
      return print(
        await runGoalWake({
          root,
          reason,
          id: str(args.flags, 'id'),
          token: str(args.flags, 'token'),
          deliver: flag(args.flags, 'deliver'),
        }),
      );
    }
    case 'handoff': {
      // `--json` is what the generated extension reads, for the same reason `event --json` exists:
      // the human output is prose, and a host must not parse prose.
      const identity = identityFromEnv();
      const res = await runGoalHandoff({
        root,
        id: str(args.flags, 'id'),
        reason: str(args.flags, 'reason'),
        name: str(args.flags, 'name'),
        paneId: str(args.flags, 'pane'),
        ...(identity.sessionPath ? { sessionPath: identity.sessionPath } : {}),
      });
      if (flag(args.flags, 'json')) {
        console.log(
          JSON.stringify({
            ok: res.exitCode === 0,
            // The lines are the record of the five steps; a host shows them and nothing else.
            message: res.lines.join('\n'),
            warnings: res.warnings,
          }),
        );
        return res.exitCode;
      }
      return print(res);
    }
    case 'unit': {
      const job = str(args.flags, 'job');
      if (!job) {
        console.error('error: goal unit needs the job to run: --job "<command>"');
        return 1;
      }
      const engram = str(args.flags, 'engram');
      // The id is positional in the documented usage (`goal unit <id> --job "…"`), and `--id` is
      // accepted too so the form matches every other verb.
      const unitId = str(args.flags, 'id') ?? args._[2];
      return print(
        await runGoalUnit({
          root,
          job,
          ...(unitId ? { id: unitId } : {}),
          write: flag(args.flags, 'write'),
          ...(engram ? { engram: [engram] } : {}),
        }),
      );
    }
    case 'baton': {
      const session = str(args.flags, 'session') ?? identityFromEnv().sessionPath;
      if (!session) {
        console.error('error: goal baton needs --session <path> (or run inside a pi session)');
        return 1;
      }
      return print(
        await runGoalBaton(root, session, str(args.flags, 'pane') ?? identityFromEnv().paneId, str(args.flags, 'id')),
      );
    }
    case 'close':
      return print(await runGoalClose(root, flag(args.flags, 'abandoned') ? 'abandoned' : 'cancelled', str(args.flags, 'id')));
    case 'event': {
      // The host wire surface. `--json` is not optional in spirit: the generated pi extension parses
      // stdout, so this branch prints exactly one JSON document and nothing else.
      const event = str(args.flags, 'type') ?? '';
      let report: Record<string, unknown> | undefined;
      const rawReport = str(args.flags, 'report');
      if (rawReport !== undefined) {
        try {
          report = JSON.parse(rawReport) as Record<string, unknown>;
        } catch {
          console.log(JSON.stringify({ ok: false, continue: false, message: null, notify: null, status: null, goalId: null, reason: '--report is not valid JSON', effects: [] }));
          return 1;
        }
      }
      const res = await runGoalEvent(
        root,
        {
          event,
          // The same runtime identity `goal new` records: pi exports the session file, herdr the pane
          // id. Refusing an event because a *hand-driven* call omitted `--session` refused the one
          // caller whose identity was never in doubt — the extension, which always passes it, was the
          // only caller that worked. An absent variable still stays absent, so the baton check keeps
          // refusing genuinely unidentified callers.
          ...(() => {
            const sessionPath = str(args.flags, 'session') ?? identityFromEnv().sessionPath;
            return sessionPath ? { sessionPath } : {};
          })(),
          ...(str(args.flags, 'reason') ? { reason: str(args.flags, 'reason') as string } : {}),
          ...(str(args.flags, 'token') ? { token: str(args.flags, 'token') as string } : {}),
          ...(report ? { report: report as never } : {}),
        },
        { digest: () => workingTreeDigest(root) },
      );
      console.log(JSON.stringify(res));
      return res.ok ? 0 : 1;
    }
    default:
      console.error(
        'usage: engram goal <new|status|list|check|wake|unit|handoff|baton|close|event>\n\n' +
          '  new "<goal>" [--cmd "a && b"] [--metric file:path:op:value] [--checklist]\n' +
          '  unit <id> --job "<command>" [--write]   # systemd unit that wakes on exit\n' +
          '  handoff [--reason "<why now>"] [--json]  # open the successor pane through herdr\n' +
          '  status | list | check [--id <id>] | close [--abandoned] [--id <id>]\n' +
          '  wake --reason "<why>" [--token <t>] | baton --session <path> [--pane <id>]\n' +
          '  event --type <settled|run-started|wake|reconcile|report|status> [--report <json>] [--session <path>]',
      );
      return 1;
  }
}

async function cmdConfig(root: string, args: Args): Promise<number> {
  const goalFlag = str(args.flags, 'goal');
  if (goalFlag !== undefined) {
    const value = goalFlag.toLowerCase();
    if (value !== 'on' && value !== 'off' && value !== 'true' && value !== 'false') {
      console.error('error: --goal takes on|off');
      return 1;
    }
    const enable = value === 'on' || value === 'true';
    await setGoalEnabled(root, enable);
    console.log(`goal engine ${enable ? 'enabled' : 'disabled'} in .engram/config.json`);
    if (enable) console.log('run `engram sync` to write .pi/extensions/engram-goal.ts');
    return 0;
  }

  const config = await readConfig(root);
  if (config === null) {
    console.error('no .engram/config.json yet — run `engram init` first');
    return 1;
  }
  if (flag(args.flags, 'json')) {
    // The same document the file holds, so a script never has to reimplement the defaults.
    console.log(JSON.stringify(config, null, 2));
    return 0;
  }
  console.log(`tool:  ${TOOLS.map((t) => t.id).join(', ')} (the only supported client)`);
  console.log(`goal:  ${config.goal?.enabled === true ? 'enabled' : 'disabled'}`);
  return 0;
}

async function cmdSync(root: string, args: Args): Promise<number> {
  warnRemovedToolFlags(args);
  const res = await runSync(root, flag(args.flags, 'dry-run'));
  for (const f of res.ruleFiles) console.log(`${f.action.padEnd(9)} ${f.path}`);
  console.log(`${res.skills.length} skill files materialised`);
  // Bounded on purpose: a project with hundreds of declared sections must not turn `sync` into a
  // wall of text. The full list is always readable in `.ai/sections.json`.
  if (res.declaredSections.length) {
    const shown = res.declaredSections.slice(0, 8).join(', ');
    const more = res.declaredSections.length > 8 ? `, … +${res.declaredSections.length - 8}` : '';
    console.log(`${res.declaredSections.length} declared section(s): ${shown}${more} (.ai/sections.json)`);
  }
  for (const p of res.pruned) console.log(`pruned     ${p}`);
  if (res.goalCarrier.action !== 'unchanged') {
    const c = res.goalCarrier;
    const label = c.planned ? `${c.action} (dry run)` : c.action;
    console.log(`${label.padEnd(16)} ${c.path}${res.goalEnabled ? '' : ' (goal disabled)'}`);
  }
  for (const m of res.missingSkills) console.error(`warn: missing canonical skill .ai/skills/${m}.md`);
  for (const w of res.warnings) console.error(`warn: ${w}`);
  // `sync` on an un-initialised repo must not look like success.
  return res.needsInit ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (flag(args.flags, 'version')) {
    console.log(VERSION);
    return 0;
  }
  if (!args._.length || flag(args.flags, 'help') || args._[0] === 'help') {
    console.log(HELP);
    return 0;
  }
  const root = path.resolve(str(args.flags, 'root') ?? process.cwd());
  const cmd = args._[0];
  switch (cmd) {
    case 'init':
      return cmdInit(root, args);
    case 'dump':
      return cmdDump(root, args);
    case 'new':
      return cmdNew(root, args);
    case 'goal':
      return cmdGoal(root, args);
    case 'sync':
      return cmdSync(root, args);
    case 'config':
      return cmdConfig(root, args);
    case 'tools':
      console.log(TOOLS.map((t) => `${t.id.padEnd(9)} ${t.label}`).join('\n'));
      return 0;
    default:
      console.error(`Unknown command "${cmd}".\n\n${HELP}`);
      return 1;
  }
}

/** True when this module is the process entry point (not when imported by tests). */
export function isEntryPoint(argv: string[] = process.argv): boolean {
  const script = argv[1];
  if (!script) return false;
  try {
    const self = pathToFileURL(fs.realpathSync(script)).href;
    // Compare both the symlink and its target: npm/pnpm expose `.bin/engram` as a symlink, and
    // Node resolves the main module to the real path. Without realpath the installed CLI exited
    // 0 with no output at all — a silent no-op that looks like success.
    if (import.meta.url === self) return true;
    const direct = pathToFileURL(path.resolve(script)).href;
    return import.meta.url === direct;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  ignoreBrokenPipe();
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
}