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
const smartInputEl = document.getElementById('smart-input');
const smartCheckBtn = document.getElementById('smart-check-btn');
const smartAddBtn = document.getElementById('smart-add-btn');
const smartStatusEl = document.getElementById('smart-status');
const smartPreviewEl = document.getElementById('smart-preview');
const dividerPreviewEl = document.getElementById('divider-preview');
const renderedEl = document.getElementById('rendered');
const viewToggleEl = document.getElementById('view-toggle');
const viewRawBtn = document.getElementById('view-raw-btn');
const viewMdBtn = document.getElementById('view-md-btn');

// Editor view for the open file: 'raw' shows the source textarea, 'preview'
// shows rendered Markdown. Only applies to Markdown files; the choice persists.
let viewMode = localStorage.getItem('rawNotes.viewMode') === 'preview' ? 'preview' : 'raw';

// Smart-insert state: the last plan Claude returned, and the exact note text it
// was computed for. If the text changes, the plan is stale and Add re-checks.
let smartPlan = null;
let smartPlanFor = null;

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
  applyView();
  // Drop any smart-insert preview carried over from a previous folder.
  smartInputEl.value = '';
  smartPlan = null;
  smartPlanFor = null;
  hideSmartPreview();
  setSmartStatus('');
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

// ---- Raw / Markdown view ----
function isMarkdown(filePath) {
  return /\.(md|markdown|mdown|mkd)$/i.test(filePath || '');
}

// Render the current editor buffer as Markdown into the preview pane.
function renderMarkdown() {
  if (window.marked) {
    renderedEl.innerHTML = window.marked.parse(editorEl.value || '');
  } else {
    // marked failed to load — fall back to showing the source as-is.
    renderedEl.textContent = editorEl.value || '';
  }
  hydrateImages();
}

// marked emits <img src="images/foo.png"> with vault-relative paths, but the app's
// file:// origin + CSP won't load those directly. For each local image, ask the
// main process to resolve it (relative to the open file) and inline it as a data
// URL. Remote (http/data) sources are left alone. Captures the file the render was
// for so a stale async result from a previous file can't paint over a new one.
function hydrateImages() {
  const forFile = currentFile;
  renderedEl.querySelectorAll('img').forEach(async (img) => {
    const raw = img.getAttribute('src') || '';
    if (!raw || /^(https?:|data:)/i.test(raw)) return;
    const res = await api.readImage(baseFolder, forFile, raw);
    if (currentFile !== forFile) return; // file switched while we were loading
    if (res && res.ok) {
      img.src = res.dataUrl;
    } else {
      img.classList.add('img-missing');
      img.title = 'Image not found: ' + raw;
    }
  });
}

// Show the right pane for the current file + mode. The toggle is only offered
// for Markdown files; everything else is always edited raw.
function applyView() {
  const preview = viewMode === 'preview' && isMarkdown(currentFile) && !!currentFile;
  viewToggleEl.classList.toggle('hidden', !isMarkdown(currentFile) || !currentFile);
  if (preview) renderMarkdown();
  renderedEl.classList.toggle('hidden', !preview);
  editorEl.classList.toggle('hidden', preview);
  viewRawBtn.classList.toggle('active', !preview);
  viewMdBtn.classList.toggle('active', preview);
}

function setViewMode(mode) {
  viewMode = mode === 'preview' ? 'preview' : 'raw';
  localStorage.setItem('rawNotes.viewMode', viewMode);
  applyView();
  if (viewMode === 'raw' && currentFile) editorEl.focus();
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
  applyView();
  if (viewMode === 'raw' || !isMarkdown(filePath)) editorEl.focus();

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

// A promise-based text-input dialog. Electron does NOT support window.prompt()
// (it silently returns null), so anything that needs typed input uses this.
// Resolves to the trimmed string, or null if cancelled / left empty.
function promptModal(title, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal-box';

    const label = document.createElement('div');
    label.className = 'modal-title';
    label.textContent = title;

    const input = document.createElement('input');
    input.className = 'modal-input';
    input.type = 'text';
    input.value = defaultValue;

    const actions = document.createElement('div');
    actions.className = 'modal-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.className = 'modal-primary';
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);

    box.appendChild(label);
    box.appendChild(input);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    let done = false;
    function close(value) {
      if (done) return;
      done = true;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    }
    function submit() {
      const v = input.value.trim();
      close(v || null);
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        submit();
      }
    }

    okBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => close(null));
    // Click on the dimmed backdrop (but not the box) cancels.
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKey, true);

    // Focus and preselect the base name (before the extension) for fast editing.
    input.focus();
    const dot = defaultValue.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
}

