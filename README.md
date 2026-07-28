# Wisp

A minimal, folder-backed Markdown note editor built with [Electron](https://www.electronjs.org/). It opens a base folder ("vault"), shows a folder/file tree on the left, and edits files as **raw text** on the right. Every text file is assumed to be Markdown, but nothing is rendered — you always see and edit the plain source.

## Features

- **Pick a base folder** on first launch; the choice is remembered across sessions.
- **Folder/file tree** in the sidebar — folders first, then files, alphabetical. Expand/collapse folders, click a file to open it.
- **Raw-text editor** with a monospace font. No Markdown rendering — just the source.
- **Save** with `Ctrl/Cmd+S`; a status indicator shows `Saved` / `Unsaved changes`, and you're warned before discarding unsaved edits.
- **Find & replace** in the open file with the usual shortcuts: `Ctrl/Cmd+F` to search (seeded from the selection), `Ctrl/Cmd+G` or `F3` to step through matches (`⇧` to go back), `Esc` to close — leaving the caret on the match you stopped at. Every match is highlighted, in the raw, editor and preview views alike. Replace (`Cmd+⌥+F` / `Ctrl+H`) edits the Markdown source, so it opens the raw view.
- **Every shortcut in one place**: `Help ▸ Keyboard Shortcuts` (`Cmd/Ctrl+/`) lists them all, written the way your OS writes them.
- **Tables**, without counting pipes: `Cmd/Ctrl+⇧+T` drops in a 3×3 table (a heading row plus two body rows), and `Cmd/Ctrl+⌥+←→↑↓` grows the table the cursor is in — a column to the left or right, a row above or below. It works in the raw and editor views alike: raw keeps the source columns padded and lined up, the editor adds the cells to the table you can see. Nothing goes above the heading row, since Markdown tables only have the one.
- **File management**: create files (supports nested paths like `folder/note.md`), create folders, rename, and delete (via right-click), plus refresh and change-folder buttons.
- **Git, if your vault is a repository** — and nothing at all if it isn't, so a plain folder works exactly as before. When the folder *is* a repo, a bar above the tree shows the branch, how far ahead/behind the remote you are, and how many files have changed; every file in the tree is marked with its status (`M` modified, `A` added, `?` untracked, `D` deleted, `R` renamed, `!` conflicted), and a folder gets a dot when something inside it has changed. **Pull** (`↓`) and **Commit & push** (`↑`) sit in the same bar — committing asks for a message and shows exactly which files are included, with a checkbox for whether to push afterwards. A merge conflict marks the affected files and blocks committing until you've resolved them.
- **Diffs**, shown right where the editor is — **Diff** joins Raw / Editor / Preview as a fourth view of the open file, so the tree stays beside it. Two renderings: **Visual**, a side-by-side view of HEAD against your working copy with the individual changed *words* picked out inside a rewritten line, and **Raw**, git's own unified patch. Reach it from the `Diff` button, from `◨` in the git bar (which lists everything that's changed, including deleted files), or by right-clicking a changed file → *Show diff*.
- **Discard changes** — right-click to put things back to their last committed state: a file, a folder (which also brings back files deleted inside it), or the whole vault by right-clicking empty space in the tree. It always shows you exactly which files it will touch first. **Untracked files are never deleted**: git has no version to restore them to, so discarding them would be an unrecoverable delete rather than an undo — they're left alone and you're told so.
- **Reminders**: a list in the lower half of the sidebar (drag the separator to resize), soonest first, with overdue entries highlighted. Add one with `＋`, or right-click a file in the tree. Reminders can repeat daily/weekly/monthly/yearly and can link to a note. When one falls due the app raises its window and shows a large popup with snooze / open-note / done. The list is stored as plain JSON in `.wisp-reminders.json` at the vault root.
- Hidden by default: `node_modules` and every dot-prefixed entry (`.git`, `.DS_Store`, other editors' per-vault config folders, `.wisp-reminders.json`).
- Secure by design: context isolation on, Node integration off, all file access goes through a minimal IPC bridge with path-traversal guards.

## Install (macOS, Apple Silicon)

```bash
brew tap oglimmer/wisp https://github.com/oglimmer/wisp
brew install --cask wisp
```

The build is signed and notarized, so it opens without a Gatekeeper prompt. `brew upgrade --cask wisp`
updates it; `brew uninstall --zap --cask wisp` removes the app together with its stored config.

macOS arm64 is the only published target. On anything else, run from source (below).

> **Smart insert needs the `claude` CLI.** The app looks for it on `PATH` plus the usual install
> locations (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/.claude/local`). If it lives
> somewhere unusual, launch Wisp from a terminal so it inherits your shell's `PATH`.

## Requirements (running from source)

- [Node.js](https://nodejs.org/) 18+ (tested on 22)
- npm

## Getting started

```bash
npm install
npm start
```

On first launch, click **Open Folder…** and choose any directory of notes.

> **Note:** `node_modules` is platform-specific because Electron ships a native binary. If you move this project between machines or operating systems, delete `node_modules` and run `npm install` again on the target machine — don't copy it over.

## Usage

| Action | How |
|--------|-----|
| Open a file | Click it in the tree |
| Save | `Ctrl+S` / `Cmd+S` |
| Find in the open file | `Ctrl+F` / `Cmd+F` |
| Next / previous match | `Ctrl+G` / `Cmd+G` / `F3` (add `Shift` to reverse), or `Enter` in the find field |
| Find & replace | `Ctrl+H` / `Cmd+⌥+F` — `Enter` replaces the current match, `Ctrl/Cmd+Enter` replaces all |
| Match case | `Aa` in the find bar |
| Close the find bar | `Esc` |
| New file | `＋` in the sidebar header (name can include subfolders, e.g. `ideas/todo.md`) |
| New folder | 🗀 in the sidebar header |
| Rename / delete | Right-click an item in the tree |
| New reminder | `＋` in the Reminders header, or right-click a file → *Add reminder…* |
| Edit a reminder | Click it in the list (right-click for open / complete / delete) |
| Complete a reminder | `✓` on hover — repeating ones roll forward to the next occurrence |
| Refresh tree | `⟳` in the sidebar header |
| Change base folder | `⋯` in the sidebar header |
| Diff the open file | `Diff` in the view toggle, next to Raw / Editor / Preview |
| Switch visual / raw diff | `Visual` / `Raw`, shown beside the toggle while Diff is up |
| List everything changed | `◨` in the git bar — pick one to see its diff |
| Diff one file | Right-click a changed file → *Show diff* |
| Discard a file's changes | Right-click it → *Discard changes…* |
| Discard a folder's changes | Right-click the folder → *Discard changes in folder…* |
| Discard everything | Right-click empty space in the tree → *Discard all changes…* |
| Pull | `↓` in the git bar |
| Commit & push | `↑` in the git bar — type a message, then `Ctrl/Cmd+Enter` |

## Project structure

| File | Role |
|------|------|
| `main.js` | Main process — window creation, folder dialog, tree building, file read/write/create/rename/delete IPC handlers, and the git integration (the only place `git` is run) |
| `preload.js` | Secure `contextBridge` API exposed to the renderer |
| `index.html` | Welcome screen + sidebar/editor layout |
| `renderer.js` | UI logic: tree rendering, open/save, context menu, keyboard shortcuts |
| `styles.css` | Dark theme |
| `package.json` | Metadata, dependencies, scripts, and the `electron-builder` config |
| `build/entitlements.mac.*.plist` | Hardened-runtime entitlements for the signed build |
| `Casks/wisp.rb` | Homebrew cask (version + sha256 bumped by CI on each tag) |
| `.github/workflows/release.yml` | Builds, signs, notarizes and releases the macOS arm64 build |

## Releasing

`npm run dist` builds a local `dist/Wisp-<version>-arm64.dmg` (macOS only — signing is skipped
unless certificates are present in your keychain).

A real release is cut by tagging:

```bash
npm version patch          # or minor / major — bumps package.json and tags
git push --follow-tags
```

The tag must match `package.json`'s version; CI fails fast otherwise. The workflow then builds,
signs, notarizes, attaches the `.dmg` and `.zip` to a GitHub release, and commits the matching
cask bump to the default branch.

If the signing secrets below are **not** configured, a tagged build still publishes — but as an
unsigned prerelease, and the cask is left alone, so `brew install --cask wisp` never serves a build
Gatekeeper would block. Opening an unsigned build needs
`xattr -dr com.apple.quarantine /Applications/Wisp.app`.

These repository secrets are what turn a tagged build into a signed, notarized one.
**[docs/SIGNING.md](docs/SIGNING.md) walks through obtaining every one of them** — Apple Developer
enrollment, creating the certificate, exporting the `.p12`, and the app-specific password.

| Secret | What it is |
|--------|------------|
| `MACOS_CERTIFICATE` | base64 of the *Developer ID Application* `.p12` |
| `MACOS_CERTIFICATE_PASSWORD` | password used when exporting that `.p12` — may be empty if you exported without one |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | 10-character Apple Developer team ID |

Running the workflow manually (**Actions → Release → Run workflow**) with no secrets set produces an
unsigned ad-hoc build as a downloadable artifact — useful for checking the packaging without certificates.

## License

MIT
