/**
 * Minimal YAML scalar quoting.
 *
 * Every value engram writes into a tool's frontmatter must go through here.
 *
 * The bug this exists to prevent: a YAML *plain* scalar cannot contain `": "` — the parser reads
 * it as a nested mapping and rejects the whole file. Four of engram's skill descriptions contain a
 * colon followed by a space ("…memory bank: architecture drift…"), so every generated
 * `SKILL.md` and prompt file for those skills was silently unloadable. The carriers were emitted as
 * `description: <raw text>`, and the test asserted only `^description: \S`, so it never noticed.
 *
 * Single quotes are the safest choice here: no escape sequences to get wrong, and `'` is escaped by
 * doubling it.
 */
export const yamlScalar = (value: string): string => `'${value.replaceAll("'", "''").replace(/\s+/g, ' ').trim()}'`;

/**
 * Reject frontmatter that a YAML parser would refuse.
 *
 * Deliberately dependency-free: the tool ships zero runtime dependencies and a test-only YAML
 * library would be a 400 kB install for contributors to catch one class of error. This checks the
 * specific shape that breaks — an unquoted value containing a colon-space or a leading indicator.
 */
export function validateFrontmatter(frontmatter: string): string[] {
  const problems: string[] = [];
  for (const [i, line] of frontmatter.split('\n').entries()) {
    if (!line.trim() || line.trim() === '---') continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) {
      problems.push(`line ${i + 1}: not a key: value pair → ${line}`);
      continue;
    }
    const value = (m[2] ?? '').trim();
    const quoted = value.startsWith("'") && value.endsWith("'") && value.length > 1;
    if (!quoted && value.includes(': ')) {
      problems.push(`line ${i + 1}: unquoted value contains ": " → parsed as a nested mapping`);
    }
    if (!quoted && /^-?\d+(\.\d+)?$/.test(value)) {
      problems.push(`line ${i + 1}: unquoted value looks like a number`);
    }
  }
  return problems;
}