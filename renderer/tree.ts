// The file tree: building it, the toolbar above it, and its context menu.

import { api } from './api.js';
import { promptModal } from './dialogs.js';
import { showDiffFor } from './diff.js';
import { currentFileEl, editorEl, treeEl, treeModeRecentBtn, treeModeTreeBtn } from './dom.js';
import { cancelPendingSave, flushSave, openFile } from './editor.js';
import { applyGitDecorations, gitDirtyDirs, gitFileStatus, gitState, refreshGit } from './git.js';
import { discardChanges } from './git-commit.js';
import { remapPositions } from './positions.js';
import { remapReminderFiles } from './reminders.js';
import { newReminder } from './reminders-ui.js';
import { state } from './state.js';
import { cssEscape, relativePath, setStatus } from './util.js';
import { applyView, isImage } from './views.js';
import type { TreeNode } from '../types/ipc';

export const expanded = new Set<string>(); // dir paths currently expanded

// ---- The two views of the same files ----
//
// The tree answers "what is in this folder"; the recency list answers "what have I
// been working on", which the tree cannot show at all — the file changed a minute
// ago is wherever it happens to live, possibly inside a folder that is collapsed.
// Both are built from the one `read-tree` call (files carry an `mtime`), and both
// render the same `.node-row[data-path]` rows, so the git decorations, drag & drop
// and the context menu are written once and work in either.

export type TreeMode = 'tree' | 'recent';

let treeMode: TreeMode = localStorage.getItem('rawNotes.treeMode') === 'recent' ? 'recent' : 'tree';

export async function setTreeMode(mode: TreeMode) {
  if (mode === treeMode) return;
  treeMode = mode;
  localStorage.setItem('rawNotes.treeMode', mode);
  paintTreeModeButtons();
  if (state.baseFolder) await refreshTree();
}

function paintTreeModeButtons() {
  treeModeTreeBtn.classList.toggle('active', treeMode === 'tree');
  treeModeRecentBtn.classList.toggle('active', treeMode === 'recent');
}

paintTreeModeButtons();

let recentRefreshTimer: ReturnType<typeof setTimeout> | null = null;

// A save changes what the recency list is ordered by, and nothing else rebuilds the
// tree for one — the same reason the git decorations repaint after a save, and
// debounced for the same reason too. In tree mode a save moves nothing, so this
// does nothing: the rebuild is not free, and the tree's own view has no need of it.
export function scheduleRecentRefresh() {
  if (treeMode !== 'recent') return;
  if (recentRefreshTimer) clearTimeout(recentRefreshTimer);
  recentRefreshTimer = setTimeout(() => {
    recentRefreshTimer = null;
    if (treeMode === 'recent' && state.baseFolder) refreshTree();
  }, 600);
}

export async function refreshTree() {
  const tree = await api.readTree(state.baseFolder);
  // The sidebar is scrolled by the user, and emptying it collapses its height —
  // which would send them back to the top on a rebuild they didn't ask for (the
  // recency list rebuilds itself after a save).
  const scroll = treeEl.scrollTop;
  treeEl.innerHTML = '';
  if (!tree) {
    treeEl.textContent = 'Folder not found.';
    return;
  }
  // Render the base folder's children directly (root is implicit).
  const children = tree.children || [];
  if (treeMode === 'recent') {
    const files = flattenFiles(children);
    files.sort(byRecency);
    for (const file of files) treeEl.appendChild(renderRecentNode(file));
    if (files.length === 0) treeEl.appendChild(emptyNote('No files yet. Use ＋ to create one.'));
  } else {
    for (const child of children) {
      treeEl.appendChild(renderNode(child, 0));
    }
    if (children.length === 0) {
      treeEl.appendChild(emptyNote('Empty folder. Use ＋ to create a file.'));
    }
  }
  treeEl.scrollTop = scroll;
  // The rows are new elements, so the class the click put on the old one is gone.
  markActiveRow();
  // Repaint from the status we already have so the rebuild doesn't flash undecorated,
  // then re-read it in the background — the change that prompted this refresh is
  // usually one git needs to hear about too.
  applyGitDecorations();
  refreshGit();
}

function emptyNote(message: string) {
  const empty = document.createElement('div');
  empty.style.padding = '8px';
  empty.style.color = 'var(--text-dim)';
  empty.style.fontSize = '12px';
  empty.textContent = message;
  return empty;
}

// Highlight the open file's row, if it has one. `editorEl`'s click handler does
// this on the way in; a rebuild has to redo it.
function markActiveRow() {
  const open = state.currentFile;
  if (!open) return;
  const row = treeEl.querySelector(`.node-row[data-path="${cssEscape(open)}"]`);
  if (row) row.classList.add('active');
}

