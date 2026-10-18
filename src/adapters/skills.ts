import path from 'node:path';
import { yamlScalar } from '../core/yaml.js';
import type { SkillSource } from '../templates/skills.js';
import type { SkillSink } from './index.js';
import { generatedHeader } from './rules.js';

/**
 * Two carriers, and that is the whole surface since the 2026-10-18 reduction.
 *
 * - `agent-skills` — the Agent Skills standard (`<name>/SKILL.md` with YAML frontmatter), read by Pi
 *   from `.agents/skills`.
 * - `prompt-md-args` — a Markdown slash command with `description` + `argument-hint` frontmatter and
 *   Pi's `$ARGUMENTS` placeholder.
 *
 * A third (`prompt-toml`, for Gemini CLI) and a `copilot` frontmatter dialect were deleted with
 * their adapters rather than left as unreachable branches: a renderer no selected tool can reach is
 * a place for a future bug to hide, and the tests that covered them covered nothing shipped.
 */

export interface MaterializedFile {
  /** Path relative to the project root. */
  path: string;
  content: string;
}

/** Frontmatter + body of a canonical skill, used verbatim for Agent Skills dirs. */
function agentSkillFile(spec: SkillSource, sourcePath: string): string {
  const header = ['---', `name: ${spec.name}`, `description: ${yamlScalar(spec.description)}`, '---'].join('\n');
  return `${header}\n\n${generatedHeader(sourcePath)}\n\n${spec.body.trim()}\n`;
}

/** Markdown slash command: the delimited placeholder becomes the tool's own argument syntax. */
function promptTemplate(spec: SkillSource, sourcePath: string): string {
  const body = substituteArgs(spec.body, '$ARGUMENTS');
  const fm = [
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

/**
 * Human-facing name of the command this sink produces, for init output.
 *
 * Pi invokes an Agent Skill as `/skill:<name>` and a prompt template as `/<name>`. The per-tool
 * `invoke` override it used to consult existed for Claude Code and Codex, both removed.
 */
export function commandNameFor(sink: SkillSink, spec: SkillSource): string {
  switch (sink.kind) {
    case 'agent-skills':
      return `/skill:${spec.name}`;
    case 'prompt-md-args':
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
          path: path.posix.join(sink.dir, `${spec.name}.md`),
          content: promptTemplate(spec, sourcePath),
        };
    }
  });
}
