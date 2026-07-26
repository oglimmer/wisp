# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm install` — install dependencies (Electron ships a platform-specific native binary; **never copy `node_modules` between machines/OSes** — reinstall on the target, or you'll get `spawn ENOEXEC`).
- `npm start` — launch the app (`electron .`).

There is no build step, linter, or test suite configured.

## Architecture

Wisp is a single-window Electron app: a folder/file tree on the left, an editor on the right. Every text file is treated as Markdown. For Markdown files the editor pane offers a three-way view toggle (`viewMode`, persisted in `localStorage`): **Raw** (the plain-text source in a `<textarea>` — the canonical, always-available mode), **Editor** (a `contenteditable` WYSIWYG view), and **Preview** (read-only rendered Markdown). Non-Markdown files are always edited raw.

The whole app is built around Electron's **three-context security model**, and understanding the boundary between the contexts is the key to working here:

- **`main.js` (main process, Node.js)** — owns all filesystem and OS access. Every filesystem operation lives here as an `ipcMain.handle` handler (`read-tree`, `read-file`, `write-file`, `create-file`, `create-folder`, `delete-path`, `rename-path`), plus folder picking (`choose-folder`) and config. The renderer has **no direct fs access** — anything touching disk must be added as a handler here.
- **`preload.js`** — the only bridge between the two worlds. Runs with `contextIsolation: true` / `nodeIntegration: false` and exposes a minimal, hand-listed API on `window.api` via `contextBridge`. A new main-process handler is invisible to the UI until a corresponding method is added here.
- **`renderer.js` (renderer, browser context)** — all UI logic and state (`baseFolder`, `currentFile`, `dirty`, `expanded` set). Talks to disk **only** through `window.api.*`. It never `require`s Node modules.

So adding any file operation is always a three-file change: handler in `main.js` → method in `preload.js` → call in `renderer.js`.

### Conventions that matter

- **`renderer.js` is wrapped in an IIFE on purpose.** A top-level `const api` (or any top-level `const`/`let`) in a classic renderer script collides with the globals `contextBridge` injects and throws `SyntaxError: Identifier 'api' has already been declared`, crashing the renderer silently. Keep new renderer code inside the IIFE.
- **Path-traversal guard.** Mutating handlers in `main.js` validate targets with `isInside(baseFolder, target)` before touching disk. Any new write/delete/rename handler must do the same.
- **The tree is rebuilt, not mutated.** After any change, the renderer calls `refreshTree()` which re-reads the whole tree from `main.js` and re-renders from scratch. Expanded-folder state is preserved separately in the `expanded` Set (keyed by absolute path), not in the DOM.
- **Persistence.** The last-opened base folder is stored in `config.json` under Electron's `userData` dir (not in the vault). Note contents are plain files in the user's chosen folder — there is no database or index.
- **Ignored entries.** `IGNORED` in `main.js` (`.git`, `node_modules`, `.obsidian`, `.DS_Store`) is filtered out during tree building.

### View modes / WYSIWYG editor

The `<textarea>` (`editorEl`) holds the **canonical buffer** and is what gets saved — the other two panes are projections of it. `applyView()` shows exactly one pane for the active `viewMode`; `renderMarkdown()`/`renderWysiwyg()` reproject `editorEl.value` into the Preview/Editor panes on entry.

The WYSIWYG **Editor** pane is a `contenteditable` div. `marked` renders the source into it (Markdown→HTML); **turndown** (`node_modules/turndown`, loaded as a UMD global `window.TurndownService`) does the reverse on save. The key invariant: **edits only fold back to the buffer through `syncWysiwygToEditor()`, and only when `dirty`** — so a file the user merely *viewed* in Editor mode is never rewritten by turndown's normalisation (round-tripping is inherently lossy on formatting, so this guard matters). `saveCurrent()`, the pre-switch step in `setViewMode()`, drag & drop, and `beforeunload` all fold back through it before touching disk. If turndown fails to load, the Editor button is hidden and the mode degrades to Raw (edits could otherwise not be saved). Image round-trip: `hydrateImages()` stashes the original vault-relative path in `data-md-src` before swapping in the data URL, and a turndown `img` rule re-emits that path instead of the inlined base64.

### Images

Notes can embed images with normal Markdown (`![alt](images/foo.png)`). Two things make this work despite the app's `file://` origin + CSP:

- **Preview embeds via data URLs.** `marked` emits `<img src="…">` with vault-relative paths the page can't load directly. After every render, `hydrateImages()` (renderer) asks the `read-image` handler (main) to resolve each local `src` **relative to the open file**, then inlines it as a base64 `data:` URL. So CSP stays tight (`img-src 'self' data:`) and all disk access stays in main. Remote (`http(s)`/`data:`) sources are left untouched; unresolvable refs get an `.img-missing` marker.
- **Drag & drop imports.** Dropping image files onto the editor (or preview) copies each into the vault's `images/` folder via the `import-image` handler (name-deduped, path-guarded) and inserts a reference to the open file — at the cursor in Raw view; in the WYSIWYG **Editor** an `<img>` node is inserted at the drop point (`caretRangeFromPoint`) and hydrated in place; in read-only Preview (no cursor) the Markdown ref is appended to the buffer. Dropped `File`s are turned into absolute paths with `webUtils.getPathForFile` (Electron 32 removed `File.path`), exposed as `api.getPathForFile` from preload. A window-level `drop`/`dragover` `preventDefault` stops stray drops from navigating the app away.

### Smart insert (Claude-powered filing)

The panel at the top of the editor pane lets the user jot a note and have Claude file it into the right place. It shells out to the **`claude` CLI** from the main process (`spawn('claude', ['-p', prompt, '--output-format', 'json', '--allowedTools', 'Read,Glob,Grep'])`, cwd = vault root). Two handlers back it: `smart-check` runs Claude and returns a *plan* (`targetFile`, `isNew`, `reason`, `newContent`, `oldContent`) without writing anything; `smart-apply` writes an approved plan (path-traversal-guarded, creates parent dirs).

- **Check previews, Add applies.** `renderer.js` caches the plan in `smartPlan`/`smartPlanFor`; editing the note invalidates it so **Add** re-checks automatically rather than filing stale content. The preview shows the target file, a NEW/EXISTING badge, Claude's reason, and a collapsed line-diff (`lineDiff`/`condenseDiff`).
- **Prompt inlines small files.** `gatherFiles` embeds the contents of files under the size/total budget directly in the prompt so Claude usually decides in **one turn without `Read` round-trips** (large files are listed by name and read on demand). This is the difference between ~7s and Claude crawling the vault.
- **Flush before check/apply.** Both flows call `flushSave()` first so Claude reads the latest on-disk content and the post-apply `openFile()` can't clobber the AI's write with a stale editor buffer.