// Every file under `nodes`, folders flattened away. Folders are dropped rather
// than listed: "what changed" is a question about notes, and a folder's own mtime
// answers a different one (something was added to it, or removed).
function flattenFiles(nodes: TreeNode[]) {
  const files: TreeNode[] = [];
  for (const node of nodes) {
    if (node.type === 'dir') files.push(...flattenFiles(node.children || []));
    else files.push(node);
  }
  return files;
}

// Newest first, name as the tie-break so the order is stable between refreshes —
// two files written in the same millisecond (a checkout, a copied folder) would
// otherwise swap places on every rebuild.
function byRecency(a: TreeNode, b: TreeNode) {
  const bySeen = (b.mtime || 0) - (a.mtime || 0);
  return bySeen || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

// How long ago, in the shortest form that still says it: minutes within the hour,
// then hours, then days, then the date. A list ordered by time is read for its
// order first, so the exact stamp goes in the tooltip rather than the row.
function relativeTime(ms: number | undefined) {
  if (!ms) return '';
  const secs = Math.max(0, (Date.now() - ms) / 1000);
  if (secs < 60) return 'now';
  if (secs < 3600) return Math.floor(secs / 60) + 'm';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h';
  if (secs < 7 * 86400) return Math.floor(secs / 86400) + 'd';
  const then = new Date(ms);
  const sameYear = then.getFullYear() === new Date().getFullYear();
  return then.toLocaleDateString(
    undefined,
    sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short' }
  );
}

// One row of the recency list. The row itself is the tree's, so a file can be
// dragged, right-clicked and decorated here exactly as it can there; what this
// adds is the two things a flat list has to say for itself — which folder the file
// is in, and when it changed.
function renderRecentNode(node: TreeNode) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const { row, arrow, icon } = makeRow(node);
  row.style.paddingLeft = '6px';
  arrow.remove(); // nothing to expand, and no depth to line up with
  icon.textContent = isImage(node.path) ? '🖼' : '📄';

  // Always appended, empty for a file at the vault root: it is the element that
  // takes the row's free space, so the time stays pinned right either way.
  const dir = document.createElement('span');
  dir.className = 'node-dir';
  const parent = parentDir(relativePath(node.path));
  dir.textContent = parent ? parent + '/' : '';
  row.appendChild(dir);

  const when = document.createElement('span');
  when.className = 'node-time';
  when.textContent = relativeTime(node.mtime);
  if (node.mtime) when.title = new Date(node.mtime).toLocaleString();
  row.appendChild(when);

  row.addEventListener('click', () => openFile(node.path, row));
  wrapper.appendChild(row);
  return wrapper;
}

// The row an entry gets in either view: the label, the drag & drop wiring and the
// context menu. Everything keyed off `.node-row[data-path]` elsewhere in the app —
// the git decorations, the active-file highlight, every `querySelector` by path —
// is satisfied by this alone, which is what lets the recency list reuse it.
function makeRow(node: TreeNode) {
  const row = document.createElement('div');
  row.className = 'node-row';
  row.dataset.path = node.path;

  const arrow = document.createElement('span');
  arrow.className = 'node-arrow';

  const icon = document.createElement('span');
  icon.className = 'node-icon';

  const label = document.createElement('span');
  label.className = 'node-label';
  label.textContent = node.name;

  row.appendChild(arrow);
  row.appendChild(icon);
  row.appendChild(label);
  attachDragSource(row, node);
  // A folder takes a drop itself; a file hands it on to the folder it sits in, so
  // dropping onto a note means "into that note's folder" rather than nothing (or,
  // worse, falling through to the background and landing in the vault root).
  attachDropTarget(row, () => (node.type === 'dir' ? node.path : parentDir(node.path)));
  attachRowMenu(row, node);
  return { row, arrow, icon, label };
}

