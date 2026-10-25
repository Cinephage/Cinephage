# npm stub

This directory is a deliberate empty stub for the `npm` package, wired in
through the `"npm": "file:tools/npm-stub"` override in the root
`package.json`.

## Why it exists

`semantic-release` hard-depends on `@semantic-release/npm`, which in turn
depends on the full `npm` package. Cinephage's release config
(`.releaserc.json`) does not include the npm plugin — the app is private and
never publishes to the npm registry — so that whole subtree is dead weight.

The `npm` tarball ships almost all of its dependencies **bundled inside
itself** (`"inBundle": true` in the lockfile). npm overrides cannot reach
bundled dependencies, and while npm 12.2.0 (the latest release at the time)
still bundled `ip-address@10.5.0`, `brace-expansion@5.0.9`, and
`undici@6.28.0`, those versions sat inside three open Dependabot alert
ranges with no way to patch or bump them. Stubbing the package out removes
the entire subtree — and every bundled copy of those dependencies — from
the lockfile.

## If something ever needs the real npm package

Remove the `"npm"` override from `package.json`, reinstall, and re-audit
the tree for bundled vulnerabilities before committing.
