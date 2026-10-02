# Release engram to npm and GitHub

**Applies to:** publishable releases · **Owner:** lead architect · **Last verified:** unverified

## When to use this

Cutting a tagged release. `engram` is a CLI that writes files into other people's repositories, so
a release is a trust event: verify the tarball contents before pushing it.

## Preconditions

- npm login authenticated (`npm whoami` shows the intended account)
- `package.json` `name`, `version`, `repository` correct
- clean working tree on `main`

## Two-factor note

The account has 2FA enforced for publishing, so `npm publish` fails with a bare E403. An
`--otp=<code>` flag does **not** work when a human relays the code to an agent: the TOTP window is
about 30 seconds and a round-trip through a tool call loses it. The npm login token on the machine
is an OAuth token, which is why the server still reports "2FA required".

So: **the human runs the final `npm publish` themselves**, or the repo gets a granular access token
with *bypass 2FA* and the automation stops asking for codes.

## Procedure

```bash
npm test                                  # build + full suite must be green
npm pack --dry-run                        # inspect the tarball file list
npm publish --access public                # first release only; npm login first
git tag -a v0.2.1 -m "engram 0.1.0"
git push origin main --follow-tags
```

Then create the GitHub release from the tag and paste `.engram/BOOTSTRAP.md` output expectations
into the release notes.

## Verification

```bash
npm view engram version
npx engram@latest --version
npx engram@latest tools
npx engram@latest init --tools agents --dry-run   # in a scratch directory
```

## Rollback

```bash
npm unpublish engram@0.1.0     # only within 72h of publishing
git push origin :refs/tags/v0.2.1
```

After 72 hours the version is permanent: publish `0.1.1` and mark `0.1.0` as deprecated on npm.