// Build a DOM node for a tree entry.
function renderNode(node: TreeNode, depth: number) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const { row, arrow, icon } = makeRow(node);
  row.style.paddingLeft = depth * 12 + 6 + 'px';
  wrapper.appendChild(row);

  if (node.type === 'dir') {
    const isOpen = expanded.has(node.path);
    arrow.textContent = isOpen ? '▾' : '▸';
    icon.textContent = isOpen ? '📂' : '📁';

    const childrenEl = document.createElement('div');
    childrenEl.className = 'node-children';
    if (!isOpen) childrenEl.classList.add('hidden');
    for (const child of node.children || []) {
      childrenEl.appendChild(renderNode(child, depth + 1));
    }
    wrapper.appendChild(childrenEl);

    row.addEventListener('click', () => {
      if (expanded.has(node.path)) expanded.delete(node.path);
      else expanded.add(node.path);
      const nowOpen = expanded.has(node.path);
      arrow.textContent = nowOpen ? '▾' : '▸';
      icon.textContent = nowOpen ? '📂' : '📁';
      childrenEl.classList.toggle('hidden', !nowOpen);
    });
  } else {
    arrow.textContent = '';
    icon.textContent = isImage(node.path) ? '🖼' : '📄';
    row.addEventListener('click', () => openFile(node.path, row));
  }

  return wrapper;
}

function attachRowMenu(row: HTMLElement, node: TreeNode) {
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items: MenuItem[] = [];
    // Only offered for a file git actually has something to say about.
    const entry = node.type === 'file' ? gitFileStatus.get(node.path) : null;
    if (entry) {
      items.push({ label: 'Show diff', fn: () => showDiffFor(node.path) });
      // Untracked means there is no committed version to go back to, so there is
      // nothing to discard — Delete below is the honest option for those.
      if (entry.kind !== 'untracked') {
        items.push({
          label: 'Discard changes…',
          fn: () => discardChanges(node.path, 'file', node.name),
        });
      }
    }
    // A folder covers everything under it — including deleted files, which have no
    // row of their own because they are no longer on disk.
    if (node.type === 'dir' && gitDirtyDirs.has(node.path)) {
      items.push({
        label: 'Discard changes in folder…',
        fn: () => discardChanges(node.path, 'dir', node.name + '/'),
      });
    }
    items.push(
      { label: 'Add reminder…', fn: () => newReminder(node.type === 'file' ? node.path : null) },
      { label: revealLabel(), fn: () => revealNode(node) },
      { label: 'Rename', fn: () => renameNode(node) },
      { label: 'Delete', fn: () => deleteNode(node) }
    );
    showContextMenu(e, items);
  });
}

// ---- Drag & drop moves ----
//
// Dragging an entry onto a folder moves it there. The move itself is one IPC call
// (`move-path`), but a move invalidates four things the app keys by path — the
// notes' own Markdown refs (rewritten in main, in both directions), the open file,
// the remembered reading positions and the reminders' note links — so `moveNode()`
// re-keys the three the renderer owns rather than letting them quietly go stale.

// The dragged path is kept here rather than read back off the dataTransfer:
// Chromium exposes the data's *types* during a drag but not its values, so a
// dragover handler could not otherwise tell a vault entry from a file being
// dragged in out of another app. It goes on the dataTransfer too, so dragging a
// note *out* to another app still hands over something meaningful.
let dragPath: string | null = null;
let dropEl: HTMLElement | null = null;

function markDropTarget(el: HTMLElement) {
  if (dropEl === el) return;
  clearDropTarget();
  dropEl = el;
  el.classList.add('drop-target');
}

function clearDropTarget() {
  if (dropEl) dropEl.classList.remove('drop-target');
  dropEl = null;
}

function parentDir(p: string) {
  const cut = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return cut === -1 ? '' : p.slice(0, cut);
}

// Whether dropping the dragged entry into `destDir` is a move worth offering.
// Main refuses the rest anyway, but a highlight that can only lead to an error
// message is worse than no highlight at all.
function canDrop(destDir: string) {
  if (!dragPath || !destDir) return false;
  const sep = dragPath.includes('\\') ? '\\' : '/';
  // Into itself or into something below it: the folder would move out of existence.
  if (destDir === dragPath || destDir.startsWith(dragPath + sep)) return false;
  return destDir !== parentDir(dragPath); // already there
}

function attachDragSource(row: HTMLElement, node: TreeNode) {
  row.draggable = true;
  row.addEventListener('dragstart', (e) => {
    dragPath = node.path;
    row.classList.add('dragging');
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', node.path);
  });
  row.addEventListener('dragend', () => {
    dragPath = null;
    row.classList.remove('dragging');
    clearDropTarget();
  });
}

// `destDir()` says where a drop on `el` would land. `accepts(e)` is the extra test
// the tree's background needs — it sits under every row, so it must ignore any
// event a row has already been offered.
/**
 * @param {HTMLElement} el
 * @param {() => string} destDir
 * @param {(e: DragEvent) => boolean} [accepts]
 */
