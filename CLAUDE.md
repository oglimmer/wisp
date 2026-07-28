# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies (Electron ships a platform-specific native binary; **never copy `node_modules` between machines/OSes** — reinstall on the target, or you'll get `spawn ENOEXEC`).
- `npm start` — launch the app (`electron .`).
- `npm run dist` — package a macOS arm64 `.dmg` + `.zip` into `dist/` via electron-builder (macOS host only).

There is no unit-test suite. `./oglimmer.sh test` (also run before `release`)
does the static checks: `node --check` on main/preload/renderer/*, an Acorn
unbound-name scan of renderer modules (`scripts/check-unbound.js` — catches
missing imports after the module split), packaging/HTML/cask consistency,
yamllint, and shellcheck.

## Packaging & release

macOS arm64 is the **only** published target. electron-builder is configured in `package.json`'s
`build` field; `build/entitlements.mac.plist` (+ `.inherit.`) carry the hardened-runtime entitlements
Electron needs (JIT, unsigned executable memory, library validation off).

**App icon.** `build/` is `buildResources`, so the icon lives there. **`build/icon.icns` is the source
of truth** — `mac.icon` points at it, and electron-builder copies a supplied `.icns` into the bundle
verbatim rather than re-rendering it, which is the whole point: no resampling between the artwork and
the shipped app. It carries `icp4`/`icp5`/`ic07`/`ic08`/`ic09` (16/32/128/256/512); there is no `ic10`
(1024), so macOS upscales for 512pt Retina previews — add one if a 1024 render ever exists.
`build/icons/16x16.png` … `512x512.png` and `build/icon.png` (the 512) are *extracted from* the icns
for non-mac use, so regenerate them from it rather than editing them separately. The artwork already
carries the rounded-squircle mask and a transparent margin, so nothing masks or pads it; replacements
should come pre-masked the same way.

`.github/workflows/release.yml` runs on `v*` tags: it checks the tag matches `package.json`'s version,
builds signed + notarized (certs and Apple credentials come from repo secrets), publishes a GitHub
release, then rewrites `version`/`sha256` in `Casks/wisp.rb` on the default branch — that cask is the
tap users install from. Without signing secrets the build still happens, ad-hoc signed instead: a
`workflow_dispatch` run uploads it as a CI artifact, a tag publishes it as a prerelease. Both skip the
cask bump, so `brew install` only ever serves a signed, notarized build.

Two packaging-specific gotchas worth remembering:

- **The renderer loads `marked`/`turndown` by relative `node_modules/...` path** from `index.html`.
  That works inside `app.asar`, and electron-builder always bundles production dependencies, so the
  `files` allowlist only needs the app's own sources.
- **A bundled `.app` launched from Finder gets a bare `PATH`** (`/usr/bin:/bin:/usr/sbin:/sbin`), which
  would make `spawn('claude', …)` fail with `ENOENT` even for users who have the CLI. `claudeEnv()` in
  `main.js` appends the usual install locations before spawning; extend that list rather than assuming
  the inherited environment.

## Architecture

Wisp is a single-window Electron app: a folder/file tree on the left, an editor on the right. Every text file is treated as Markdown. For Markdown files the editor pane offers a three-way view toggle (`viewMode`, persisted in `localStorage`): **Raw** (the plain-text source in a `<textarea>` — the canonical, always-available mode), **Editor** (a `contenteditable` WYSIWYG view), and **Preview** (read-only rendered Markdown). Non-Markdown files are always edited raw.

The whole app is built around Electron's **three-context security model**, and understanding the boundary between the contexts is the key to working here:

- **`main.js` (main process, Node.js)** — owns all filesystem and OS access. Every filesystem operation lives here as a handler (`read-tree`, `read-file`, `write-file`, `create-file`, `create-folder`, `delete-path`, `rename-path`, `read-reminders`, `write-reminders`), plus git (`git-info`, `git-pull`, `git-commit`, `git-diff`, `git-revert` — the only place `git` is ever spawned), folder picking (`choose-folder`), window raising (`alert-window`), revealing an entry in the
  OS file manager (`reveal-path`) and config. The renderer has **no direct fs access** — anything touching disk must be added as a handler here.
- **`preload.js`** — the only bridge between the two worlds. Runs with `contextIsolation: true` / `nodeIntegration: false` and exposes a minimal, hand-listed API on `window.api` via `contextBridge`. A new main-process handler is invisible to the UI until a corresponding method is added here.
- **`renderer/` (renderer, browser context)** — all UI logic and state, split into ES modules with
  `renderer/index.js` as the entry point (see **The renderer's modules**). Talks to disk **only**
  through `window.api.*`, which it gets from `renderer/api.js`. It never `require`s Node modules.

So adding any file operation is always a three-file change: handler in `main.js` → method in `preload.js` → call in a `renderer/` module.

Traffic runs the other way exactly once — the app menu (see **Keyboard shortcuts help**) — and it
crosses the same bridge: `webContents.send` in main, an `ipcRenderer.on` subscription hand-listed in
preload, a callback registered in the renderer. Preload passes the payload on but never the event
object, which carries a handle on the sender.

### The renderer's modules

`renderer/` is plain ES modules — no bundler, no build step. `index.html` loads
`renderer/index.js` with `type="module"` and the browser fetches the graph.

**This is why the window is served from a custom `app://` scheme rather than `loadFile()`.**
Chromium refuses a `<script type="module">` on a `file://` page: module fetches go through CORS
and a `file://` origin is opaque. So `main.js` registers `app` as a **standard, secure** scheme
(`standard` is what gives it real origin semantics — relative URLs resolve, and `localStorage`
works) and `protocol.handle` serves the app's own directory, refusing anything that resolves
outside it. Content types are stated rather than guessed, because a module script that doesn't
arrive as JavaScript is refused by Chromium's strict MIME check. `marked` and `turndown` stay
**classic** scripts so their globals exist synchronously; a module script is deferred, so the
renderer always runs after them.

*One-time cost of that move: `localStorage` is keyed by origin, so the view mode, diff mode and
the four divider positions reset once on the upgrade from a `file://` build. There is no way to
read the old origin's storage to migrate it.*

The modules, roughly bottom-up — `api`, `state`, `dom`, `util`, `lcs` and `dialogs` depend on
little or nothing; `index` depends on everything:

| | |
|---|---|
| `api` / `state` / `dom` | the preload bridge; shared mutable state; every element ref |
| `util` / `lcs` | `setStatus`/`relativePath`/`cssEscape`; the LCS core (lines *and* words) |
| `dialogs` | `openModal`, `dialogOpen`, `promptModal` |
| `markdown` | turndown + the GFM inverse rules |
| `views` / `editor` / `tables` / `find` | the editor pane, its buffer, tables, find & replace |
| `positions` | the per-file caret and per-pane scroll offsets |
| `tree` / `app` / `layout` | the file tree + context menu; opening a vault; the dividers |
| `git` / `git-commit` / `diff` | status and pull; commit and discard; the diff view |
| `reminders` / `reminders-ui` | the model and repeat maths; the list, editor and alert |
| `smart` / `images` / `shortcuts` | Claude-backed filing and lookup; image import; the help list |
| `index` | wires the UI up, then calls `init()` |

Two things about module state are load-bearing:

- **An exported binding is read-only to importers.** `export let gitState` can be read live from
  anywhere but assigned only inside `git.js`. That is why the six values *more than one module
  writes* — `baseFolder`, `currentFile`, `dirty`, `viewMode`, `diffMode`, `diffOnlyFile` — live on
  the mutable object in `state.js` instead: `state.currentFile = x` works from anywhere. Everything
  else stays in the module that owns it. When another module needs to clear owned state, it calls
  an exported reset (`resetGitState`, `resetSmartPanel`, `resetAlerts`) rather than assigning
  across the boundary — which would not even compile.
- **The graph has cycles and that is fine**, because nothing calls across one during module
  *evaluation*: cross-module calls all happen inside functions, and function declarations are
  hoisted before any module body runs. What would break is top-level code reaching into a cyclic
  dependency — so `init()` is called at the **end of `index.js`**, not where it used to sit at the
  top of the startup section. Under the old classic script hoisting made that work; under modules
  it would run before the other modules had wired themselves up.

### Conventions that matter

- **Divider positions restore late, on purpose.** All four drag handles persist to `localStorage` (`rawNotes.sidebarWidth` / `inputHeight` / `previewHeight` / `remindersHeight`). The sidebar width clamps against constants so it restores immediately, but each *row* divider clamps its saved height against its container's measured height — and `#workspace` is `display:none` until a folder opens, where every measurement reads 0. So `makeRowDivider()` registers a restore step instead of applying one, and `restoreRowDividers()` runs them from `openFolder()` once the workspace is on screen. Restoring any earlier clamps every panel to its minimum and throws the stored layout away.
- **Handlers are registered through `handle()`, not `ipcMain.handle` directly.** It wraps the call in
  the try/catch that turns a thrown error into the `{ ok: false, error }` every handler already
  answers with, so the renderer has one way to read a result and no handler can reject. The few that
  return a bare value rather than an `{ ok }` envelope (`get-last-folder`, `choose-folder`,
  `read-tree`, `open-external`, `alert-window`) stay on `ipcMain.handle`, and the synchronous
  `write-file-sync` is an `ipcMain.on` because it answers via `e.returnValue`.
- **Path-traversal guard.** Any handler taking a target from the renderer resolves it through
  `vaultPath(baseFolder, target)`, which refuses anything outside the vault. It **throws** rather than
  returning a value — `handle()` turns that into the usual `{ ok: false }` — so the guard can't be
  written and then accidentally ignored on the success path. It takes relative and absolute targets
  alike. `isInside()` underneath is still used directly where the question is a test rather than a
  guard (which files a discard covers, whether a path is worth showing relative).
- **The tree is rebuilt, not mutated.** After any change, the renderer calls `refreshTree()` which re-reads the whole tree from `main.js` and re-renders from scratch. Expanded-folder state is preserved separately in the `expanded` Set (keyed by absolute path), not in the DOM.
- **Persistence.** The last-opened base folder and the window's last geometry (`window`: bounds + `maximized`/`fullScreen`) are stored in `config.json` under Electron's `userData` dir (not in the vault). Geometry is saved debounced on move/resize and flushed on `close`; on restore the size is always reused but the *position* only if the frame still overlaps a live display, so unplugging a monitor can't strand the window off-screen. The window is created with `show: false` and maximized/fullscreened before `show()` so it doesn't visibly jump. Note contents are plain files in the user's chosen folder — there is no database or index.
- **Reading positions are captured continuously, not on close.** `renderer/positions.js` remembers each file's caret (Raw only) and a *separate* scroll offset per pane — the three panes lay the same file out differently — under `rawNotes.positions:<vault>`, LRU-capped, keyed by vault-relative path. It records off the panes' own `scroll`/`selectionchange` events rather than at the moment a file closes, which is what lets **`applyView()` restore too**: a view switch re-renders the Preview/Editor panes from scratch (and a hidden pane loses its scroll anyway), so without it every toggle would bounce the reader to the top. **A file with no remembered position is explicitly put back at the top**, not left alone: assigning `editorEl.value` parks Chromium's caret at the *end* of the text, so doing nothing opens every new file at its bottom. `restorePosition()` runs *after* `focus()` in `openFile()` (focusing scrolls the caret into view) and *before* `refreshFind()` in `applyView()` (an open find bar's match should win). Since `hydrateImages()` resolves pictures asynchronously, a pane holding them lays out short and clamps the restore — so the requested offset is re-applied on each image `load` (capture phase; `load` doesn't bubble) until it fits or the user scrolls somewhere themselves.
- **Ignored entries.** `isIgnored()` in `main.js` hides every dot-prefixed entry (`.git`, `.DS_Store`, other editors' per-vault config folders, `.wisp-reminders.json`) plus the explicit `IGNORED` set (`node_modules`) during tree building — and, because `gatherFiles` calls the same helper, keeps them out of the smart-insert prompt too.

### View modes / WYSIWYG editor

The `<textarea>` (`editorEl`) holds the **canonical buffer** and is what gets saved — the other two panes are projections of it. `applyView()` shows exactly one pane for the active `viewMode`; `renderMarkdown()`/`renderWysiwyg()` reproject `editorEl.value` into the Preview/Editor panes on entry.

The WYSIWYG **Editor** pane is a `contenteditable` div. `marked` renders the source into it (Markdown→HTML); **turndown** (`node_modules/turndown`, loaded as a UMD global `window.TurndownService`) does the reverse on save. The key invariant: **edits only fold back to the buffer through `syncWysiwygToEditor()`, and only when `dirty`** — so a file the user merely *viewed* in Editor mode is never rewritten by turndown's normalisation (round-tripping is inherently lossy on formatting, so this guard matters). `saveCurrent()`, the pre-switch step in `setViewMode()`, drag & drop, and `beforeunload` all fold back through it before touching disk. If turndown fails to load, the Editor button is hidden and the mode degrades to Raw (edits could otherwise not be saved). Image round-trip: `hydrateImages()` stashes the original vault-relative path in `data-md-src` before swapping in the data URL, and a turndown `img` rule re-emits that path instead of the inlined base64.

**Tab types, it doesn't move focus.** Both editing panes take Tab over from the browser's focus
navigation: in Raw it inserts a tab, or indents/outdents (⇧) every line a multi-line selection touches;
in the Editor it nests/un-nests the list item the caret is in, and inserts a tab elsewhere. Every edit
goes through `document.execCommand('insertText', …)` rather than assigning `editorEl.value` — that
keeps the textarea's native undo stack and fires the `input` event the autosave clock hangs off.
`indent`/`outdent` are formatting commands rather than input, so the WYSIWYG path calls
`markBufferEdited()` itself.

**marked speaks GFM, turndown only CommonMark** — so anything GFM adds needs an explicit inverse rule
(`addGfmRules()`) or a WYSIWYG save silently destroys it: a table flattens into one paragraph per cell,
`~~strikethrough~~` and `- [ ]` checkboxes come back as bare text. Tables are the fiddly one. Cells emit
their own leading `|` and the row closes the last, so the pipes never depend on a cell's index among
sibling nodes — a contenteditable row can hold whitespace and stray nodes between its cells. The heading
row also emits the delimiter row (a GFM table *is* its delimiter row) carrying each column's alignment
from the `align` attribute marked wrote. Inside a cell, a literal `|` is escaped and a line break becomes
`<br>`, because a cell is one line of a pipe-delimited row and either would end it early. A table with
**no** heading row can't be expressed as GFM at all, so it's `keep`-ed as HTML rather than flattened.

### Tables

Five shortcuts, off the same window-level `keydown` listener as `⌘S`: `⌘⇧T`/`Ctrl+⇧T` inserts a 3×3
table (a heading row plus two body rows), and `⌘⌥`/`Ctrl+Alt` + an arrow grows the table the caret is
in by a row or a column in the arrow's direction. `runTableOp()` dispatches on `effectiveViewMode()`,
because the two editing panes are the same document in two representations and each has to be edited
in its own terms — Raw rewrites the pipe-delimited source, the Editor rearranges the live `<table>`.
Preview, diff and image views say so in the status line rather than silently doing nothing, and a
shortcut pressed while another text field (find, the smart-insert note) has focus is left alone.

- **Raw parses, rewrites, and re-pads the whole table block.** `tableBlockAt()` walks out from the
  caret's line; `parseTable()` turns the lines into `{aligns, rows}` (the delimiter row isn't content,
  it's the alignments) with ragged rows padded so a column lands at the same index in each; and
  `formatTable()` writes it back with the columns aligned. Every operation rewrites all of a table's
  lines anyway — a new column touches each one — so the padding is free, and it's what keeps a table
  legible as source. **A table row is a line that opens with `|`.** GFM would also swallow a following
  paragraph line into the table, but reformatting prose as a row is a silent way to mangle a note, so
  the block stops where the pipes do.
- **The Editor edits the DOM directly**, so — like `indent`/`outdent` — no `input` event fires and
  `runTableOp()` calls `markBufferEdited()` itself. New cells match their row (`th` in the heading row,
  `td` elsewhere), so a new column stays a column after a save.
- **An empty cell has nothing to lay out**, so a fresh table would be a grid of slivers with no width
  to click into and a row barely taller than its border. `.wysiwyg th/td` carry a `min-width`, and an
  `:empty` cell gets a zero-width space as `::after` — generated content, so it gives the cell its line
  box back without ever reaching the `innerHTML` turndown reads on save. Chromium may also park its own
  placeholder `<br>` in an empty editable cell, which `cellText()` drops along with any other break at
  a cell's edge; left in, an empty cell would save as a literal `<br>`.
- **Nothing can go above the heading row**, in either pane: a GFM table *is* its delimiter row, and a
  second heading row can't be expressed. From the heading row both directions mean the same thing — the
  new row opens the body. In the Editor that's after the row rather than at the body's start whenever
  the heading row is *in* the body (which is where a browser parks a bare `<tr>`), or the table would
  come out with no heading at all.

### Keyboard shortcuts help

`Help ▸ Keyboard Shortcuts` (`⌘/` / `Ctrl+/`) opens a modal listing every shortcut, grouped. The list
(`SHORTCUT_GROUPS` in `renderer/shortcuts.js`) lives beside the handlers it documents rather than in the menu
that opens it — a shortcut and its help are one change, not two. `chord()` writes each combination the
way the host OS does: glyphs run together on macOS (`⌘⇧T`), spelled out with pluses elsewhere
(`Ctrl+Shift+T`). **Add a shortcut, add its row.**

**`buildMenu()` in `main.js` exists for that one item, but it has to rebuild the standard menu roles
around it.** Setting any application menu replaces Electron's default one, and on macOS ⌘C/⌘V/⌘Q are
menu accelerators rather than browser behaviour — a template without an Edit menu silently takes them
away. The dialog is a plain `.modal-overlay` like every other (see **Dialogs**), so the window-level
shortcuts stand down while it's up, and `dialogOpen()` keeps it from opening over another one.

### Dialogs

Every dialog is the same object — a full-screen overlay holding one box — built by **`openModal()`**,
which returns `{ box, close, promise }`: fill `box`, call `close(value)` to settle. It owns the parts
that are easy to get subtly wrong and were previously repeated six times: the keydown listener is
registered on the **capture** phase (so the window-level shortcuts, which stand down whenever
`dialogOpen()` is true, never see it) and is removed by the same `close` that removes the overlay,
**exactly once** however the dialog was dismissed. Escape is the built-in fallback; `onKey(e, close)`
is consulted first and returns true once it has handled the event. `onClose(value)` runs before the
promise settles — that's where `commitModal` stashes its draft message and the reminder alert repaints
the list. Backdrop-click cancels unless `dismissOnBackdrop: false`, which only the reminder alert sets:
a reminder must not disappear to a stray click.

**A dialog at a time**, because two overlays would both answer the same Escape. `shortcutsModal()`
refuses to open over one. `drainAlerts()` instead *defers*: a reminder coming due while a dialog is up
leaves the queue untouched, so the 15s ticker shows it once the dialog closes rather than stacking a
second overlay on it or dropping the alert (`alerted` would never let it re-fire).

### Find & replace

The find bar (`#find-bar`, between the editor header and the panes) searches the **open file only** —
`⌘F`/`Ctrl+F` to open, `⌘G`/`F3` (+`⇧`) to step, `⌘⌥F`/`Ctrl+H` for replace, `Esc` to close. The
shortcuts hang off the same window-level `keydown` listener as `⌘S`, which bails out while a
`.modal-overlay`/`.alert-overlay` is up so dialogs keep the keyboard.

Highlighting takes two routes, because the panes are different beasts:

- **Raw view: a mirror div** (`#find-highlights`) sits behind the textarea holding a copy of its text
  with each match wrapped in a span — a textarea can't hold markup. The two must lay text out
  identically, so their typography lives in **one shared CSS rule**, the textarea is transparent with
  `z-index: 1` over the mirror, and `syncHighlightBox()` pins the mirror's width to
  `editorEl.clientWidth` (excludes any scrollbar) and its `scrollTop` to the textarea's.
- **WYSIWYG / preview: the CSS Custom Highlight API** (`CSS.highlights`, styled via `::highlight()`).
  It paints ranges without touching the DOM — wrapping matches in `<mark>`s would let highlights
  round-trip through turndown into the saved Markdown.

Matches are `{start, end}` offsets in raw mode and live `Range`s in the other two, so anything reading
`findMatches` has to know which mode it's in. `refreshFind()` re-scans and is called from `applyView()`
(a re-render invalidates every Range) and, debounced, after edits. **Replace is raw-only** — it edits
the Markdown source, and the other panes are projections of it, so `⌘⌥F` switches to Raw first.

### Images

Notes can embed images with normal Markdown (`![alt](images/foo.png)`). Two things make this work despite the app's `file://` origin + CSP:

- **Preview embeds via data URLs.** `marked` emits `<img src="…">` with vault-relative paths the page can't load directly. After every render, `hydrateImages()` (renderer) asks the `read-image` handler (main) to resolve each local `src` **relative to the open file**, then inlines it as a base64 `data:` URL. So CSP stays tight (`img-src 'self' data:`) and all disk access stays in main. Remote (`http(s)`/`data:`) sources are left untouched; unresolvable refs get an `.img-missing` marker.
- **Drag & drop imports.** Dropping image files onto the editor (or preview) copies each into the vault's `images/` folder via the `import-image` handler (name-deduped, path-guarded) and inserts a reference to the open file — at the cursor in Raw view; in the WYSIWYG **Editor** an `<img>` node is inserted at the drop point (`caretRangeFromPoint`) and hydrated in place; in read-only Preview (no cursor) the Markdown ref is appended to the buffer. Dropped `File`s are turned into absolute paths with `webUtils.getPathForFile` (Electron 32 removed `File.path`), exposed as `api.getPathForFile` from preload. A window-level `drop`/`dragover` `preventDefault` stops stray drops from navigating the app away.
- **Clicking an image in the tree shows the picture.** An image file has no text behind it, so
  `openFile()` routes it past `read-file` to `read-image-file` (main resolves the absolute vault path
  to a data URL, same guard and MIME table as `read-image`) and shows it in the read-only `#image-view`
  pane. `effectiveViewMode()` reports `'image'` for it — that one derived mode hides the Raw/Editor/
  Preview toggle, keeps the buffer empty and the textarea disabled (so no autosave can write text over
  a `.png`), turns find into "no results", and refuses an image drop for want of a buffer to reference
  it from. `applyView()` drops the data URL whenever the pane goes away.
- **Every import is described by Claude.** After `import-image` copies a file in, the renderer calls
  `analyze-image` (main), which runs the same `claude` CLI as smart insert on the image and returns
  `{alt, description}`. The image is inserted **immediately** with the file name as alt so the drop
  never stalls; `analyseImported()` folds each result in when it lands (~8s, all images in parallel) —
  replacing the alt and appending a collapsed `<details>` block, which is what makes the picture's
  content findable via `⌘F` later. Anything that moved on in the meantime is dropped rather than
  forced: a different file open, or the `![…](ref)` reference no longer in the buffer. Only the types
  Claude can actually look at are sent (`ANALYZABLE_IMAGE` in `main.js`); `.svg`/`.bmp`/`.ico`/`.avif`
  import as before, silently unanalysed. A failure (no `claude` on PATH, say) is a status-line
  message, never a lost image.

Two details keep the description block from corrupting the note:

- **It is written without blank lines**, because a blank line ends an HTML block in Markdown — so the
  model's description is collapsed to a single line in `sanitizeAnalysis()` (which also HTML-escapes
  it, so a description can only ever be read as text, never as markup the preview renders).
- **turndown re-emits it via a `detailsBlock` rule**, not `keep` — `<details>` isn't in turndown's
  block list, so a plain keep would splice it inline and it would stop being its own HTML block. The
  rule rebuilds the block instead of echoing `outerHTML` because turndown collapses whitespace before
  rules run, which would otherwise fold the block onto one line on every WYSIWYG save.

### Git

The vault is **often, but not always** a git repository, so every part of this is
conditional: `git-info` answers `{ ok: true, repo: false }` for a plain folder rather than
failing, `gitState` in the renderer is `null`, and the whole `#git-bar` hides itself. Nothing
else in the app changes. Git is driven only through `spawn('git', […])` from main — never a
shell — via `runGit()`, which never rejects and always resolves `{ok, code, stdout, stderr}`.

- **The vault may be a subfolder of a larger repo.** `gitRoot()` resolves the real repo root
  and every path is translated through it, because `git status --porcelain` reports paths
  relative to the *root*, not the cwd. Status is read with a `-- <baseFolder>` pathspec and
  `git add -A -- <baseFolder>`, so Wisp only ever sees and commits its own files. The commit
  is scoped with a pathspec **only** when the vault isn't the repo root — a partial commit is
  refused during a merge, so the ordinary whole-index commit is used in the common case.
- **Status is parsed from `--porcelain=v1 -z`**, not the human format: `-z` makes each record
  NUL-terminated, so a filename containing a space, quote or newline survives intact (the
  non-`-z` format C-quotes it). A rename/copy entry is followed by one extra field, its old
  path — `parseStatus()` consumes it, or every subsequent record shifts by one.
- **`gitEnv()` disables credential prompting** (`GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS`/
  `SSH_ASKPASS` deleted). There is no terminal to answer a password prompt, so a push that
  needs one must fail fast rather than hang the app forever. It also sets
  `GIT_OPTIONAL_LOCKS=0` so the status call that runs on every tree refresh doesn't fight a
  `git` command the user is running in a terminal.
- **Pull passes `--no-rebase`** unless `pull.rebase` / `branch.<n>.rebase` is configured. Since
  git 2.27 a bare `git pull` *refuses to run at all* once the branches have diverged — which is
  exactly the "same vault edited on two machines" case this feature exists for. A conflicted
  merge comes back as `{ok: false, conflict: true}`: a normal, recoverable state (the files are
  now marked in the tree) rather than a failure.
- **A commit that lands but fails to push is reported as such.** `git-commit` returns the step
  that failed plus `committed: true`, because "nothing happened" and "committed locally, retry
  the push" need different things from the user.
- **`git-revert` never deletes an untracked file.** Discarding restores from HEAD, so a file git
  has never seen has nothing to restore *to* — "discarding" it would be an unrecoverable delete
  wearing the name of an undo. Untracked entries are counted as `skipped` and reported to the
  user instead; the ordinary Delete menu item remains for anyone who does mean that. A
  staged-but-new file is only un-staged, so it survives on disk. It also re-reads status itself
  rather than trusting the renderer's last paint, because it destroys work.
- **Revert reads status over the whole vault and filters afterwards, not via a pathspec.** Git
  only detects a rename when *both* halves are in scope, so asking about just the new path
  reports a bare add and would silently leave the old path deleted.

Tree decoration is **rebuild-then-repaint**, matching how the tree and reminder list already
work: `refreshGit()` re-reads status whole, `indexGitStatus()` builds a path→status map plus a
set of folders containing something changed, and `applyGitDecorations()` walks the rendered
`.node-row[data-path]` elements. Keeping paint separate from `renderNode()` means a status
refresh doesn't rebuild (and collapse) the tree. `refreshTree()` repaints from cached state
first so a rebuild never flashes undecorated. Status is re-read after a tree refresh, after an
autosave (debounced — saving doesn't rebuild the tree but does change what git sees), and on
window focus (the vault can be changed from a terminal).

**`afterGitChange()` sets its status message last, on purpose.** It re-opens the current file so
the editor matches what a pull just wrote to disk — and `openFile()` ends by setting the status
to `Saved`, which would otherwise be all that's left of the pull's result.

### The diff view

The diff is the **fourth view of the open file**, in the editor pane beside Raw / Editor /
Preview — not a window of its own — so reviewing a change is the same gesture as reading the
file and the tree stays visible next to it. `viewMode` gains `'diff'`, but it is deliberately
*not* persisted (`STORED_VIEW_MODES`): it's a mode you step into to check something, not one
you want the app to reopen into. The three editing views belong to Markdown files and Diff
belongs to any text file in a repository, so `applyView()` shows each button on its own terms
and hides the shared group only when nothing is left in it.

A **deleted** file has nothing on disk to open, so it gets `diffOnlyFile`: `currentFile` points
at it, the buffer stays empty and disabled, the editing views hide, and opening anything else
clears it. It's reachable from the git bar's ◨ list (a plain popup menu, not a dialog) or by
discarding its parent folder's changes.

The same change is offered two ways:

- **Visual** — side-by-side, HEAD left / working tree right. Built from `lineOps()` (the LCS
  core `lineDiff` already used for smart insert, factored out as `lcsOps` so it works on lines
  *and* words), then `pairRows()` zips each changed block's deletions against its additions so a
  rewritten line sits opposite the line it replaced, then `condenseRows()` collapses distant
  context. `wordSegments()` runs the same LCS over words to pick out what actually changed
  inside a paired line. The LCS table is O(n×m), so both have explicit size caps
  (`DIFF_MAX_CELLS` / `WORD_DIFF_MAX_CELLS`) past which the view degrades — to Raw for a whole
  file, to plain line highlighting for one long line — rather than freezing the renderer.
  Lines come from `splitLines()`, not a bare `split('\n')`: a trailing newline *terminates* the
  last line rather than starting an empty one, and empty text is no lines at all. Without both,
  every file grows a phantom blank line and a deleted file shows one empty line opposite its
  former contents.
- **Raw** — git's own unified patch, coloured by line kind. An untracked file is invisible to
  `git diff`, so main falls back to `git diff --no-index -- /dev/null <file>`.

Binary files are detected by a NUL byte in the first 8KB (git's own heuristic) and never handed
to the visual diff; `head`/`work` come back `null` so there is no text to lay out as lines.

### Reminders

The sidebar is split: the tree on top, a **reminder list** underneath, with a draggable `#divider-reminders` between them (height persisted in `localStorage`). Each entry holds its **next** due time — a repeating reminder is *rolled forward* on completion rather than duplicated, so the list only ever contains pending entries.

- **Storage is one plain JSON file**, `.wisp-reminders.json` in the vault root, read and rewritten whole (`read-reminders` / `write-reminders`). Same philosophy as the tree: rebuild, don't mutate. The renderer holds the list in memory and calls `persistReminders()` after every change. `normalizeReminder()` drops malformed entries, so a hand-edited file can't break the app.
- **Due watching lives in the renderer.** A 15s ticker (`checkDueReminders`) compares each `due` against now; newly-due entries are queued and shown **one at a time** as a full-screen `.alert-overlay` popup. `alerted` (a `Set` of `id@due`) stops an entry re-firing every tick while it sits overdue — but it's in-memory on purpose, so a restart re-alerts anything still outstanding. The popup offers snooze / open-note / done; `alert-window` in main raises and flashes the window so the popup isn't missed behind other apps.
- **Repeat maths.** `occurrenceAt()` always recomputes from the *original* date and clamps to the month's last day, so a reminder anchored on the 31st doesn't drift forward through February (31 Jan → 28 Feb → 31 Mar, not 3 Mar → 3 Apr). `nextOccurrence()` steps until it lands in the future, which is what makes a long-overdue repeating reminder catch up in one go.
- **Times are stored as UTC ISO strings**; `toLocalParts`/`fromLocalParts` convert to and from the local `YYYY-MM-DD` + `HH:mm` pair that the `date`/`time` inputs speak.

### Smart insert (Claude-powered filing)

The panel at the top of the editor pane lets the user jot a note and have Claude file it into the right place. It shells out to the **`claude` CLI** from the main process (`spawn('claude', ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep'])`, cwd = vault root). Two handlers back it: `smart-check` runs Claude and returns a *plan* (`targetFile`, `isNew`, `reason`, `newContent`, `oldContent`) without writing anything; `smart-apply` writes an approved plan (path-traversal-guarded, creates parent dirs).

- **Check previews, Add applies.** `renderer/smart.js` caches the plan in `smartPlan`/`smartPlanFor`; editing the note invalidates it so **Add** re-checks automatically rather than filing stale content. The preview shows the target file, a NEW/EXISTING badge, Claude's reason, and a collapsed line-diff (`lineDiff`/`condenseDiff`).
- **Every check also asks for a reminder.** The same single call returns an optional `reminder` alongside the filing plan (the prompt includes `describeNow()` so relative dates like "next Tuesday" resolve). *Checked* always, *created* only for a genuine time-bound commitment — a plain fact returns `null`. `sanitizeReminder()` in main drops anything malformed rather than surfacing a bogus alarm. The preview renders it as an opt-out card (`renderReminderProposal`) with an **Edit…** button into the normal reminder editor; **Add** writes the file and only then creates the reminder, linked to the file it filed into.
- **Prompt inlines small files.** `gatherFiles` embeds the contents of files under the size/total budget directly in the prompt so Claude usually decides in **one turn without `Read` round-trips** (large files are listed by name and read on demand). This is the difference between ~7s and Claude crawling the vault.
- **Flush before check/apply.** Both flows call `flushSave()` first so Claude reads the latest on-disk content and the post-apply `openFile()` can't clobber the AI's write with a stale editor buffer.

### Smart lookup (the same box, read direction)

**Lookup**, the button at the far right of the smart bar, runs the panel's text the *other* way: instead of
filing it into the vault, `smart-lookup` (main) answers it **from** the vault and writes nothing. It reuses
`gatherFiles`/`runClaude`, so the usual question is answered in one turn, and returns
`{answer, sources:[{file, detail}]}`.

- **Sources are verified, not trusted.** `sanitizeSources()` drops any citation that isn't a real file
  inside the vault, so a hallucinated path can't reach the UI. The renderer turns each surviving one into a
  button that opens that note (via `openVaultNote`, shared with the reminder list), which is what makes an
  answer checkable against what the notes actually say.
- **Answers are plain text.** The prompt asks for prose with no Markdown, and `renderLookup` sets
  `textContent` — a model answer is never rendered as markup.
- **The preview pane holds one thing at a time.** A lookup answer and a filing plan share `#smart-preview`,
  so each clears the other: `renderPreview()` drops `smartLookupFor`, `smartLookup()` drops
  `smartPlan`/`smartPlanFor` (otherwise **Add** would apply a plan that's no longer on screen), and
  `invalidateSmartPlan()` clears whichever of the two the edited text has invalidated.
