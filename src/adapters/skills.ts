import path from 'node:path';
import type { SkillSpec } from '../templates/skills.js';
import type { SkillSink } from './index.js';
import { generatedHeader } from './rules.js';

export interface MaterializedFile {
  /** Path relative to the project root. */
  path: string;
  content: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Frontmatter + body of a canonical skill, used verbatim for Agent Skills dirs. */
function agentSkillFile(spec: SkillSpec, sourcePath: string): string {
  const header = ['---', `name: ${spec.name}`, `description: ${oneLine(spec.description)}`, '---'].join('\n');
  return `${header}\n\n${generatedHeader(sourcePath)}\n\n${spec.body.trim()}\n`;
}

/** Slash-command template: `ARGUMENTS` placeholder becomes the tool's own syntax. */
function promptTemplate(spec: SkillSpec, sourcePath: string, frontmatter: 'slash' | 'copilot'): string {
  const body = spec.body.trim().replace(/ARGUMENTS/g, '$ARGUMENTS');
  const fm =
    frontmatter === 'copilot'
      ? ['---', 'mode: agent', `description: ${oneLine(spec.description)}`, '---'].join('\n')
      : [
          '---',
          `description: ${oneLine(spec.description)}`,
          `argument-hint: ${yamlString(spec.argumentHint)}`,
          '---',
        ].join('\n');
  return `${fm}\n\n${generatedHeader(sourcePath)}\n\n${body}\n`;
}

/** YAML single-quoted scalar; `'` is escaped by doubling, as the YAML spec requires. */
function yamlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function tomlEscape(body: string): string {
  return body.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
}

function geminiCommand(spec: SkillSpec, sourcePath: string): string {
  const body = tomlEscape(spec.body.trim().replace(/ARGUMENTS/g, '{{args}}'));
  return [
    `# ${generatedHeader(sourcePath)}`,
    `description = "${oneLine(spec.description).replace(/"/g, '\\"')}"`,
    '',
    'prompt = """',
    body,
    '"""',
    '',
  ].join('\n');
}

/** Human-facing name of the command this sink produces, for init output. */
export function commandNameFor(sink: SkillSink, spec: SkillSpec): string {
  switch (sink.kind) {
    case 'agent-skills':
      return `/skill:${spec.name}`;
    case 'prompt-md-args':
      return `/${sink.prefix ?? ''}${spec.name}`;
    case 'prompt-toml':
      return `/${spec.name}`;
  }
}

/** Materialise every canonical skill spec into one tool sink. */
export function materialize(sink: SkillSink, specs: SkillSpec[], sourceDir = '.ai/skills'): MaterializedFile[] {
  return specs.map((spec) => {
    const sourcePath = path.posix.join(sourceDir, `${spec.name}.md`);
    switch (sink.kind) {
      case 'agent-skills':
        return { path: path.posix.join(sink.dir, spec.name, 'SKILL.md'), content: agentSkillFile(spec, sourcePath) };
      case 'prompt-md-args':
        return {
          path: path.posix.join(sink.dir, `${sink.prefix ?? ''}${spec.name}.md`),
          content: promptTemplate(spec, sourcePath, sink.frontmatter ?? 'slash'),
        };
      case 'prompt-toml':
        return { path: path.posix.join(sink.dir, `${spec.name}.toml`), content: geminiCommand(spec, sourcePath) };
    }
  });
}