// Wrapped in an IIFE so top-level `const`s (e.g. `api`) don't collide with the
// globals that contextBridge exposes on `window`.
(function () {
  'use strict';

  const api = window.api;

// ---- App state ----
let baseFolder = null;
let currentFile = null;
let dirty = false;
let saveTimer = null; // pending debounced autosave
const AUTOSAVE_MS = 400; // how long after the last keystroke we flush to disk
const expanded = new Set(); // dir paths currently expanded

// ---- Element refs ----
const welcomeEl = document.getElementById('welcome');
const workspaceEl = document.getElementById('workspace');
const treeEl = document.getElementById('tree');
const editorEl = document.getElementById('editor');
const currentFileEl = document.getElementById('current-file');
const statusEl = document.getElementById('status');
const vaultNameEl = document.getElementById('vault-name');

// ---- Startup ----
init();

async function init() {
  const last = await api.getLastFolder();
  if (last) {
    await openFolder(last);
  } else {
    showWelcome();
  }
}

function showWelcome() {
  welcomeEl.classList.remove('hidden');
  workspaceEl.classList.add('hidden');
}

async function openFolder(folder) {
  baseFolder = folder;
  currentFile = null;
  dirty = false;
  welcomeEl.classList.add('hidden');
  workspaceEl.classList.remove('hidden');
  vaultNameEl.textContent = folder.split(/[\\/]/).pop() || folder;
  vaultNameEl.title = folder;
  currentFileEl.textContent = 'No file open';
  editorEl.value = '';
  editorEl.disabled = true;
  await refreshTree();
}

async function chooseFolder() {
  const folder = await api.chooseFolder();
  if (folder) {
    expanded.clear();
    await openFolder(folder);
  }
}

async function refreshTree() {
  const tree = await api.readTree(baseFolder);
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
    icon.textContent = '📄';
    row.addEventListener('click', () => openFile(node.path, row));
  }

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, node);
  });

  return wrapper;
}

// ---- File open / edit / save ----
async function openFile(filePath, rowEl) {
  // Autosave means there's nothing to discard — just flush the current file first.
  await flushSave();

  const res = await api.readFile(filePath);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  currentFile = filePath;
  editorEl.value = res.content;
  editorEl.disabled = false;
  dirty = false;
  currentFileEl.textContent = relativePath(filePath);
  setStatus('Saved');
  editorEl.focus();

  document.querySelectorAll('.node-row.active').forEach((el) => el.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');
}

async function saveCurrent() {
  if (!currentFile || !dirty) return;
  // Capture the file being saved: it may change if this runs after a switch.
  const target = currentFile;
  const res = await api.writeFile(target, editorEl.value);
  if (res.ok) {
    if (currentFile === target) dirty = false;
    setStatus('Saved');
  } else {
    setStatus('Error: ' + res.error, true);
  }
}

// Debounce a save so a burst of keystrokes results in one write shortly after.
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCurrent();
  }, AUTOSAVE_MS);
}

// Cancel any pending autosave without writing (e.g. the file is being deleted).
function cancelPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// Write any pending change to disk now and wait for it to complete.
async function flushSave() {
  cancelPendingSave();
  await saveCurrent();
}

editorEl.addEventListener('input', () => {
  if (!currentFile) return;
  dirty = true;
  setStatus('Saving…');
  scheduleSave();
});

function setStatus(text, isError) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#ff6b6b' : 'var(--text-dim)';
}

function relativePath(filePath) {
  if (!baseFolder) return filePath;
  let rel = filePath.slice(baseFolder.length);
  rel = rel.replace(/^[\\/]/, '');
  return rel || filePath;
}

// ---- Toolbar actions ----
async function newFile() {
  const name = window.prompt('New file name (e.g. notes.md or folder/note.md):', 'untitled.md');
  if (!name) return;
  const res = await api.createFile(baseFolder, name);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  expandAncestors(res.path);
  await refreshTree();
  const row = treeEl.querySelector(`[data-path="${cssEscape(res.path)}"]`);
  await openFile(res.path, row);
}

async function newFolder() {
  const name = window.prompt('New folder name:', 'new-folder');
  if (!name) return;
  const res = await api.createFolder(baseFolder, name);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  expanded.add(res.path);
  await refreshTree();
}

// Make sure every ancestor dir of a path is expanded so it's visible.
function expandAncestors(filePath) {
  let dir = filePath;
  const sep = filePath.includes('\\') ? '\\' : '/';
  while (dir.length > baseFolder.length) {
    dir = dir.slice(0, dir.lastIndexOf(sep));
    if (dir.length >= baseFolder.length) expanded.add(dir);
  }
}

// ---- Context menu (rename / delete) ----
let menuEl = null;

function showContextMenu(e, node) {
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

  menuEl.appendChild(mkItem('Rename', () => renameNode(node)));
  menuEl.appendChild(mkItem('Delete', () => deleteNode(node)));
  document.body.appendChild(menuEl);
}

function removeContextMenu() {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

document.addEventListener('click', removeContextMenu);

async function renameNode(node) {
  const newName = window.prompt('Rename to:', node.name);
  if (!newName || newName === node.name) return;
  // Flush first so the pending write lands on the old path before it moves,
  // rather than re-creating the old file after the rename.
  if (currentFile === node.path) await flushSave();
  const res = await api.renamePath(baseFolder, node.path, newName);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  if (currentFile === node.path) {
    currentFile = res.path;
    currentFileEl.textContent = relativePath(res.path);
  }
  await refreshTree();
}

async function deleteNode(node) {
  if (!window.confirm(`Delete "${node.name}"? This cannot be undone.`)) return;
  // Drop any queued autosave so it can't re-create the file we're deleting.
  if (currentFile === node.path) cancelPendingSave();
  const res = await api.deletePath(baseFolder, node.path);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  if (currentFile === node.path) {
    currentFile = null;
    dirty = false;
    editorEl.value = '';
    editorEl.disabled = true;
    currentFileEl.textContent = 'No file open';
    setStatus('');
  }
  await refreshTree();
}

// Escape a string for use in a CSS attribute selector.
function cssEscape(str) {
  return str.replace(/["\\]/g, '\\$&');
}

// ---- Wire up buttons & shortcuts ----
document.getElementById('welcome-open-btn').addEventListener('click', chooseFolder);
document.getElementById('change-folder-btn').addEventListener('click', chooseFolder);
document.getElementById('refresh-btn').addEventListener('click', refreshTree);
document.getElementById('new-file-btn').addEventListener('click', newFile);
document.getElementById('new-folder-btn').addEventListener('click', newFolder);

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    flushSave();
  }
});

// On close, flush synchronously so a pending edit can't be lost to the window
// going away before an async write finishes.
window.addEventListener('beforeunload', () => {
  cancelPendingSave();
  if (currentFile && dirty) {
    const res = api.writeFileSync(currentFile, editorEl.value);
    if (res && res.ok) dirty = false;
  }
});
})();