// ---- Toolbar actions ----
async function newFile() {
  const name = await promptModal('New file name (e.g. notes.md or folder/note.md):', 'untitled.md');
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
  const name = await promptModal('New folder name:', 'new-folder');
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
  const newName = await promptModal('Rename to:', node.name);
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
    applyView();
  }
  await refreshTree();
}

// Escape a string for use in a CSS attribute selector.
function cssEscape(str) {
  return str.replace(/["\\]/g, '\\$&');
}

// ---- Smart insert ----

function setSmartStatus(text, isError) {
  smartStatusEl.textContent = text || '';
  smartStatusEl.classList.toggle('error', !!isError);
}

// Show / hide the preview panel and its resize divider together.
function showSmartPreview() {
  smartPreviewEl.classList.remove('hidden');
  dividerPreviewEl.classList.remove('hidden');
}
function hideSmartPreview() {
  smartPreviewEl.classList.add('hidden');
  dividerPreviewEl.classList.add('hidden');
}

// Toggle the busy state: disable inputs and show a message while Claude runs.
function smartBusy(busy, message) {
  smartInputEl.disabled = busy;
  smartCheckBtn.disabled = busy;
  smartAddBtn.disabled = busy;
  if (message) setSmartStatus(message);
}

// Ask Claude where the current note belongs. Renders a preview; writes nothing.
// Returns the plan on success, or null on failure / empty input.
async function smartCheck() {
  const text = smartInputEl.value.trim();
  if (!text) {
    setSmartStatus('Type a note first.', true);
    return null;
  }
  // Make sure the open file's latest edits are on disk before Claude reads it.
  await flushSave();

  smartBusy(true, 'Checking…');
  let res;
  try {
    res = await api.smartCheck(baseFolder, currentFile, text);
  } finally {
    smartBusy(false);
  }

  if (!res.ok) {
    smartPlan = null;
    smartPlanFor = null;
    hideSmartPreview();
    setSmartStatus(res.error, true);
    return null;
  }
  smartPlan = res.plan;
  smartPlanFor = text;
  renderPreview(res.plan);
  setSmartStatus('Review below, then Add to apply.');
  return res.plan;
}

// File the note. Re-checks automatically if there's no fresh plan for this text.
async function smartAdd() {
  const text = smartInputEl.value.trim();
  if (!text) {
    setSmartStatus('Type a note first.', true);
    return;
  }
  // Flush any pending editor change first so applying can't be clobbered by a
  // later autosave/flush of the currently-open file.
  await flushSave();

  let plan = smartPlan;
  if (!plan || smartPlanFor !== text) {
    plan = await smartCheck();
    if (!plan) return;
  }

  smartBusy(true, 'Adding…');
  let res;
  try {
    res = await api.smartApply(baseFolder, plan.targetFile, plan.newContent);
  } finally {
    smartBusy(false);
  }
  if (!res.ok) {
    setSmartStatus(res.error, true);
    return;
  }

  smartInputEl.value = '';
  smartPlan = null;
  smartPlanFor = null;
  hideSmartPreview();
  setSmartStatus('Added to ' + plan.targetFile);

  // Reveal and open the file we just wrote so the change is visible.
  expandAncestors(res.path);
  await refreshTree();
  const row = treeEl.querySelector(`[data-path="${cssEscape(res.path)}"]`);
  await openFile(res.path, row);
}

// A checked plan is only valid for the text it was computed from; once the note
// changes, drop the stale preview so Add re-checks rather than mis-filing.
function invalidateSmartPlan() {
  if (smartPlanFor !== null && smartInputEl.value.trim() !== smartPlanFor) {
    smartPlan = null;
    smartPlanFor = null;
    hideSmartPreview();
    setSmartStatus('');
  }
}

// Build a preview: target file, a NEW/EXISTING badge, Claude's reason, and a diff.
function renderPreview(plan) {
  smartPreviewEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'sp-head';
  const badge = document.createElement('span');
  badge.className = 'sp-badge' + (plan.isNew ? ' sp-new' : '');
  badge.textContent = plan.isNew ? 'NEW FILE' : 'EXISTING';
  const pathEl = document.createElement('span');
  pathEl.className = 'sp-path';
  pathEl.textContent = plan.targetFile;
  head.appendChild(badge);
  head.appendChild(pathEl);
  smartPreviewEl.appendChild(head);

  if (plan.reason) {
    const reason = document.createElement('div');
    reason.className = 'sp-reason';
    reason.textContent = plan.reason;
    smartPreviewEl.appendChild(reason);
  }

  const diff = document.createElement('pre');
  diff.className = 'sp-diff';
  for (const line of lineDiff(plan.oldContent || '', plan.newContent || '')) {
    const el = document.createElement('div');
    el.className = 'sp-line sp-' + line.type;
    const prefix = line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : line.type === 'gap' ? '' : '  ';
    el.textContent = prefix + line.text;
    diff.appendChild(el);
  }
  smartPreviewEl.appendChild(diff);
  showSmartPreview();
}

// Line-level diff via a longest-common-subsequence table, then collapse long
// runs of unchanged context so the preview stays focused on what changed.
function lineDiff(a, b) {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      ops.push({ type: 'ctx', text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: A[i] });
      i++;
    } else {
      ops.push({ type: 'add', text: B[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: 'del', text: A[i++] });
  while (j < m) ops.push({ type: 'add', text: B[j++] });

  return condenseDiff(ops);
}

// Keep 2 lines of context around each change; replace larger unchanged gaps with
// a single "⋯ N unchanged lines" marker.
function condenseDiff(ops) {
  const CONTEXT = 2;
  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].type !== 'ctx') {
      for (let d = -CONTEXT; d <= CONTEXT; d++) {
        if (k + d >= 0 && k + d < ops.length) keep[k + d] = true;
      }
    }
  }
  const out = [];
  let k = 0;
  while (k < ops.length) {
    if (keep[k]) {
      out.push(ops[k]);
      k++;
    } else {
      let count = 0;
      while (k < ops.length && !keep[k]) {
        count++;
        k++;
      }
      out.push({ type: 'gap', text: `⋯ ${count} unchanged line${count === 1 ? '' : 's'}` });
    }
  }
  return out;
}

