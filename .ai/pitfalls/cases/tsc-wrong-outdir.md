# `tsc` can exit 0 while emitting nothing

**Status:** 🟠 medium · **First hit:** 2026-10-01 · **Hits since:** 0

## Symptom

```
$ npx tsc -p tsconfig.json
$ echo $?
0
$ ls build/src
ls: cannot access 'build/src': No such file or directory
```

No output, no error, no `build/` directory. `package.json` pointed `bin` at a directory that did not
exist, and the failure surfaced later as "file not found" from an unrelated command.

## Root cause

`tsc` exited 0 because it compiled successfully — into `outDir` as declared in `tsconfig.json`
(`dist-build`), while `package.json` `bin`/`exports`/`files` and `npm run test` all referenced
`build/`. Type-checking and artifact wiring are separate concerns; nothing cross-checks them.

## Fix

Set `"outDir": "build"` in `tsconfig.json` to match `package.json`, rebuild, verify the tree:

```
$ npx tsc -p tsconfig.json && ls build/src
adapters  cli.js  commands  core  index.js  templates
```

## Guard

- `npm run build` is followed by `test`, which imports from `build/` — the suite cannot pass if the
  output path is wrong, so CI catches this on the first run.
- Before committing a build-config change, run `node build/src/cli.js --version` and confirm it
  prints the version, not "cannot find module".
- When adding an npm script that reads compiled output, use the same literal path as `bin` in
  `package.json`; never introduce a second spelling of the output directory.