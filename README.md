# Wisp

A minimal, Obsidian-like note editor built with [Electron](https://www.electronjs.org/). It opens a base folder ("vault"), shows a folder/file tree on the left, and edits files as **raw text** on the right. Every text file is assumed to be Markdown, but nothing is rendered — you always see and edit the plain source.

## Features

- **Pick a base folder** on first launch; the choice is remembered across sessions.
- **Folder/file tree** in the sidebar — folders first, then files, alphabetical. Expand/collapse folders, click a file to open it.
- **Raw-text editor** with a monospace font. No Markdown rendering — just the source.
- **Save** with `Ctrl/Cmd+S`; a status indicator shows `Saved` / `Unsaved changes`, and you're warned before discarding unsaved edits.
- **File management**: create files (supports nested paths like `folder/note.md`), create folders, rename, and delete (via right-click), plus refresh and change-folder buttons.
- Hidden by default: `.git`, `node_modules`, `.obsidian`, `.DS_Store`.
- Secure by design: context isolation on, Node integration off, all file access goes through a minimal IPC bridge with path-traversal guards.

## Requirements

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
| New file | `＋` in the sidebar header (name can include subfolders, e.g. `ideas/todo.md`) |
| New folder | 🗀 in the sidebar header |
| Rename / delete | Right-click an item in the tree |
| Refresh tree | `⟳` in the sidebar header |
| Change base folder | `⋯` in the sidebar header |

## Project structure

| File | Role |
|------|------|
| `main.js` | Main process — window creation, folder dialog, tree building, and file read/write/create/rename/delete IPC handlers |
| `preload.js` | Secure `contextBridge` API exposed to the renderer |
| `index.html` | Welcome screen + sidebar/editor layout |
| `renderer.js` | UI logic: tree rendering, open/save, context menu, keyboard shortcuts |
| `styles.css` | Dark theme |
| `package.json` | Metadata, dependencies, and the `start` script |

## License

MIT
