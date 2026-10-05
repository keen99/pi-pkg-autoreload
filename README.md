# pi-pkg-autoreload

![CI](https://github.com/keen99/pi-pkg-autoreload/actions/workflows/ci.yml/badge.svg)
![release-watch](https://github.com/keen99/pi-pkg-autoreload/actions/workflows/release-watch.yml/badge.svg)
[![pi tested](https://img.shields.io/github/v/release/keen99/pi-pkg-autoreload?label=pi%20tested%200.75.0%20%E2%86%92)](https://github.com/keen99/pi-pkg-autoreload/releases)

Pi extension that makes `/reload` actually pick up remote changes for git packages.

Zero config. Drop in, done.

## Why

Pi's `/reload` only rereads files from disk. For git packages that means it picks up whatever is in `~/.pi/agent/git/<owner>/<repo>/`, NOT the latest remote.

After `git push` (or merging a PR), a `/reload` in a live session silently does nothing — you must exit, `pi update` (or manual `git pull`), relaunch. That is the "extra step" friction for every git package.

Local extensions don't have this problem because edits land directly on disk. This extension closes the gap so git packages behave the same way on reload.

## What it does

Monkeypatches `InteractiveMode.handleReloadCommand` so `/reload`:

1. Collects git packages from `settings.json` (user + project scopes)
2. Runs `git pull --ff-only` in each package dir (best-effort, errors surfaced as status)
3. Calls the original `handleReloadCommand()` — files on disk now include any pulled updates

Everything else about `/reload` (keybindings, skills, prompts, themes) is untouched. It just also pulls first.

## Install

Add to `settings.json`:

```json
{
  "packages": ["git:github.com/keen99/pi-pkg-autoreload"]
}
```

Then `pi install` or restart pi.

## Scope

- **Interactive mode only** — that's where `/reload` lives. No effect in print/rpc modes.
- **Git packages only** — npm/local packages are left alone.
- **Best-effort pulls** — if `git pull` fails for a package (network, conflicts), it is reported via status and `/reload` continues with whatever is on disk.
- **`--ff-only`** — no merge commits, no surprise branches. A diverged local just fails the pull and gets reported.

## Limitations

- **Monkeypatch, not override.** Extension commands can't intercept built-in `/reload` (pi matches builtins before firing the input event). So this patches the handler method on the prototype instead.
- **Module path.** `InteractiveMode` is imported from the installed pi `dist/` via computed path (the package `exports` map blocks deep imports). If pi restructures that path in a future version, this extension will no-op (patch guard checks for the method's existence).
- **Auth.** Uses your system git credentials (SSH key, credential helper). No new auth setup.

## License

MIT

## Development

`npm test` runs the unit suite; `npm run test:matrix` boots every
stable pi release (>= 0.75.0) in RPC mode and asserts the
`handleReloadCommand` patch actually installs on the real process
(the extension's whole job — it silently no-ops if pi internals
move, which is exactly what the matrix catches). Cached installs
live in `.matrix-cache/`.

Note: pi 0.85.0 is the one version the matrix cannot pass — that
release shipped `interactive-mode.js` with an undeclared dependency
on `@earendil-works/pi-server`, so the file cannot be imported at
all (pi packaging bug, fixed in 0.85.1). The extension cannot patch
on 0.85.0; the badge and releases reflect that honestly.

Real bugs found and fixed while building the harness: pinned
`git:host/owner/repo@ref` https-form packages were not detected as
pinned and would be hard-reset to upstream; transitive deps of
active npm packages were flagged stale and uninstalled; `isGitDirty`
and the update spawns used `require()` which throws in ESM contexts.
