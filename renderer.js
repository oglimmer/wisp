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
const smartLookupBtn = document.getElementById('smart-lookup-btn');
const smartStatusEl = document.getElementById('smart-status');
const smartPreviewEl = document.getElementById('smart-preview');
const dividerPreviewEl = document.getElementById('divider-preview');
const renderedEl = document.getElementById('rendered');
const wysiwygEl = document.getElementById('wysiwyg');
const imageViewEl = document.getElementById('image-view');
const imageViewImgEl = document.getElementById('image-view-img');
const imageViewMetaEl = document.getElementById('image-view-meta');
const viewToggleEl = document.getElementById('view-toggle');
const viewRawBtn = document.getElementById('view-raw-btn');
const viewWysBtn = document.getElementById('view-wys-btn');
const viewMdBtn = document.getElementById('view-md-btn');
const findBarEl = document.getElementById('find-bar');
const findInputEl = document.getElementById('find-input');
const findCountEl = document.getElementById('find-count');
const findCaseBtn = document.getElementById('find-case-btn');
const findPrevBtn = document.getElementById('find-prev-btn');
const findNextBtn = document.getElementById('find-next-btn');
const findCloseBtn = document.getElementById('find-close-btn');
const findReplaceRowEl = document.getElementById('find-replace-row');
const replaceInputEl = document.getElementById('replace-input');
const replaceBtn = document.getElementById('replace-btn');
const replaceAllBtn = document.getElementById('replace-all-btn');
const findHighlightsEl = document.getElementById('find-highlights');
const reminderListEl = document.getElementById('reminder-list');
const reminderCountEl = document.getElementById('reminder-count');
const newReminderBtn = document.getElementById('new-reminder-btn');

// Editor view for the open file: 'raw' shows the source textarea, 'wysiwyg' shows
// a directly-editable formatted view, 'preview' shows read-only rendered Markdown.
// Only applies to Markdown files; the choice persists.
const VIEW_MODES = ['raw', 'wysiwyg', 'preview'];
let viewMode = VIEW_MODES.includes(localStorage.getItem('rawNotes.viewMode'))
  ? localStorage.getItem('rawNotes.viewMode')
  : 'raw';

// Heading of the collapsed block holding Claude's description of an image.
const IMAGE_SUMMARY = 'Image description';

// Lazily-built HTML→Markdown converter for the WYSIWYG editor. marked handles
// Markdown→HTML; turndown does the reverse so edits save back as Markdown.
let turndown = null;
function getTurndown() {
  if (turndown || !window.TurndownService) return turndown;
  turndown = new window.TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  // Emit the vault-relative path we stashed on hydrated images (their live src is
  // a data: URL), not the inlined base64 — so saved Markdown stays portable.
  turndown.addRule('vaultImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = node.getAttribute('alt') || '';
      const src = node.getAttribute('data-md-src') || node.getAttribute('src') || '';
      return src ? `![${alt}](${src})` : '';
    },
  });
  // Image-description blocks are raw HTML in the note; re-emit them as HTML
  // rather than letting turndown flatten them to their text. Not turndown.keep:
  // <details> isn't in turndown's block list, so a plain keep would splice it
  // inline and it would stop being its own HTML block. Rebuilt rather than echoed
  // via outerHTML because turndown collapses whitespace before rules run, which
  // would fold the block onto one line on every WYSIWYG save.
  turndown.addRule('detailsBlock', {
    filter: 'details',
    replacement: (_content, node) => {
      const summary = node.querySelector('summary');
      const label = summary ? summary.textContent.trim() : IMAGE_SUMMARY;
      const rest = node.cloneNode(true);
      const stale = rest.querySelector('summary');
      if (stale) stale.parentNode.removeChild(stale);
      // innerHTML, so escaped entities stay escaped exactly as they sit in the note.
      const body = rest.innerHTML.trim();
      return `\n\n<details>\n<summary>${label}</summary>\n${body}\n</details>\n\n`;
    },
  });
  return turndown;
}

// Smart-insert state: the last plan Claude returned, and the exact note text it
// was computed for. If the text changes, the plan is stale and Add re-checks.
let smartPlan = null;
let smartPlanFor = null;
// Whether the reminder Claude proposed alongside the plan will be created on Add
// (the checkbox in the preview). Reset every time a fresh plan is rendered.
let smartReminderOn = false;
// Smart-lookup state: the question the answer shown in the preview was asked for,
// so a changed question drops it the same way a stale plan is dropped.
let smartLookupFor = null;

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
  smartReminderOn = false;
  smartLookupFor = null;
  hideSmartPreview();
  setSmartStatus('');
  await refreshTree();
  await loadReminders();
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
    icon.textContent = isImage(node.path) ? '🖼' : '📄';
    row.addEventListener('click', () => openFile(node.path, row));
  }

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, [
      { label: 'Add reminder…', fn: () => newReminder(node.type === 'file' ? node.path : null) },
      { label: revealLabel(), fn: () => revealNode(node) },
      { label: 'Rename', fn: () => renameNode(node) },
      { label: 'Delete', fn: () => deleteNode(node) },
    ]);
  });

  return wrapper;
}

// ---- Raw / Markdown view ----
function isMarkdown(filePath) {
  return /\.(md|markdown|mdown|mkd)$/i.test(filePath || '');
}

// The image extensions the app knows about — what drag & drop imports, and what
// opens in the viewer pane instead of the text editor. (Kept in step with
// IMAGE_MIME in main.js, which decides what can actually be read.)
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

// Image files aren't text: opening one shows the picture, not its bytes.
function isImage(filePath) {
  return IMAGE_RE.test(filePath || '');
}

// Render the current editor buffer as Markdown into the preview pane.
function renderMarkdown() {
  if (window.marked) {
    renderedEl.innerHTML = window.marked.parse(editorEl.value || '');
  } else {
    // marked failed to load — fall back to showing the source as-is.
    renderedEl.textContent = editorEl.value || '';
  }
  hydrateImages(renderedEl);
}

// Render the current editor buffer as editable formatted HTML in the WYSIWYG pane.
function renderWysiwyg() {
  if (window.marked) {
    wysiwygEl.innerHTML = window.marked.parse(editorEl.value || '');
  } else {
    wysiwygEl.textContent = editorEl.value || '';
  }
  hydrateImages(wysiwygEl);
}

// Convert the WYSIWYG pane's current HTML back to Markdown and write it into the
// editor buffer (the single source of truth that gets saved). No-op unless we're
// actually in WYSIWYG mode with a file open and turndown available.
function syncWysiwygToEditor() {
  if (viewMode !== 'wysiwyg' || !currentFile) return;
  // Only fold back when there are real WYSIWYG edits (every edit sets `dirty`).
  // Skipping when clean keeps an unedited buffer byte-for-byte as loaded, so
  // turndown's normalisation never silently rewrites a file the user only viewed.
  if (!dirty) return;
  const td = getTurndown();
  if (!td) return; // turndown unavailable — leave the buffer untouched
  editorEl.value = td.turndown(wysiwygEl.innerHTML);
}