function attachDropTarget(
  el: HTMLElement,
  destDir: () => string,
  accepts: (e: DragEvent) => boolean = () => true,
) {
  el.addEventListener('dragover', (e) => {
    // No preventDefault when we can't take it: that is what tells the browser this
    // is not a drop target, and what lets the event go on to the one behind it.
    if (!accepts(e) || !canDrop(destDir())) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    markDropTarget(el);
  });
  el.addEventListener('dragleave', (e) => {
    if (e.target === el) clearDropTarget();
  });
  el.addEventListener('drop', (e) => {
    const dir = destDir();
    if (!accepts(e) || !canDrop(dir)) return;
    e.preventDefault();
    e.stopPropagation();
    const source = dragPath;
    dragPath = null;
    clearDropTarget();
    if (source) moveNode(source, dir);
  });
}

// The empty part of the tree is the vault root — the only way to drag something
// back out of a folder without another folder to aim at.
attachDropTarget(
  treeEl,
  () => state.baseFolder || '',
  (e) => !(e.target instanceof Element && e.target.closest('.node-row'))
);

// Everything the renderer keys by path, re-keyed after an entry has moved: the
// expanded folders (absolute paths), the remembered reading positions and the
// reminders' note links (both vault-relative). A rename is a move too, so both
// paths through main come here.
//
// The expanded set matters for more than tidiness — without it a moved folder,
// and anything expanded under it, comes back collapsed.
async function rekeyMovedPaths(oldPath: string, newPath: string) {
  const sep = oldPath.includes('\\') ? '\\' : '/';
  const prefix = oldPath + sep;
  for (const dir of [...expanded]) {
    if (dir !== oldPath && !dir.startsWith(prefix)) continue;
    expanded.delete(dir);
    expanded.add(newPath + dir.slice(oldPath.length));
  }
  remapPositions(relativePath(oldPath), relativePath(newPath));
  await remapReminderFiles(relativePath(oldPath), relativePath(newPath));
}

async function moveNode(source: string, destDir: string) {
  const sep = source.includes('\\') ? '\\' : '/';
  const open = state.currentFile;
  const movingOpen = !!open && (open === source || open.startsWith(source + sep));
  // Flush first so a queued autosave lands on the old path before it moves, rather
  // than re-creating the old file underneath us afterwards.
  if (movingOpen) await flushSave();

  const res = await api.movePath(state.baseFolder, source, destDir);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }

  await rekeyMovedPaths(source, res.path);
  expandAncestors(res.path);
  await refreshTree();

  if (movingOpen && open) {
    // Re-opened from the new path rather than just re-labelled: the move may have
    // rewritten this note's own refs, so the buffer on screen is out of date — and
    // the next autosave would write it straight back over them.
    const moved = res.path + open.slice(source.length);
    state.currentFile = moved;
    await openFile(moved, treeEl.querySelector(`[data-path="${cssEscape(moved)}"]`));
  } else if (res.updated && open) {
    // The open note didn't move, but its refs may have followed what did.
    await openFile(open, treeEl.querySelector(`[data-path="${cssEscape(open)}"]`));
  }

  // Last: openFile() ends by setting the status to `Saved`, which would otherwise
  // be all that was left of the move's own result.
  const name = source.slice(source.lastIndexOf(sep) + 1);
  const into = destDir === state.baseFolder ? 'the vault root' : relativePath(destDir) + '/';
  const refs = res.updated ? ` — refs updated in ${res.updated} note(s)` : '';
  setStatus(`Moved "${name}" to ${into}${refs}`);
}

// ---- Toolbar actions ----
export async function newFile() {
  const name = await promptModal('New file name (e.g. notes.md or folder/note.md):', 'untitled.md');
  if (!name) return;
  const res = await api.createFile(state.baseFolder, name);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  expandAncestors(res.path);
  await refreshTree();
  const row = treeEl.querySelector(`[data-path="${cssEscape(res.path)}"]`);
  await openFile(res.path, row);
}

export async function newFolder() {
  const name = await promptModal('New folder name:', 'new-folder');
  if (!name) return;
  const res = await api.createFolder(state.baseFolder, name);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  expanded.add(res.path);
  await refreshTree();
}

// Make sure every ancestor dir of a path is expanded so it's visible.
export function expandAncestors(filePath: string) {
  const root = state.baseFolder || '';
  let dir = filePath;
  const sep = filePath.includes('\\') ? '\\' : '/';
  while (dir.length > root.length) {
    dir = dir.slice(0, dir.lastIndexOf(sep));
    if (dir.length >= root.length) expanded.add(dir);
  }
}

// ---- Context menu ----
// Shared by the tree and the reminder list.
let menuEl: HTMLElement | null = null;

