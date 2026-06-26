# pi-pkg-autoreload

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
