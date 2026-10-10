import path from 'node:path';
import { yamlScalar } from '../core/yaml.js';
import type { SkillSource } from '../templates/skills.js';
import type { SkillSink } from './index.js';
import { generatedHeader } from './rules.js';

export interface MaterializedFile {
  /** Path relative to the project root. */
  path: string;
  content: string;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Frontmatter + body of a canonical skill, used verbatim for Agent Skills dirs. */
function agentSkillFile(spec: SkillSource, sourcePath: string): string {
  const header = ['---', `name: ${spec.name}`, `description: ${yamlScalar(spec.description)}`, '---'].join('\n');
  return `${header}\n\n${generatedHeader(sourcePath)}\n\n${spec.body.trim()}\n`;
}

/** Slash-command template: `ARGUMENTS` placeholder becomes the tool's own syntax. */
function promptTemplate(spec: SkillSource, sourcePath: string, frontmatter: 'slash' | 'copilot'): string {
  // Copilot prompt files use VS Code variable syntax, not `$ARGUMENTS`; shipping the literal
  // token would hand the model a garbled instruction instead of an argument.
  const body = substituteArgs(spec.body, frontmatter === 'copilot' ? '${input:arguments}' : '$ARGUMENTS');
  const fm =
    frontmatter === 'copilot'
      ? ['---', 'agent: agent', `description: ${yamlScalar(spec.description)}`, '---'].join('\n')
      : [
          '---',
          `description: ${yamlScalar(spec.description)}`,
          `argument-hint: ${yamlScalar(spec.argumentHint ?? 'arguments')}`,
          '---',
        ].join('\n');
  return `${fm}\n\n${generatedHeader(sourcePath)}\n\n${body}\n`;
}

/**
 * Replace only the delimited `<ARGUMENTS>` placeholder.
 *
 * The old version did a global replace of `ARGUMENTS`, which also rewrote the sentence that
 * *documents* the placeholder — 16 generated carriers shipped "$ARGUMENTS: `$ARGUMENTS` is the
 * optional topic slug", i.e. a garbled instruction about where to get the slug.
 */
export const substituteArgs = (body: string, token: string): string =>
  body.replaceAll('<ARGUMENTS>', token);

function tomlEscape(body: string): string {
  return body.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
}

function geminiCommand(spec: SkillSource, sourcePath: string): string {
  const body = tomlEscape(substituteArgs(spec.body, '{{args}}'));
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
export function commandNameFor(sink: SkillSink, spec: SkillSource): string {
  switch (sink.kind) {
    case 'agent-skills':
      return sink.invoke === 'plain' ? `/${spec.name}` : `/skill:${spec.name}`;
    case 'prompt-md-args':
      return `/${sink.prefix ?? ''}${spec.name}`;
    case 'prompt-toml':
      return `/${spec.name}`;
  }
}

/** Materialise every canonical skill spec into one tool sink. */
export function materialize(sink: SkillSink, specs: SkillSource[], sourceDir = '.ai/skills'): MaterializedFile[] {
  return specs.map((spec) => {
    const sourcePath = path.posix.join(sourceDir, `${spec.name}.md`);
    switch (sink.kind) {
      case 'agent-skills':
        return { path: path.posix.join(sink.dir, spec.name, 'SKILL.md'), content: agentSkillFile(spec, sourcePath) };
      case 'prompt-md-args':
        return {
          path: path.posix.join(sink.dir, `${sink.prefix ?? ''}${spec.name}${sink.suffix ?? '.md'}`),
          content: promptTemplate(spec, sourcePath, sink.frontmatter ?? 'slash'),
        };
      case 'prompt-toml':
        return { path: path.posix.join(sink.dir, `${spec.name}.toml`), content: geminiCommand(spec, sourcePath) };
    }
  });
}