/** One row of a context menu. `fn` may be async — nothing awaits it. */
export interface MenuItem {
  label: string;
  fn: () => void;
}

export function showContextMenu(e: { clientX: number; clientY: number }, items: MenuItem[]) {
  removeContextMenu();
  menuEl = document.createElement('div');
  Object.assign(menuEl.style, {
    position: 'fixed',
    left: e.clientX + 'px',
    top: e.clientY + 'px',
    background: 'var(--bg-active)',
    border: '1px solid var(--border)',
    borderRadius: '5px',
    padding: '4px',
    zIndex: 1000,
    fontSize: '13px',
    minWidth: '120px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
  });

  const mkItem = (text: string, fn: () => void) => {
    const item = document.createElement('div');
    item.textContent = text;
    Object.assign(item.style, { padding: '6px 12px', cursor: 'pointer', borderRadius: '3px' });
    item.addEventListener('mouseenter', () => (item.style.background = 'var(--bg-hover)'));
    item.addEventListener('mouseleave', () => (item.style.background = 'transparent'));
    item.addEventListener('click', () => {
      removeContextMenu();
      fn();
    });
    return item;
  };

  for (const item of items) menuEl.appendChild(mkItem(item.label, item.fn));
  document.body.appendChild(menuEl);
}

function removeContextMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

document.addEventListener('click', removeContextMenu);

// Right-click the empty part of the tree: acts on the vault as a whole. This is
// also the only way to reach a deleted file that sat at the vault root — it has no
// row of its own, and no parent folder to right-click either.
treeEl.addEventListener('contextmenu', (e) => {
  if ((e.target as Element).closest('.node-row')) return; // a row handles its own menu
  e.preventDefault();
  if (!gitState || !gitState.files.length) return;
  showContextMenu(e, [
    {
      label: 'Discard all changes…',
      // gitState is non-null, so a vault is open and baseFolder is set.
      fn: () => discardChanges(state.baseFolder as string, 'dir', 'the whole vault'),
    },
  ]);
});

// What the host OS calls its file manager, so the menu entry reads natively.
function revealLabel() {
  if (api.platform === 'darwin') return 'Reveal in Finder';
  if (api.platform === 'win32') return 'Show in Explorer';
  return 'Show in File Manager';
}

// Select the entry in the OS file manager. Flush first for the open file, so what
// the user finds on disk matches what they see in the editor.
async function revealNode(node: TreeNode) {
  if (state.currentFile === node.path) await flushSave();
  const res = await api.revealPath(state.baseFolder, node.path);
  if (!res.ok) setStatus('Error: ' + res.error, true);
}

async function renameNode(node: TreeNode) {
  const newName = await promptModal('Rename to:', node.name);
  if (!newName || newName === node.name) return;
  const sep = node.path.includes('\\') ? '\\' : '/';
  const open = state.currentFile;
  // A renamed *folder* moves the open file without the open file being the node.
  const renamingOpen = !!open && (open === node.path || open.startsWith(node.path + sep));
  // Flush first so the pending write lands on the old path before it moves,
  // rather than re-creating the old file after the rename.
  if (renamingOpen) await flushSave();
  const res = await api.renamePath(state.baseFolder, node.path, newName);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  await rekeyMovedPaths(node.path, res.path);
  // Re-opened rather than re-labelled, in both cases for the same reason: the
  // rename may have rewritten refs, and a buffer a version behind what is now on
  // disk is one the next autosave would write straight back over. It also settles
  // the case where a rename changes what kind of file this is (image ↔ text), and
  // with it which pane should be showing.
  if (renamingOpen && open) {
    const moved = res.path + open.slice(node.path.length);
    state.currentFile = moved;
    await openFile(moved);
  } else if (res.updated && open) {
    await openFile(open); // not renamed itself, but its refs followed what was
  }
  await refreshTree();
  if (res.updated) setStatus(`Renamed — refs updated in ${res.updated} note(s)`);
}

async function deleteNode(node: TreeNode) {
  if (!window.confirm(`Delete "${node.name}"? This cannot be undone.`)) return;
  // Drop any queued autosave so it can't re-create the file we're deleting.
  if (state.currentFile === node.path) cancelPendingSave();
  const res = await api.deletePath(state.baseFolder, node.path);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  if (state.currentFile === node.path) {
    state.currentFile = null;
    state.dirty = false;
    editorEl.value = '';
    editorEl.disabled = true;
    currentFileEl.textContent = 'No file open';
    setStatus('');
    applyView();
  }
  await refreshTree();
}

// Escape a string for use in a CSS attribute selector.