// marked emits <img src="images/foo.png"> with vault-relative paths, but the app's
// file:// origin + CSP won't load those directly. For each local image, ask the
// main process to resolve it (relative to the open file) and inline it as a data
// URL. Remote (http/data) sources are left alone. Captures the file the render was
// for so a stale async result from a previous file can't paint over a new one.
function hydrateImages(container) {
  const forFile = currentFile;
  container.querySelectorAll('img').forEach(async (img) => {
    const raw = img.getAttribute('src') || '';
    if (!raw || /^(https?:|data:)/i.test(raw)) return;
    // Stash the original vault-relative path before we swap in the data: URL, so
    // WYSIWYG edits can round-trip back to the portable Markdown reference.
    if (!img.dataset.mdSrc) img.dataset.mdSrc = raw;
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

// Which pane is actually live right now. `viewMode` is what the user picked, but
// non-Markdown files (and no file) always fall back to the raw textarea, and
// WYSIWYG needs turndown to save edits back — without it, it degrades to raw.
function effectiveViewMode() {
  // An image file has no text to edit at all — it always shows in the viewer.
  if (currentFile && isImage(currentFile)) return 'image';
  const md = !!currentFile && isMarkdown(currentFile);
  let mode = md ? viewMode : 'raw';
  if (mode === 'wysiwyg' && !window.TurndownService) mode = 'raw';
  return mode;
}

// The element holding the text the live pane shows — what search operates on.
function activePaneEl() {
  const mode = effectiveViewMode();
  if (mode === 'wysiwyg') return wysiwygEl;
  if (mode === 'preview') return renderedEl;
  if (mode === 'image') return imageViewEl;
  return editorEl;
}

// Show the right pane for the current file + mode. The toggle is only offered for
// Markdown files; everything else is always edited raw.
function applyView() {
  const mode = effectiveViewMode();
  const md = mode !== 'image' && isMarkdown(currentFile) && !!currentFile;
  viewToggleEl.classList.toggle('hidden', !md);

  const showRaw = mode === 'raw';
  const showWys = mode === 'wysiwyg';
  const showPreview = mode === 'preview';
  const showImage = mode === 'image';

  if (showWys) renderWysiwyg();
  if (showPreview) renderMarkdown();
  // The picture itself is loaded by openFile; dropping it when the pane goes away
  // keeps a big data URL from sitting in memory behind the next file.
  if (!showImage) clearImageView();

  editorEl.classList.toggle('hidden', !showRaw);
  wysiwygEl.classList.toggle('hidden', !showWys);
  renderedEl.classList.toggle('hidden', !showPreview);
  imageViewEl.classList.toggle('hidden', !showImage);

  viewRawBtn.classList.toggle('active', showRaw);
  viewWysBtn.classList.toggle('active', showWys);
  viewMdBtn.classList.toggle('active', showPreview);

  // A re-render throws away the nodes any search highlight pointed at, and a mode
  // switch changes which pane (and which text) is being searched.
  refreshFind();
}

function setViewMode(mode) {
  if (!VIEW_MODES.includes(mode)) mode = 'raw';
  if (mode === 'wysiwyg' && !window.TurndownService) mode = 'raw';
  // Leaving WYSIWYG: fold its edits back into the buffer before we switch panes,
  // otherwise raw/preview would show the pre-edit source.
  if (viewMode === 'wysiwyg' && mode !== 'wysiwyg') syncWysiwygToEditor();
  viewMode = mode;
  localStorage.setItem('rawNotes.viewMode', viewMode);
  applyView();
  if (!currentFile) return;
  if (viewMode === 'raw') editorEl.focus();
  else if (viewMode === 'wysiwyg') wysiwygEl.focus();
}

// ---- Image view ----
// Images are read as a data URL by main (same reason as the preview: the app's
// file:// origin + CSP won't load vault paths directly) and shown read-only.

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

// File size is known up front; the pixel dimensions only once the image decodes.
function updateImageMeta() {
  const size = imageViewEl.dataset.size || '';
  const w = imageViewImgEl.naturalWidth;
  const h = imageViewImgEl.naturalHeight;
  imageViewMetaEl.textContent = w && h ? `${w} × ${h}${size ? ' · ' + size : ''}` : size;
}

function showImageView(filePath, res) {
  imageViewEl.dataset.size = formatBytes(res.size);
  imageViewImgEl.alt = filePath.split(/[\\/]/).pop() || '';
  imageViewImgEl.src = res.dataUrl;
  updateImageMeta();
}

function clearImageView() {
  if (!imageViewImgEl.getAttribute('src')) return;
  // removeAttribute rather than src='' — an empty src would count as a failed load.
  imageViewImgEl.removeAttribute('src');
  imageViewImgEl.alt = '';
  imageViewMetaEl.textContent = '';
  delete imageViewEl.dataset.size;
}

imageViewImgEl.addEventListener('load', updateImageMeta);
imageViewImgEl.addEventListener('error', () => {
  if (!imageViewImgEl.getAttribute('src')) return; // cleared, not broken
  imageViewMetaEl.textContent = 'This image could not be displayed.';
});

// ---- File open / edit / save ----
async function openFile(filePath, rowEl) {
  // Autosave means there's nothing to discard — just flush the current file first.
  await flushSave();

  // An image is fetched as a data URL and shown; only text files reach the editor.
  const image = isImage(filePath);
  const res = image ? await api.readImageFile(baseFolder, filePath) : await api.readFile(filePath);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  currentFile = filePath;
  dirty = false;
  if (image) {
    // Keep the buffer empty and disabled: there is no text behind an image, so
    // nothing can be typed — and no autosave can overwrite the file with text.
    editorEl.value = '';
    editorEl.disabled = true;
    showImageView(filePath, res);
  } else {
    editorEl.value = res.content;
    editorEl.disabled = false;
  }
  currentFileEl.textContent = relativePath(filePath);
  setStatus(image ? 'Read-only' : 'Saved');
  applyView();
  if (image) {
    /* nothing to focus — the viewer takes no input */
  } else if (viewMode === 'raw' || !isMarkdown(filePath)) editorEl.focus();
  else if (viewMode === 'wysiwyg') wysiwygEl.focus();

  document.querySelectorAll('.node-row.active').forEach((el) => el.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');
}

async function saveCurrent() {
  if (!currentFile || !dirty) return;
  // In WYSIWYG mode the live edits are in the contenteditable pane, not the
  // textarea — fold them back into the buffer before persisting.
  syncWysiwygToEditor();
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

// Mark the open file as changed and start the autosave clock.
function markBufferEdited() {
  dirty = true;
  setStatus('Saving…');
  scheduleSave();
}

editorEl.addEventListener('input', () => {
  if (!currentFile) return;
  markBufferEdited();
  scheduleFindRefresh(); // typing moves the matches the find bar is pointing at
});

// WYSIWYG edits mark the buffer dirty too; scheduleSave → saveCurrent folds the
// contenteditable HTML back to Markdown at write time via syncWysiwygToEditor.
wysiwygEl.addEventListener('input', () => {
  if (!currentFile || viewMode !== 'wysiwyg') return;
  markBufferEdited();
  scheduleFindRefresh();
});

// Basic formatting shortcuts inside the WYSIWYG editor (bold / italic). execCommand
// is deprecated but remains the simplest reliable contenteditable API in Chromium.
wysiwygEl.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 'b') {
    e.preventDefault();
    document.execCommand('bold');
  } else if (key === 'i') {
    e.preventDefault();
    document.execCommand('italic');
  }
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

// ---- Context menu ----
// `items` is a list of { label, fn } — shared by the tree and the reminder list.
let menuEl = null;

function showContextMenu(e, items) {
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

// What the host OS calls its file manager, so the menu entry reads natively.
function revealLabel() {
  if (api.platform === 'darwin') return 'Reveal in Finder';
  if (api.platform === 'win32') return 'Show in Explorer';
  return 'Show in File Manager';
}

// Select the entry in the OS file manager. Flush first for the open file, so what
// the user finds on disk matches what they see in the editor.
async function revealNode(node) {
  if (currentFile === node.path) await flushSave();
  const res = await api.revealPath(baseFolder, node.path);
  if (!res.ok) setStatus('Error: ' + res.error, true);
}

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
    const wasImage = isImage(node.path);
    currentFile = res.path;
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
  smartLookupBtn.disabled = busy;
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
    smartReminderOn = false;
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

  // The file landed; now create the reminder Claude proposed, if it's still ticked.
  let remNote = '';
  if (plan.reminder && smartReminderOn) {
    await upsertReminder({
      id: plan.reminder.id || newReminderId(),
      title: plan.reminder.title,
      due: plan.reminder.due,
      repeat: plan.reminder.repeat || 'none',
      note: typeof plan.reminder.note === 'string' ? plan.reminder.note : text,
      file: typeof plan.reminder.file === 'string' ? plan.reminder.file : plan.targetFile,
    });
    remNote = ' · reminder ' + formatDue(plan.reminder.due);
  }

  smartInputEl.value = '';
  smartPlan = null;
  smartPlanFor = null;
  smartReminderOn = false;
  hideSmartPreview();
  setSmartStatus('Added to ' + plan.targetFile + remNote);

  // Reveal and open the file we just wrote so the change is visible.
  expandAncestors(res.path);
  await refreshTree();
  const row = treeEl.querySelector(`[data-path="${cssEscape(res.path)}"]`);
  await openFile(res.path, row);
}

// The other direction: read the vault instead of writing to it. Answers the text
// in the box from the notes and shows the answer, with its sources, in the preview.
async function smartLookup() {
  const question = smartInputEl.value.trim();
  if (!question) {
    setSmartStatus('Type a question first.', true);
    return;
  }
  // Make sure the open file's latest edits are on disk before Claude reads it.
  await flushSave();

  smartBusy(true, 'Looking up…');
  let res;
  try {
    res = await api.smartLookup(baseFolder, currentFile, question);
  } finally {
    smartBusy(false);
  }

  if (!res.ok) {
    // Only drop what this feature owns — a filing plan below stays valid.
    if (smartLookupFor !== null) {
      smartLookupFor = null;
      hideSmartPreview();
    }
    setSmartStatus(res.error, true);
    return;
  }
  // The preview pane shows one thing at a time; an answer replaces any filing plan,
  // so drop the plan rather than leave Add pointing at something no longer shown.
  smartPlan = null;
  smartPlanFor = null;
  smartReminderOn = false;
  smartLookupFor = question;
  renderLookup(res.result);
  const n = res.result.sources.length;
  setSmartStatus(n ? `Answered from ${n} file${n === 1 ? '' : 's'}.` : 'Answered.');
}

// A checked plan is only valid for the text it was computed from; once the note
// changes, drop the stale preview (plan or lookup answer) so Add re-checks rather
// than mis-filing and a stale answer isn't read as an answer to the new question.
function invalidateSmartPlan() {
  const text = smartInputEl.value.trim();
  if (smartPlanFor !== null && text !== smartPlanFor) {
    smartPlan = null;
    smartPlanFor = null;
    smartReminderOn = false;
    hideSmartPreview();
    setSmartStatus('');
  }
  if (smartLookupFor !== null && text !== smartLookupFor) {
    smartLookupFor = null;
    hideSmartPreview();
    setSmartStatus('');
  }
}

// Build a preview: target file, a NEW/EXISTING badge, Claude's reason, and a diff.
function renderPreview(plan) {
  smartPreviewEl.innerHTML = '';
  smartLookupFor = null; // the plan owns the preview pane now

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

  // Every check also asks Claude whether the note implies a reminder. When it
  // does, offer it here — opt-out, editable, and only created when Add is pressed.
  smartReminderOn = !!plan.reminder;
  if (plan.reminder) smartPreviewEl.appendChild(renderReminderProposal(plan));

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

// The reminder card inside the smart-insert preview: a checkbox to include it,
// what it will fire as, and an Edit… button that opens the normal reminder editor.
function renderReminderProposal(plan) {
  const card = document.createElement('div');
  card.className = 'sp-reminder';

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'sp-rem-check';
  check.checked = smartReminderOn;
  check.addEventListener('change', () => (smartReminderOn = check.checked));

  const body = document.createElement('div');
  body.className = 'sp-rem-body';

  const head = document.createElement('div');
  head.className = 'sp-rem-head';
  const badge = document.createElement('span');
  badge.className = 'sp-badge sp-rem-badge';
  badge.textContent = 'REMINDER';
  const title = document.createElement('span');
  title.className = 'sp-rem-title';
  title.textContent = plan.reminder.title;
  head.appendChild(badge);
  head.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'sp-rem-meta';
  const bits = [formatDue(plan.reminder.due)];
  if (plan.reminder.repeat && plan.reminder.repeat !== 'none') {
    bits.push(REPEAT_LABELS[plan.reminder.repeat]);
  }
  meta.textContent = bits.join(' · ');

  body.appendChild(head);
  body.appendChild(meta);
  if (plan.reminder.reason) {
    const why = document.createElement('div');
    why.className = 'sp-rem-why';
    why.textContent = plan.reminder.reason;
    body.appendChild(why);
  }

  const edit = document.createElement('button');
  edit.className = 'sp-rem-edit';
  edit.textContent = 'Edit…';
  edit.addEventListener('click', async () => {
    const res = await reminderModal({
      id: newReminderId(),
      title: plan.reminder.title,
      due: plan.reminder.due,
      repeat: plan.reminder.repeat,
      note: smartInputEl.value.trim(),
      file: plan.targetFile,
    });
    if (!res) return;
    if (res.action === 'delete') {
      plan.reminder = null;
      smartReminderOn = false;
    } else if (res.action === 'save') {
      plan.reminder = { ...res.reminder, reason: plan.reminder.reason };
    }
    renderPreview(plan);
  });

  card.appendChild(check);
  card.appendChild(body);
  card.appendChild(edit);
  return card;
}

// Render a lookup answer into the same preview pane: Claude's answer, then the
// files it drew on. Each source opens the note it names, so an answer stays
// checkable against what the vault actually says.
function renderLookup(result) {
  smartPreviewEl.innerHTML = '';

  const head = document.createElement('div');
  head.className = 'sp-head';
  const badge = document.createElement('span');
  badge.className = 'sp-badge sp-lookup-badge';
  badge.textContent = 'ANSWER';
  const q = document.createElement('span');
  q.className = 'sp-path';
  q.textContent = result.question;
  head.appendChild(badge);
  head.appendChild(q);
  smartPreviewEl.appendChild(head);

  const answer = document.createElement('div');
  answer.className = 'sp-answer';
  answer.textContent = result.answer;
  smartPreviewEl.appendChild(answer);

  if (result.sources.length) {
    const label = document.createElement('div');
    label.className = 'sp-sources-label';
    label.textContent = 'Sources';
    smartPreviewEl.appendChild(label);
  }

  for (const src of result.sources) {
    const row = document.createElement('div');
    row.className = 'sp-source';

    const link = document.createElement('button');
    link.className = 'sp-source-file';
    link.textContent = src.file;
    link.title = 'Open ' + src.file;
    link.addEventListener('click', () => openVaultNote(src.file));
    row.appendChild(link);

    if (src.detail) {
      const detail = document.createElement('span');
      detail.className = 'sp-source-detail';
      detail.textContent = src.detail;
      row.appendChild(detail);
    }
    smartPreviewEl.appendChild(row);
  }
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

// ---- Reminders ----
// The list lives in `.wisp-reminders.json` at the vault root and is held here in
// memory; every change rewrites the whole file (it's small, and it keeps the file
// and the UI trivially in sync). A ticker watches for due entries and raises a
// full-screen alert; each entry stores its *next* due time, so a repeating
// reminder is rolled forward rather than duplicated.

const REPEAT_LABELS = {
  none: 'Once',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};
const REMINDER_TICK_MS = 15000;
const SNOOZE_OPTIONS = [
  { label: 'Snooze 10 min', minutes: 10 },
  { label: 'Snooze 1 hour', minutes: 60 },
  { label: 'Snooze 1 day', minutes: 60 * 24 },
];

let reminders = [];
let reminderTicker = null;
// Which `id@due` pairs have already popped this session, so a reminder left
// overdue in the list doesn't re-alert every tick. A restart alerts again on
// purpose — an unhandled reminder should still be in your face.
const alerted = new Set();
const alertQueue = [];
let alertShowing = false;
let overdueSig = ''; // last-rendered set of overdue ids; drives re-renders

function newReminderId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ISO ⇄ the local "YYYY-MM-DD" / "HH:mm" pair the date and time inputs speak.
function toLocalParts(iso) {
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  };
}

function fromLocalParts(date, time) {
  if (!date) return null;
  const d = new Date(`${date}T${time || '09:00'}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// New reminders default to the next whole hour.
function defaultDue() {
  const d = new Date(Date.now() + 3600000);
  d.setMinutes(0, 0, 0);
  return d.toISOString();
}

// Whole calendar days between two dates, ignoring the time of day.
function dayDelta(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

function formatDue(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const now = new Date();
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const days = dayDelta(now, d);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  const opts =
    d.getFullYear() === now.getFullYear()
      ? { weekday: 'short', day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  return `${d.toLocaleDateString(undefined, opts)}, ${time}`;
}

// The nth occurrence after `start`, always recomputed from the original date so a
// month-end anchor (the 31st) doesn't drift forward through the short months.
function occurrenceAt(start, repeat, steps) {
  const d = new Date(start);
  if (repeat === 'daily') {
    d.setDate(d.getDate() + steps);
  } else if (repeat === 'weekly') {
    d.setDate(d.getDate() + 7 * steps);
  } else if (repeat === 'monthly' || repeat === 'yearly') {
    const months = (repeat === 'yearly' ? 12 : 1) * steps;
    const day = d.getDate();
    d.setDate(1); // avoid setMonth overflowing (31 Jan + 1 month → 3 Mar)
    d.setMonth(d.getMonth() + months);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  } else {
    return null;
  }
  return d;
}

// Roll a repeating reminder forward to its next occurrence strictly in the future.
// Returns null for one-off reminders (nothing to roll forward to).
function nextOccurrence(iso, repeat) {
  if (!repeat || repeat === 'none') return null;
  const start = new Date(iso);
  if (Number.isNaN(start.getTime())) return null;
  for (let steps = 1; steps <= 4000; steps++) {
    const d = occurrenceAt(start, repeat, steps);
    if (!d) return null;
    if (d.getTime() > Date.now()) return d.toISOString();
  }
  return null;
}

// Tolerate a hand-edited reminders file: drop anything without a usable title/date.
function normalizeReminder(r) {
  if (!r || typeof r !== 'object') return null;
  const title = typeof r.title === 'string' ? r.title.trim() : '';
  const when = new Date(typeof r.due === 'string' ? r.due : '');
  if (!title || Number.isNaN(when.getTime())) return null;
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newReminderId(),
    title,
    due: when.toISOString(),
    repeat: REPEAT_LABELS[r.repeat] ? r.repeat : 'none',
    note: typeof r.note === 'string' ? r.note : '',
    file: typeof r.file === 'string' ? r.file : '',
  };
}

async function loadReminders() {
  const res = await api.readReminders(baseFolder);
  reminders = (res.reminders || []).map(normalizeReminder).filter(Boolean);
  alerted.clear();
  alertQueue.length = 0;
  overdueSig = '';
  sortReminders();
  renderReminders();
  startReminderTicker();
}

function sortReminders() {
  reminders.sort((a, b) => Date.parse(a.due) - Date.parse(b.due));
}

async function persistReminders() {
  sortReminders();
  renderReminders();
  const res = await api.writeReminders(baseFolder, reminders);
  if (!res.ok) setStatus('Error saving reminders: ' + res.error, true);
}

async function upsertReminder(rem) {
  const i = reminders.findIndex((r) => r.id === rem.id);
  if (i === -1) reminders.push(rem);
  else reminders[i] = rem;
  await persistReminders();
}

// Completing a repeating reminder rolls it forward; a one-off is done for good.
async function completeReminder(id) {
  const i = reminders.findIndex((r) => r.id === id);
  if (i === -1) return;
  const next = nextOccurrence(reminders[i].due, reminders[i].repeat);
  if (next) reminders[i] = { ...reminders[i], due: next };
  else reminders.splice(i, 1);
  await persistReminders();
}

async function snoozeReminder(id, minutes) {
  const rem = reminders.find((r) => r.id === id);
  if (!rem) return;
  rem.due = new Date(Date.now() + minutes * 60000).toISOString();
  await persistReminders();
}

async function removeReminder(id) {
  const i = reminders.findIndex((r) => r.id === id);
  if (i === -1) return;
  reminders.splice(i, 1);
  await persistReminders();
}

// ---- Reminder list UI ----
function renderReminders() {
  reminderListEl.innerHTML = '';
  const now = Date.now();
  let overdue = 0;

  if (!reminders.length) {
    const empty = document.createElement('div');
    empty.className = 'reminder-empty';
    empty.textContent = 'No reminders. Use ＋ to add one.';
    reminderListEl.appendChild(empty);
  }

  for (const rem of reminders) {
    const isOverdue = Date.parse(rem.due) <= now;
    if (isOverdue) overdue++;

    const row = document.createElement('div');
    row.className = 'reminder-row' + (isOverdue ? ' overdue' : '');
    row.title = rem.note || rem.title;

    const icon = document.createElement('span');
    icon.className = 'reminder-icon';
    icon.textContent = isOverdue ? '🔔' : '⏰';

    const body = document.createElement('div');
    body.className = 'reminder-body';

    const title = document.createElement('div');
    title.className = 'reminder-title';
    title.textContent = rem.title;

    const meta = document.createElement('div');
    meta.className = 'reminder-meta';
    const bits = [formatDue(rem.due)];
    if (rem.repeat && rem.repeat !== 'none') bits.push(REPEAT_LABELS[rem.repeat]);
    if (rem.file) bits.push(rem.file);
    meta.textContent = bits.join(' · ');

    body.appendChild(title);
    body.appendChild(meta);

    const done = document.createElement('button');
    done.className = 'reminder-done';
    done.textContent = '✓';
    done.title = rem.repeat === 'none' ? 'Complete' : 'Complete this occurrence';
    done.addEventListener('click', (e) => {
      e.stopPropagation();
      completeReminder(rem.id);
    });

    row.appendChild(icon);
    row.appendChild(body);
    row.appendChild(done);

    row.addEventListener('click', () => editReminder(rem));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const items = [{ label: 'Edit…', fn: () => editReminder(rem) }];
      if (rem.file) items.push({ label: 'Open note', fn: () => openVaultNote(rem.file) });
      items.push({ label: 'Complete', fn: () => completeReminder(rem.id) });
      items.push({ label: 'Delete', fn: () => removeReminder(rem.id) });
      showContextMenu(e, items);
    });

    reminderListEl.appendChild(row);
  }

  reminderCountEl.textContent = String(overdue);
  reminderCountEl.classList.toggle('hidden', overdue === 0);
}

// Open a note by its vault-relative path (reminders and lookup sources both use this).
async function openVaultNote(rel) {
  if (!rel || !baseFolder) return;
  const sep = baseFolder.includes('\\') ? '\\' : '/';
  const full = baseFolder + sep + String(rel).split('/').join(sep);
  expandAncestors(full);
  await refreshTree();
  const row = treeEl.querySelector(`[data-path="${cssEscape(full)}"]`);
  await openFile(full, row);
}

async function newReminder(forFilePath) {
  const file = forFilePath || currentFile;
  const res = await reminderModal(null, file ? relativePath(file) : '');
  if (res && res.action === 'save') await upsertReminder(res.reminder);
}

async function editReminder(rem) {
  const res = await reminderModal(rem);
  if (!res) return;
  if (res.action === 'save') await upsertReminder(res.reminder);
  else if (res.action === 'delete') await removeReminder(rem.id);
  else if (res.action === 'open') await openVaultNote(rem.file);
}

// ---- Reminder editor ----
// Same promise-based pattern as promptModal (Electron has no window.prompt), but
// with the fields a reminder needs. Resolves to { action, reminder } or null.
function reminderModal(existing, defaultFile = '') {
  return new Promise((resolve) => {
    const base = existing || {
      id: newReminderId(),
      title: '',
      due: defaultDue(),
      repeat: 'none',
      note: '',
      file: defaultFile,
    };
    const parts = toLocalParts(base.due);

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const box = document.createElement('div');
    box.className = 'modal-box rm-box';

    const heading = document.createElement('div');
    heading.className = 'modal-title';
    heading.textContent = existing ? 'Edit reminder' : 'New reminder';
    box.appendChild(heading);

    // label + control, stacked
    const field = (labelText, control, className) => {
      const wrap = document.createElement('div');
      wrap.className = 'rm-field' + (className ? ' ' + className : '');
      const label = document.createElement('label');
      label.className = 'rm-label';
      label.textContent = labelText;
      wrap.appendChild(label);
      wrap.appendChild(control);
      box.appendChild(wrap);
      return wrap;
    };

    const titleInput = document.createElement('input');
    titleInput.className = 'modal-input';
    titleInput.type = 'text';
    titleInput.value = base.title;
    titleInput.placeholder = 'What should you be reminded of?';
    field('Reminder', titleInput);

    // Date / time / repeat share one row.
    const whenRow = document.createElement('div');
    whenRow.className = 'rm-row';
    const dateInput = document.createElement('input');
    dateInput.className = 'modal-input';
    dateInput.type = 'date';
    dateInput.value = parts.date;
    const timeInput = document.createElement('input');
    timeInput.className = 'modal-input';
    timeInput.type = 'time';
    timeInput.value = parts.time;
    const repeatSelect = document.createElement('select');
    repeatSelect.className = 'modal-input';
    for (const [value, label] of Object.entries(REPEAT_LABELS)) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      repeatSelect.appendChild(opt);
    }
    repeatSelect.value = REPEAT_LABELS[base.repeat] ? base.repeat : 'none';

    const cell = (labelText, control) => {
      const wrap = document.createElement('div');
      wrap.className = 'rm-field';
      const label = document.createElement('label');
      label.className = 'rm-label';
      label.textContent = labelText;
      wrap.appendChild(label);
      wrap.appendChild(control);
      whenRow.appendChild(wrap);
    };
    cell('Date', dateInput);
    cell('Time', timeInput);
    cell('Repeat', repeatSelect);
    box.appendChild(whenRow);

    const noteInput = document.createElement('textarea');
    noteInput.className = 'modal-input rm-note';
    noteInput.rows = 3;
    noteInput.value = base.note;
    noteInput.placeholder = 'Optional details shown in the popup';
    field('Details', noteInput);

    const fileInput = document.createElement('input');
    fileInput.className = 'modal-input';
    fileInput.type = 'text';
    fileInput.value = base.file;
    fileInput.placeholder = 'Optional — e.g. work/projects.md';
    field('Linked note', fileInput);

    const actions = document.createElement('div');
    actions.className = 'modal-actions rm-actions';
    if (existing) {
      const delBtn = document.createElement('button');
      delBtn.textContent = 'Delete';
      delBtn.className = 'rm-danger';
      delBtn.addEventListener('click', () => close({ action: 'delete' }));
      actions.appendChild(delBtn);
    }
    if (existing && base.file) {
      const openBtn = document.createElement('button');
      openBtn.textContent = 'Open note';
      openBtn.addEventListener('click', () => close({ action: 'open' }));
      actions.appendChild(openBtn);
    }
    const spacer = document.createElement('div');
    spacer.className = 'rm-spacer';
    actions.appendChild(spacer);
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    const okBtn = document.createElement('button');
    okBtn.textContent = 'Save';
    okBtn.className = 'modal-primary';
    actions.appendChild(cancelBtn);
    actions.appendChild(okBtn);
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
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.classList.add('invalid');
        titleInput.focus();
        return;
      }
      const due = fromLocalParts(dateInput.value, timeInput.value);
      if (!due) {
        dateInput.classList.add('invalid');
        dateInput.focus();
        return;
      }
      close({
        action: 'save',
        reminder: {
          id: base.id,
          title,
          due,
          repeat: repeatSelect.value,
          note: noteInput.value.trim(),
          file: fileInput.value.trim(),
        },
      });
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(null);
      } else if (e.key === 'Enter' && e.target !== noteInput) {
        e.preventDefault();
        submit();
      }
    }

    box.addEventListener('input', (e) => e.target.classList.remove('invalid'));
    okBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close(null);
    });
    document.addEventListener('keydown', onKey, true);

    titleInput.focus();
    titleInput.select();
  });
}

// ---- Due watching + the alert popup ----
function startReminderTicker() {
  if (reminderTicker) clearInterval(reminderTicker);
  reminderTicker = setInterval(checkDueReminders, REMINDER_TICK_MS);
  checkDueReminders();
}

function checkDueReminders() {
  const now = Date.now();
  const due = [];
  for (const rem of reminders) {
    const t = Date.parse(rem.due);
    if (Number.isNaN(t) || t > now) continue;
    due.push(rem.id);
    const key = rem.id + '@' + rem.due;
    if (alerted.has(key)) continue;
    alerted.add(key);
    alertQueue.push(rem.id);
  }
  // Only repaint when the overdue set actually changed, so the list doesn't
  // flicker under the cursor every tick.
  const sig = due.join(',');
  if (sig !== overdueSig) {
    overdueSig = sig;
    renderReminders();
  }
  drainAlerts();
}

// Show queued alerts one at a time — several reminders can come due together.
function drainAlerts() {
  if (alertShowing) return;
  while (alertQueue.length) {
    const rem = reminders.find((r) => r.id === alertQueue.shift());
    if (rem) {
      showReminderAlert(rem);
      return;
    }
  }
}

function showReminderAlert(rem) {
  alertShowing = true;
  api.alertWindow(); // bring the window forward / flash the taskbar

  const overlay = document.createElement('div');
  overlay.className = 'alert-overlay';

  const box = document.createElement('div');
  box.className = 'alert-box';

  const bell = document.createElement('div');
  bell.className = 'alert-bell';
  bell.textContent = '🔔';

  const kicker = document.createElement('div');
  kicker.className = 'alert-kicker';
  kicker.textContent = rem.repeat === 'none' ? 'Reminder' : REPEAT_LABELS[rem.repeat] + ' reminder';

  const title = document.createElement('div');
  title.className = 'alert-title';
  title.textContent = rem.title;

  const when = document.createElement('div');
  when.className = 'alert-when';
  when.textContent = formatDue(rem.due);

  box.appendChild(bell);
  box.appendChild(kicker);
  box.appendChild(title);
  box.appendChild(when);

  if (rem.note) {
    const note = document.createElement('div');
    note.className = 'alert-note';
    note.textContent = rem.note;
    box.appendChild(note);
  }

  const actions = document.createElement('div');
  actions.className = 'alert-actions';

  const mkBtn = (label, className, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (className) b.className = className;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    return b;
  };

  for (const opt of SNOOZE_OPTIONS) {
    mkBtn(opt.label, 'alert-snooze', () => {
      close();
      snoozeReminder(rem.id, opt.minutes);
    });
  }
  if (rem.file) {
    mkBtn('Open note', '', () => {
      close();
      openVaultNote(rem.file);
    });
  }
  const doneBtn = mkBtn(
    rem.repeat === 'none' ? 'Done' : 'Done — next ' + REPEAT_LABELS[rem.repeat].toLowerCase(),
    'alert-primary',
    () => {
      close();
      completeReminder(rem.id);
    }
  );

  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    alertShowing = false;
    renderReminders(); // the entry is overdue now — repaint it as such
    drainAlerts();
  }
  // Escape just dismisses the popup; the reminder stays in the list, overdue.
  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
  document.addEventListener('keydown', onKey, true);
  doneBtn.focus();
}

// ---- Find & replace ----
// Search inside the open file, with the shortcuts an editor is expected to have:
// ⌘F / Ctrl+F to open, ⌘G / F3 (+⇧ to reverse) to step, ⌘⌥F / Ctrl+H for replace,
// Esc to close (leaving the caret on the match you stopped at).
//
// Highlighting takes two different routes, because the panes are different beasts:
//   * the raw textarea can't hold markup, so `#find-highlights` mirrors its text
//     exactly behind it and only the match backgrounds show through;
//   * the WYSIWYG / preview panes are real DOM, so matches are painted with the
//     CSS Custom Highlight API — that keeps the document untouched, where wrapping
//     matches in <mark>s would let highlights leak into the saved Markdown.
//
// Replace is a source-level edit, so it's Raw-only (opening it switches views).

// Ceiling on how many matches we collect: a one-character query in a large note
// would otherwise build tens of thousands of highlight spans. The count says
// "2000+" when we hit it, and Replace All reports that it only did the first batch.
const FIND_MAX = 2000;
let findOpen = false;
// Raw mode: `{start, end}` offsets into the buffer. WYSIWYG / preview: live Ranges.
let findMatches = [];
let findIndex = -1;
let findRefreshTimer = null;
let findCase = localStorage.getItem('rawNotes.findCase') === '1';
const HL_ALL = 'wisp-find';
const HL_CURRENT = 'wisp-find-current';
const hasHighlightApi = typeof window.Highlight === 'function' && !!(window.CSS && CSS.highlights);

// Scan `text` for every occurrence of `query`, honouring the match-case toggle.
// Overlapping matches are skipped (each scan resumes after the previous hit).
function findInText(text, query) {
  const out = [];
  if (!query) return out;
  let hay = text;
  let needle = query;
  if (!findCase) {
    const lower = text.toLowerCase();
    // Lower-casing changes length for a few exotic codepoints, which would skew
    // every offset — fall back to a case-sensitive scan if it does.
    if (lower.length === text.length) {
      hay = lower;
      needle = query.toLowerCase();
    }
  }
  let from = 0;
  for (;;) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    out.push({ start: i, end: i + needle.length });
    if (out.length >= FIND_MAX) break;
    from = i + needle.length;
  }
  return out;
}

// The same scan against a rendered pane: flatten its text nodes into one string,
// search that, then map each hit back onto a Range (it may span several nodes).
function findInDom(container, query) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  if (!nodes.length) return [];

  // The node containing offset `pos` — the last one that starts at or before it.
  const at = (pos) => {
    let lo = 0;
    let hi = nodes.length - 1;
    let k = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (nodes[mid].start <= pos) {
        k = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return { node: nodes[k].node, offset: pos - nodes[k].start };
  };

  return findInText(text, query).map((m) => {
    const a = at(m.start);
    const b = at(m.end);
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  });
}

// Drop every highlight from both routes (cheap, and always safe to over-call).
function clearFindHighlights() {
  findHighlightsEl.textContent = '';
  findHighlightsEl.classList.add('hidden');
  if (hasHighlightApi) {
    CSS.highlights.delete(HL_ALL);
    CSS.highlights.delete(HL_CURRENT);
  }
}

// Keep the mirror's box in step with the textarea: an explicit width from
// clientWidth excludes any scrollbar, so both wrap at exactly the same column.
function syncHighlightBox() {
  findHighlightsEl.style.width = editorEl.clientWidth + 'px';
  findHighlightsEl.scrollTop = editorEl.scrollTop;
}

// Rebuild the mirror: the buffer's text with each match wrapped in a span. Built
// as nodes rather than an HTML string so the text can't be interpreted as markup.
function paintTextareaHighlights() {
  clearFindHighlights();
  if (!findMatches.length) return;
  const text = editorEl.value;
  const frag = document.createDocumentFragment();
  let pos = 0;
  findMatches.forEach((m, i) => {
    if (m.start > pos) frag.appendChild(document.createTextNode(text.slice(pos, m.start)));
    const span = document.createElement('span');
    span.className = i === findIndex ? 'find-hit current' : 'find-hit';
    span.textContent = text.slice(m.start, m.end);
    frag.appendChild(span);
    pos = m.end;
  });
  // The trailing newline keeps a final empty line's box, matching the textarea.
  frag.appendChild(document.createTextNode(text.slice(pos) + '\n'));
  findHighlightsEl.appendChild(frag);
  findHighlightsEl.classList.remove('hidden');
  syncHighlightBox();
}

function paintDomHighlights() {
  clearFindHighlights();
  if (!hasHighlightApi || !findMatches.length) return;
  // The current match lives in its own highlight so it can be coloured apart;
  // it's excluded from the other one so the two backgrounds don't stack.
  CSS.highlights.set(HL_ALL, new Highlight(...findMatches.filter((_, i) => i !== findIndex)));
  const current = findMatches[findIndex];
  if (current) CSS.highlights.set(HL_CURRENT, new Highlight(current));
}

function paintFindHighlights() {
  if (effectiveViewMode() === 'raw') paintTextareaHighlights();
  else paintDomHighlights();
}

function updateFindCount() {
  const has = findMatches.length > 0;
  findInputEl.classList.toggle('no-match', !!findInputEl.value && !has);
  if (!findInputEl.value) findCountEl.textContent = '';
  else if (!has) findCountEl.textContent = 'No results';
  else {
    // At the cap there are more matches than we scanned for — say so rather than
    // claiming the total is 2000.
    const total = findMatches.length + (findMatches.length >= FIND_MAX ? '+' : '');
    findCountEl.textContent = `${findIndex + 1}/${total}`;
  }
}

// Bring the current match into view, centring it when it's off-screen.
function scrollToCurrentMatch() {
  const m = findMatches[findIndex];
  if (!m) return;
  const MARGIN = 24;
  if (effectiveViewMode() === 'raw') {
    const span = findHighlightsEl.querySelector('.find-hit.current');
    if (!span) return;
    // The mirror shares the textarea's metrics and padding, so an offset measured
    // in one is directly usable as a scroll position in the other.
    const top = span.offsetTop;
    const bottom = top + span.offsetHeight;
    if (top < editorEl.scrollTop + MARGIN || bottom > editorEl.scrollTop + editorEl.clientHeight - MARGIN) {
      editorEl.scrollTop = Math.max(0, top - editorEl.clientHeight / 2);
    }
    findHighlightsEl.scrollTop = editorEl.scrollTop;
  } else {
    const pane = activePaneEl();
    const rect = m.getBoundingClientRect();
    const box = pane.getBoundingClientRect();
    if (rect.top < box.top + MARGIN || rect.bottom > box.bottom - MARGIN) {
      pane.scrollTop += rect.top - box.top - pane.clientHeight / 2;
    }
  }
}

// Re-scan for the current query and repaint. `anchor` (a buffer offset, raw mode
// only) picks the first match at or after it, so search starts from the caret and
// an edit doesn't throw the user back to the top of the file.
function refreshFind(anchor) {
  if (!findOpen) return;
  clearFindHighlights();
  findMatches = [];
  findIndex = -1;

  const mode = effectiveViewMode();
  const query = findInputEl.value;
  // 'image' is the one mode with nothing to search — the pane holds a picture.
  if (query && mode !== 'image') {
    findMatches = mode === 'raw' ? findInText(editorEl.value, query) : findInDom(activePaneEl(), query);
  }
  if (findMatches.length) {
    findIndex = 0;
    if (typeof anchor === 'number' && mode === 'raw') {
      const i = findMatches.findIndex((m) => m.start >= anchor);
      if (i !== -1) findIndex = i;
    }
  }
  paintFindHighlights();
  updateFindCount();
  scrollToCurrentMatch();
}

// Editing coalesces re-scans: one pass shortly after the last keystroke instead of
// one per character, which matters on a large file.
function scheduleFindRefresh() {
  if (!findOpen) return;
  if (findRefreshTimer) clearTimeout(findRefreshTimer);
  findRefreshTimer = setTimeout(() => {
    findRefreshTimer = null;
    refreshFind(effectiveViewMode() === 'raw' ? editorEl.selectionStart : undefined);
  }, 120);
}

function findStep(delta) {
  if (!findMatches.length) return;
  findIndex = (findIndex + delta + findMatches.length) % findMatches.length;
  paintFindHighlights();
  updateFindCount();
  scrollToCurrentMatch();
}

// A short single-line selection is what the user most likely wants to search for.
function selectionSeed() {
  let text = '';
  if (effectiveViewMode() === 'raw') {
    text = editorEl.value.slice(editorEl.selectionStart ?? 0, editorEl.selectionEnd ?? 0);
  } else {
    const sel = window.getSelection();
    if (sel) text = sel.toString();
  }
  if (!text || text.length > 200 || /[\r\n]/.test(text)) return '';
  return text;
}

function openFind(withReplace) {
  // Replace rewrites the Markdown source; the visual panes are projections of it,
  // so switch to the buffer itself rather than offering a control that can't work.
  // (Not for an image: there's no source buffer behind it to switch to.)
  const mode = effectiveViewMode();
  if (withReplace && currentFile && mode !== 'raw' && mode !== 'image') {
    setViewMode('raw');
    setStatus('Switched to Raw view to replace');
  }
  const caret = editorEl.selectionStart;
  findOpen = true;
  findBarEl.classList.remove('hidden');
  if (withReplace) findReplaceRowEl.classList.remove('hidden');
  findCaseBtn.classList.toggle('active', findCase);

  const seed = selectionSeed();
  if (seed) findInputEl.value = seed;
  refreshFind(caret);
  findInputEl.focus();
  findInputEl.select();
}

function closeFind() {
  if (!findOpen) return;
  const match = findMatches[findIndex];
  const mode = effectiveViewMode();
  findOpen = false;
  findBarEl.classList.add('hidden');
  findReplaceRowEl.classList.add('hidden');
  clearFindHighlights();
  if (findRefreshTimer) {
    clearTimeout(findRefreshTimer);
    findRefreshTimer = null;
  }
  // Hand focus back to the editor, leaving the caret on the match we stopped at.
  if (mode === 'raw') {
    if (!editorEl.disabled) {
      editorEl.focus();
      if (match) editorEl.setSelectionRange(match.start, match.end);
    }
  } else if (mode === 'wysiwyg') {
    wysiwygEl.focus();
  }
  findMatches = [];
  findIndex = -1;
}

function replaceCurrent() {
  if (!currentFile || effectiveViewMode() !== 'raw') return;
  const m = findMatches[findIndex];
  if (!m) return;
  const replacement = replaceInputEl.value;
  const text = editorEl.value;
  editorEl.value = text.slice(0, m.start) + replacement + text.slice(m.end);
  markBufferEdited();
  // Continue from just past what we wrote, so a replacement containing the query
  // ("a" → "aa") can't be found and replaced over and over.
  refreshFind(m.start + replacement.length);
}

function replaceAll() {
  if (!currentFile || effectiveViewMode() !== 'raw' || !findMatches.length) return;
  const replacement = replaceInputEl.value;
  const text = editorEl.value;
  const capped = findMatches.length >= FIND_MAX;
  let out = '';
  let pos = 0;
  for (const m of findMatches) {
    out += text.slice(pos, m.start) + replacement;
    pos = m.end;
  }
  const count = findMatches.length;
  editorEl.value = out + text.slice(pos);
  markBufferEdited();
  refreshFind(0);
  setStatus(
    `Replaced ${count} ${count === 1 ? 'match' : 'matches'}` +
      (capped ? ` (the first ${FIND_MAX} — run it again for the rest)` : '')
  );
}

findInputEl.addEventListener('input', () => {
  refreshFind(effectiveViewMode() === 'raw' ? editorEl.selectionStart : undefined);
});

findInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    findStep(e.shiftKey ? -1 : 1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});

replaceInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) replaceAll();
    else replaceCurrent();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeFind();
  }
});

findPrevBtn.addEventListener('click', () => findStep(-1));
findNextBtn.addEventListener('click', () => findStep(1));
findCloseBtn.addEventListener('click', closeFind);
replaceBtn.addEventListener('click', replaceCurrent);
replaceAllBtn.addEventListener('click', replaceAll);
findCaseBtn.addEventListener('click', () => {
  findCase = !findCase;
  localStorage.setItem('rawNotes.findCase', findCase ? '1' : '0');
  findCaseBtn.classList.toggle('active', findCase);
  refreshFind();
  findInputEl.focus();
});

// The mirror scrolls with the textarea, and rewraps when the pane is resized.
editorEl.addEventListener('scroll', () => {
  if (findOpen) findHighlightsEl.scrollTop = editorEl.scrollTop;
});
window.addEventListener('resize', () => {
  if (findOpen && effectiveViewMode() === 'raw') syncHighlightBox();
});

// ---- Wire up buttons & shortcuts ----
document.getElementById('welcome-open-btn').addEventListener('click', chooseFolder);
document.getElementById('change-folder-btn').addEventListener('click', chooseFolder);
document.getElementById('refresh-btn').addEventListener('click', refreshTree);
document.getElementById('new-file-btn').addEventListener('click', newFile);
document.getElementById('new-folder-btn').addEventListener('click', newFolder);
smartCheckBtn.addEventListener('click', smartCheck);
smartAddBtn.addEventListener('click', smartAdd);
smartLookupBtn.addEventListener('click', smartLookup);
smartInputEl.addEventListener('input', invalidateSmartPlan);
newReminderBtn.addEventListener('click', () => newReminder(null));
viewRawBtn.addEventListener('click', () => setViewMode('raw'));
viewWysBtn.addEventListener('click', () => setViewMode('wysiwyg'));
viewMdBtn.addEventListener('click', () => setViewMode('preview'));
// Turndown powers WYSIWYG→Markdown; if it didn't load, don't offer the mode.
if (!window.TurndownService) viewWysBtn.classList.add('hidden');

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

function insertAtCursor(text) {
  const start = editorEl.selectionStart ?? editorEl.value.length;
  const end = editorEl.selectionEnd ?? editorEl.value.length;
  editorEl.value = editorEl.value.slice(0, start) + text + editorEl.value.slice(end);
  const pos = start + text.length;
  editorEl.selectionStart = editorEl.selectionEnd = pos;
}

// A collapsed Range at the very end of the visual editor — the fallback drop point
// when we can't resolve where the drop landed.
function endOfWysiwygRange() {
  const range = document.createRange();
  range.selectNodeContents(wysiwygEl);
  range.collapse(false); // to the end
  return range;
}

// Insert an <img> for a freshly-imported image at `range` in the visual editor.
// The src is the vault-relative ref (hydrateImages swaps in the data URL); the
// stashed data-md-src is the portable path turndown re-emits on save. Returns a
// new range just after the image so successive drops keep their order.
function insertImageNode(range, ref, alt) {
  const img = document.createElement('img');
  img.setAttribute('src', ref);
  img.dataset.mdSrc = ref;
  img.alt = alt;
  range.insertNode(img);
  const after = document.createRange();
  after.setStartAfter(img);
  after.collapse(true);
  return after;
}

// ---- Claude image analysis ----
// Every imported image is sent to Claude to be described. The image is inserted
// straight away (alt = the file name) so the drop stays instant; when the analysis
// lands we swap in a real alt and append a collapsed description block, which is
// what makes the image's content findable in the note later.
let analyzing = 0; // in-flight analyses, so the status line can count them

// The description block as it lives in the Markdown source. Deliberately free of
// blank lines: one uninterrupted HTML block, so Markdown can't reopen inside it.
function describeBlock(description) {
  return `<details>\n<summary>${IMAGE_SUMMARY}</summary>\n${description}\n</details>`;
}

// Rewrite the alt text of the `![…](ref)` reference in `text` and insert the
// description block after the line holding it. Returns null if that reference is
// gone — the user is free to edit or delete it while Claude is still thinking.
function withImageAnalysis(text, ref, alt, description) {
  const tail = `](${ref})`;
  const at = text.indexOf(tail);
  if (at === -1) return null;
  const open = text.lastIndexOf('![', at);
  if (open === -1) return null;

  const head = text.slice(0, open) + `![${alt}](${ref})`;
  let rest = text.slice(at + tail.length);
  if (!description) return head + rest;

  // Split off the remainder of the image's own line; the block goes after it.
  const nl = rest.indexOf('\n');
  const cut = nl === -1 ? rest.length : nl + 1;
  const lineTail = rest.slice(0, cut);
  rest = rest.slice(cut);
  return (
    head +
    lineTail +
    (lineTail.endsWith('\n') ? '' : '\n') +
    '\n' +
    describeBlock(description) +
    '\n' +
    (rest === '' || rest.startsWith('\n') ? '' : '\n') +
    rest
  );
}

// Swap in a new buffer without yanking the user around: assigning to .value drops
// the caret to the end and resets the scroll, and an analysis can land while they
// are typing. The edit is a single insertion, so shifting any position past it by
// the length delta puts the caret back where it was.
function replaceBufferKeepingCaret(next) {
  const prev = editorEl.value;
  let at = 0;
  while (at < prev.length && at < next.length && prev[at] === next[at]) at++;
  const delta = next.length - prev.length;
  const shift = (p) => (p > at ? p + delta : p);
  const start = editorEl.selectionStart;
  const end = editorEl.selectionEnd;
  const scroll = editorEl.scrollTop;
  editorEl.value = next;
  editorEl.setSelectionRange(shift(start), shift(end));
  editorEl.scrollTop = scroll;
  syncHighlightBox(); // the find mirror tracks the textarea's size + scroll
}

// Same edit against the live WYSIWYG DOM (where the pane, not the buffer, holds
// the user's latest text). Returns false if the image is no longer in the pane.
function applyAnalysisToWysiwyg(ref, alt, description) {
  const img = Array.from(wysiwygEl.querySelectorAll('img')).find(
    (n) => (n.dataset.mdSrc || n.getAttribute('src')) === ref
  );
  if (!img) return false;
  img.alt = alt;
  if (description) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = IMAGE_SUMMARY;
    details.appendChild(summary);
    // insertAdjacentHTML, not textContent: the description arrives HTML-escaped
    // from main, and this keeps the entities matching the raw-source form so the
    // block round-trips through turndown unchanged.
    details.insertAdjacentHTML('beforeend', '\n' + description + '\n');
    const anchor = img.closest('p') || img;
    anchor.after(details);
  }
  return true;
}

