/**
 * The single place the version string lives.
 *
 * It used to be a literal in `cli.ts`, which was fine until `sync` needed to stamp the version into
 * a generated file: importing `cli.ts` from `commands/` would have made the CLI depend on itself
 * (and `cli.ts` already imports `commands/`). A leaf module with one constant is the whole fix, and
 * `test/cli.test.ts` keeps it honest by comparing `--version` against `package.json`.
 */
export const VERSION = '0.5.0';