// ---- Wire up buttons & shortcuts ----
document.getElementById('welcome-open-btn').addEventListener('click', chooseFolder);
document.getElementById('change-folder-btn').addEventListener('click', chooseFolder);
document.getElementById('refresh-btn').addEventListener('click', refreshTree);
document.getElementById('new-file-btn').addEventListener('click', newFile);
document.getElementById('new-folder-btn').addEventListener('click', newFolder);
smartCheckBtn.addEventListener('click', smartCheck);
smartAddBtn.addEventListener('click', smartAdd);
smartInputEl.addEventListener('input', invalidateSmartPlan);
viewRawBtn.addEventListener('click', () => setViewMode('raw'));
viewMdBtn.addEventListener('click', () => setViewMode('preview'));

// Links in the rendered Markdown must not navigate the app window. Open
// http(s)/mailto links in the real browser; ignore relative/in-vault links.
renderedEl.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href');
  if (href) api.openExternal(href);
});

// ---- Drag & drop images ----
// Dropping image files copies them into the vault's images/ folder and inserts a
// Markdown reference. In raw view the ref lands at the cursor; in preview view
// (where there's no cursor) it's appended to the end of the buffer.
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

function insertAtCursor(text) {
  const start = editorEl.selectionStart ?? editorEl.value.length;
  const end = editorEl.selectionEnd ?? editorEl.value.length;
  editorEl.value = editorEl.value.slice(0, start) + text + editorEl.value.slice(end);
  const pos = start + text.length;
  editorEl.selectionStart = editorEl.selectionEnd = pos;
}

