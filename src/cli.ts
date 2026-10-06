#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TOOLS, DEFAULT_TOOL_IDS, allToolIds } from './adapters/index.js';
import { runInit, runSync } from './commands/init.js';
import { renderDump, runDump } from './commands/dump.js';
import { isMemoryKind, runNew, type MemoryKind } from './commands/new.js';
import { SKILL_NAMES } from './templates/skills.js';
import { toolSummary } from './templates/meta-prompt.js';
import { writeFile } from './core/project.js';

const VERSION = '0.3.0';

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
  engram new <kind> <title>    scaffold one memory file (decision|session|pitfall|runbook)
  engram sync [options]        refresh contracts + re-materialise skill files
  engram tools                 list supported AI tools
  engram --help | --version

INIT OPTIONS
  --tools <a,b,c>    tools to configure (default: ${DEFAULT_TOOL_IDS.join(',')})
  --all              configure every supported tool
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
  --tools <a,b,c>    limit to specific tools (default: the set recorded by \`engram init\`)
  --all              sync every supported tool, ignoring the recorded set

SUPPORTED TOOLS
${TOOLS.map((t) => `  ${t.id.padEnd(9)} ${t.label}`).join('\n')}

SKILLS (canonical: .ai/skills/*.md)
  ${SKILL_NAMES.map((s) => `/${s}`).join('  ')}
`;

async function cmdInit(root: string, args: Args): Promise<number> {
  const all = flag(args.flags, 'all');
  const list = str(args.flags, 'tools');
  const toolIds = all
    ? allToolIds()
    : (list ?? DEFAULT_TOOL_IDS.join(','))
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

  const result = await runInit({
    root,
    toolIds,
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
  if (!isMemoryKind(kind) || !title) {
    console.error('usage: engram new <decision|session|pitfall|runbook> <title>');
    return 1;
  }
  const res = await runNew({ root, kind: kind as MemoryKind, title, force: flag(args.flags, 'force') });
  console.log(res.created ? `created ${res.path}` : `exists (use --force to overwrite) ${res.path}`);
  return 0;
}

async function cmdSync(root: string, args: Args): Promise<number> {
  const list = str(args.flags, 'tools');
  const toolIds = list ? list.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const res = await runSync(root, toolIds, flag(args.flags, 'dry-run'), flag(args.flags, 'all'));
  for (const f of res.ruleFiles) console.log(`${f.action.padEnd(9)} ${f.path}`);
  console.log(`${res.skills.length} skill files materialised (${res.scope === 'config' ? 'recorded tool set' : res.scope})`);
  for (const p of res.pruned) console.log(`pruned     ${p}`);
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
    case 'sync':
      return cmdSync(root, args);
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