// The file tree: building it, the toolbar above it, and its context menu.

import { api } from './api.js';
import { promptModal } from './dialogs.js';
import { showDiffFor } from './diff.js';
import { currentFileEl, editorEl, treeEl } from './dom.js';
import { cancelPendingSave, flushSave, openFile } from './editor.js';
import { applyGitDecorations, gitDirtyDirs, gitFileStatus, gitState, refreshGit } from './git.js';
import { discardChanges } from './git-commit.js';
import { newReminder } from './reminders-ui.js';
import { state } from './state.js';
import { cssEscape, relativePath, setStatus } from './util.js';
import { applyView, isImage } from './views.js';

export const expanded = new Set(); // dir paths currently expanded
export async function refreshTree() {
  const tree = await api.readTree(state.baseFolder);
  treeEl.innerHTML = '';
  if (!tree) {
    treeEl.textContent = 'Folder not found.';
    return;
  }
  // Render the base folder's children directly (root is implicit).
  for (const child of tree.children) {
    treeEl.appendChild(renderNode(child, 0));
  }
  if (tree.children.length === 0) {
    const empty = document.createElement('div');
    empty.style.padding = '8px';
    empty.style.color = 'var(--text-dim)';
    empty.style.fontSize = '12px';
    empty.textContent = 'Empty folder. Use ＋ to create a file.';
    treeEl.appendChild(empty);
  }
  // Repaint from the status we already have so the rebuild doesn't flash undecorated,
  // then re-read it in the background — the change that prompted this refresh is
  // usually one git needs to hear about too.
  applyGitDecorations();
  refreshGit();
}

// Build a DOM node for a tree entry.
function renderNode(node, depth) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'node-row';
  row.style.paddingLeft = depth * 12 + 6 + 'px';
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
  wrapper.appendChild(row);

  if (node.type === 'dir') {
    const isOpen = expanded.has(node.path);
    arrow.textContent = isOpen ? '▾' : '▸';
    icon.textContent = isOpen ? '📂' : '📁';

    const childrenEl = document.createElement('div');
    childrenEl.className = 'node-children';
    if (!isOpen) childrenEl.classList.add('hidden');
    for (const child of node.children) {
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

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const items = [];
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

  return wrapper;
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
export function expandAncestors(filePath) {
  let dir = filePath;
  const sep = filePath.includes('\\') ? '\\' : '/';
  while (dir.length > state.baseFolder.length) {
    dir = dir.slice(0, dir.lastIndexOf(sep));
    if (dir.length >= state.baseFolder.length) expanded.add(dir);
  }
}

// ---- Context menu ----
// `items` is a list of { label, fn } — shared by the tree and the reminder list.
let menuEl = null;

export function showContextMenu(e, items) {
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

  const mkItem = (text, fn) => {
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
  if (e.target.closest('.node-row')) return; // a row handles its own menu
  e.preventDefault();
  if (!gitState || !gitState.files.length) return;
  showContextMenu(e, [
    {
      label: 'Discard all changes…',
      fn: () => discardChanges(state.baseFolder, 'dir', 'the whole vault'),
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
async function revealNode(node) {
  if (state.currentFile === node.path) await flushSave();
  const res = await api.revealPath(state.baseFolder, node.path);
  if (!res.ok) setStatus('Error: ' + res.error, true);
}

async function renameNode(node) {
  const newName = await promptModal('Rename to:', node.name);
  if (!newName || newName === node.name) return;
  // Flush first so the pending write lands on the old path before it moves,
  // rather than re-creating the old file after the rename.
  if (state.currentFile === node.path) await flushSave();
  const res = await api.renamePath(state.baseFolder, node.path, newName);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  if (state.currentFile === node.path) {
    const wasImage = isImage(node.path);
    state.currentFile = res.path;
    currentFileEl.textContent = relativePath(res.path);
    // A rename can change what kind of file this is (image ↔ text), and with it
    // which pane should be showing — re-open rather than leave the old one up.
    if (wasImage !== isImage(res.path)) await openFile(res.path);
    else applyView();
  }
  await refreshTree();
}

async function deleteNode(node) {
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