async function handleDroppedFiles(fileList) {
  if (!currentFile) {
    setStatus('Open a file before adding images.', true);
    return;
  }
  const images = Array.from(fileList).filter(
    (f) => /^image\//.test(f.type) || IMAGE_RE.test(f.name)
  );
  if (!images.length) return;

  let added = 0;
  for (const file of images) {
    let srcPath = '';
    try {
      srcPath = api.getPathForFile(file);
    } catch {}
    if (!srcPath) {
      setStatus('Could not read the dropped file.', true);
      continue;
    }
    const res = await api.importImage(baseFolder, currentFile, srcPath, file.name);
    if (!res.ok) {
      setStatus('Error: ' + res.error, true);
      continue;
    }
    const alt = file.name.replace(/\.[^.]+$/, '');
    const snippet = `![${alt}](${res.ref})`;
    if (viewMode === 'raw' || !isMarkdown(currentFile)) {
      insertAtCursor(snippet + '\n');
    } else {
      const sep = !editorEl.value || editorEl.value.endsWith('\n') ? '' : '\n';
      editorEl.value += sep + snippet + '\n';
    }
    added++;
  }

  if (added) {
    dirty = true;
    setStatus('Saving…');
    scheduleSave();
    if (viewMode === 'preview' && isMarkdown(currentFile)) renderMarkdown();
    await refreshTree(); // surface the new images/ folder + files
  }
}

function setupDrop(el) {
  el.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', (e) => {
    if (e.target === el) el.classList.remove('drag-over');
  });
  el.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    el.classList.remove('drag-over');
    handleDroppedFiles(e.dataTransfer.files);
  });
}
setupDrop(editorEl);
setupDrop(renderedEl);

// Stop a stray drop elsewhere in the window from navigating the app to the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---- Resizable sidebar / editor split ----
(function setupDivider() {
  const divider = document.getElementById('divider');
  const sidebar = document.getElementById('sidebar');
  const MIN = 160;
  const MAX = 600; // keep in sync with .sidebar min/max-width in styles.css

  const clamp = (w) => Math.max(MIN, Math.min(MAX, w));

  // Restore a persisted width from a previous session.
  const saved = parseInt(localStorage.getItem('rawNotes.sidebarWidth'), 10);
  if (!Number.isNaN(saved)) sidebar.style.width = clamp(saved) + 'px';

  let dragging = false;

  function onMove(e) {
    if (!dragging) return;
    const left = workspaceEl.getBoundingClientRect().left;
    sidebar.style.width = clamp(e.clientX - left) + 'px';
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('rawNotes.sidebarWidth', parseInt(sidebar.style.width, 10));
  }

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    divider.classList.add('dragging');
    // Lock the cursor and stop text selection while dragging over the editor.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
})();

// ---- Resizable vertical stack (note box / preview / editor) ----
// Each row divider resizes the panel directly above it by setting its height;
// the editor is flex:1 and absorbs whatever's left. RESERVE keeps the editor
// from being squeezed away entirely.
function makeRowDivider(divider, panel, storageKey, minPx) {
  const paneEl = document.querySelector('.editor-pane');
  const RESERVE = 140;
  const clamp = (h) =>
    Math.max(minPx, Math.min(h, paneEl.getBoundingClientRect().height - RESERVE));

  const saved = parseInt(localStorage.getItem(storageKey), 10);
  if (!Number.isNaN(saved)) panel.style.height = clamp(saved) + 'px';

  let dragging = false;
  let startY = 0;
  let startH = 0;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    divider.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.height = clamp(startH + (e.clientY - startY)) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(storageKey, parseInt(panel.style.height, 10));
  });
}

makeRowDivider(
  document.getElementById('divider-input'),
  document.getElementById('smart-insert'),
  'rawNotes.inputHeight',
  70
);
makeRowDivider(
  document.getElementById('divider-preview'),
  document.getElementById('smart-preview'),
  'rawNotes.previewHeight',
  60
);

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