// Ask Claude about each imported image and fold the results into the open note as
// they arrive. Bails out on anything that moved on in the meantime: a different
// file open, or the reference no longer in the buffer.
async function analyzeImported(imports, forFile) {
  await Promise.all(
    imports.map(async ({ ref, path: imagePath }) => {
      analyzing++;
      setStatus(analyzing > 1 ? `Analysing ${analyzing} images…` : 'Analysing image…');
      let res;
      try {
        res = await api.analyzeImage(baseFolder, imagePath);
      } finally {
        analyzing--;
      }
      if (currentFile !== forFile) return; // note closed — nothing left to update
      if (!res || !res.ok) {
        if (res && !res.skipped) setStatus('Image analysis failed: ' + res.error, true);
        return;
      }

      if (effectiveViewMode() === 'wysiwyg') {
        if (!applyAnalysisToWysiwyg(ref, res.alt, res.description)) return;
      } else {
        const next = withImageAnalysis(editorEl.value, ref, res.alt, res.description);
        if (next === null) return;
        replaceBufferKeepingCaret(next);
        if (effectiveViewMode() === 'preview') renderMarkdown();
      }
      markBufferEdited();
      scheduleFindRefresh(); // the buffer grew under the find bar's matches
    })
  );
}

async function handleDroppedFiles(fileList, dropRange) {
  if (!currentFile) {
    setStatus('Open a file before adding images.', true);
    return;
  }
  // An image is open, not a note — there's no buffer to insert a reference into.
  if (isImage(currentFile)) {
    setStatus('Open a note before adding images.', true);
    return;
  }
  const images = Array.from(fileList).filter(
    (f) => /^image\//.test(f.type) || IMAGE_RE.test(f.name)
  );
  if (!images.length) return;
  const forFile = currentFile; // the note these images belong to, pinned across the awaits

  // In the visual editor, insert <img> nodes at the drop caret (falling back to
  // the end); other modes edit the Markdown source buffer. effectiveViewMode, so a
  // remembered 'wysiwyg' can't route the insert into a pane that isn't live.
  const wys = effectiveViewMode() === 'wysiwyg';
  let range = wys ? dropRange || endOfWysiwygRange() : null;

  let added = 0;
  const imports = []; // { ref, path } per imported image, for Claude to describe
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
    if (wys) {
      range = insertImageNode(range, res.ref, alt);
    } else if (effectiveViewMode() === 'raw') {
      insertAtCursor(`![${alt}](${res.ref})\n`);
    } else {
      // Preview has no text cursor — append the ref to the source buffer.
      const sep = !editorEl.value || editorEl.value.endsWith('\n') ? '' : '\n';
      editorEl.value += sep + `![${alt}](${res.ref})` + '\n';
    }
    imports.push({ ref: res.ref, path: res.path });
    added++;
  }

  if (added) {
    dirty = true;
    setStatus('Saving…');
    scheduleSave();
    if (wys) {
      hydrateImages(wysiwygEl); // resolve the newly inserted <img>s to data URLs
      // Leave the caret after the last inserted image so typing continues there.
      if (range) {
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else if (viewMode === 'preview' && isMarkdown(currentFile)) {
      renderMarkdown();
    }
    await refreshTree(); // surface the new images/ folder + files
    // Descriptions land afterwards — the note is already usable without them.
    analyzeImported(imports, forFile).catch(() => {});
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
    // For the visual editor, resolve where the drop landed so images insert at
    // that point rather than at the end. (caretRangeFromPoint is Chromium/Electron.)
    let dropRange = null;
    if (el === wysiwygEl && document.caretRangeFromPoint) {
      dropRange = document.caretRangeFromPoint(e.clientX, e.clientY);
    }
    handleDroppedFiles(e.dataTransfer.files, dropRange);
  });
}
setupDrop(editorEl);
setupDrop(wysiwygEl);
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
// `opts.below` marks a panel that sits *under* its divider (the reminder list),
// so dragging up grows it instead of down.
function makeRowDivider(divider, panel, storageKey, minPx, opts = {}) {
  const paneEl = opts.container || document.querySelector('.editor-pane');
  const RESERVE = opts.reserve ?? 140;
  const dir = opts.below ? -1 : 1;
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
    panel.style.height = clamp(startH + dir * (e.clientY - startY)) + 'px';
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
makeRowDivider(
  document.getElementById('divider-reminders'),
  document.getElementById('reminders'),
  'rawNotes.remindersHeight',
  92,
  { container: document.getElementById('sidebar'), reserve: 120, below: true }
);

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 's') {
    e.preventDefault();
    flushSave();
    return;
  }

  // A modal or reminder popup owns the keyboard while it's up (they handle their
  // own Escape / Enter on the capture phase).
  if (document.querySelector('.modal-overlay, .alert-overlay')) return;

  const key = e.key.toLowerCase();
  // ⌘⌥F opens replace on macOS, where ⌘H is taken by Hide; Ctrl+H is the
  // Windows/Linux equivalent.
  if (mod && key === 'f' && !e.shiftKey) {
    e.preventDefault();
    openFind(e.altKey);
  } else if (mod && key === 'h' && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    openFind(true);
  } else if ((mod && key === 'g') || e.key === 'F3') {
    e.preventDefault();
    if (findOpen) findStep(e.shiftKey ? -1 : 1);
    else openFind(false);
  } else if (e.key === 'Escape' && findOpen) {
    e.preventDefault();
    closeFind();
  }
});

// On close, flush synchronously so a pending edit can't be lost to the window
// going away before an async write finishes.
window.addEventListener('beforeunload', () => {
  cancelPendingSave();
  if (currentFile && dirty) {
    syncWysiwygToEditor();
    const res = api.writeFileSync(currentFile, editorEl.value);
    if (res && res.ok) dirty = false;
  }
});
})();
