// Opening, autosaving and typing into the buffer — including Tab, which both
// editing panes take over from the browser's focus navigation.

import { api } from './api.js';
import { currentFileEl, editorEl, wysiwygEl } from './dom.js';
import { scheduleFindRefresh } from './find.js';
import { scheduleGitRefresh } from './git.js';
import { restorePosition } from './positions.js';
import { AUTOSAVE_MS, state } from './state.js';
import { relativePath, setStatus } from './util.js';
import { applyView, isImage, isMarkdown, showImageView, syncWysiwygToEditor } from './views.js';

/** @type {ReturnType<typeof setTimeout> | null} */
let saveTimer = null; // pending debounced autosave
export async function openFile(filePath, rowEl) {
  // Autosave means there's nothing to discard — just flush the current file first.
  await flushSave();

  // An image is fetched as a data URL and shown; only text files reach the editor.
  const image = isImage(filePath);
  const res = image
    ? await api.readImageFile(state.baseFolder, filePath)
    : await api.readFile(state.baseFolder, filePath);
  if (!res.ok) {
    setStatus('Error: ' + res.error, true);
    return;
  }
  state.currentFile = filePath;
  state.diffOnlyFile = null; // a real file is open again
  state.dirty = false;
  if (image) {
    // Keep the buffer empty and disabled: there is no text behind an image, so
    // nothing can be typed — and no autosave can overwrite the file with text.
    editorEl.value = '';
    editorEl.disabled = true;
    showImageView(filePath, res);
  } else if ('content' in res) {
    // `in` rather than the `image` flag: the two branches read different
    // channels, and this is what tells the checker which result it has.
    editorEl.value = res.content;
    editorEl.disabled = false;
  }
  currentFileEl.textContent = relativePath(filePath);
  setStatus(image ? 'Read-only' : 'Saved');
  applyView();
  if (image) {
    /* nothing to focus — the viewer takes no input */
  } else if (state.viewMode === 'raw' || !isMarkdown(filePath)) editorEl.focus();
  else if (state.viewMode === 'wysiwyg') wysiwygEl.focus();
  // Last, because focusing a pane scrolls its caret into view: the file reopens
  // where it was left, not wherever the browser decided to put the cursor.
  restorePosition();

  document.querySelectorAll('.node-row.active').forEach((el) => el.classList.remove('active'));
  if (rowEl) rowEl.classList.add('active');
}

async function saveCurrent() {
  if (!state.currentFile || !state.dirty) return;
  // In WYSIWYG mode the live edits are in the contenteditable pane, not the
  // textarea — fold them back into the buffer before persisting.
  syncWysiwygToEditor();
  // Capture the file being saved: it may change if this runs after a switch.
  const target = state.currentFile;
  const res = await api.writeFile(state.baseFolder, target, editorEl.value);
  if (res.ok) {
    if (state.currentFile === target) state.dirty = false;
    setStatus('Saved');
    // The tree isn't rebuilt on save, but the file's git status just changed.
    scheduleGitRefresh();
  } else {
    setStatus('Error: ' + res.error, true);
  }
}

// Debounce a save so a burst of keystrokes results in one write shortly after.
export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCurrent();
  }, AUTOSAVE_MS);
}

// Cancel any pending autosave without writing (e.g. the file is being deleted).
export function cancelPendingSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

// Write any pending change to disk now and wait for it to complete.
export async function flushSave() {
  cancelPendingSave();
  await saveCurrent();
}

// Mark the open file as changed and start the autosave clock.
export function markBufferEdited() {
  state.dirty = true;
  setStatus('Saving…');
  scheduleSave();
}

editorEl.addEventListener('input', () => {
  if (!state.currentFile) return;
  markBufferEdited();
  scheduleFindRefresh(); // typing moves the matches the find bar is pointing at
});

// WYSIWYG edits mark the buffer dirty too; scheduleSave → saveCurrent folds the
// contenteditable HTML back to Markdown at write time via syncWysiwygToEditor.
wysiwygEl.addEventListener('input', () => {
  if (!state.currentFile || state.viewMode !== 'wysiwyg') return;
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

// ---- Tab in the editor ----
// Tab is a character (or an indent), never focus navigation: the editor panes are
// where the user types, so moving focus out of them is never what Tab means here.
const INDENT_UNIT = '\t';

// Widen [start,end) to whole lines so a block indent can't leave half a line behind.
function lineSpan(value, start, end) {
  const from = value.lastIndexOf('\n', start - 1) + 1;
  let to = value.indexOf('\n', end);
  if (to === -1) to = value.length;
  return [from, to];
}

// Indent (or, with shift, outdent) every line the selection touches. Returns the
// rewritten block plus how much the first line and the whole block moved, which is
// what the caller needs to put the selection back where the user left it.
function reindentBlock(block, outdent) {
  let firstDelta = 0;
  let totalDelta = 0;
  const lines = block.split('\n').map((line, i) => {
    let delta = 0;
    let out = line;
    if (outdent) {
      const lead = /^(\t| {1,4})/.exec(line);
      if (lead) {
        out = line.slice(lead[0].length);
        delta = -lead[0].length;
      }
    } else if (line !== '') {
      // Skip blank lines — indenting them would only leave trailing whitespace.
      out = INDENT_UNIT + line;
      delta = INDENT_UNIT.length;
    }
    if (i === 0) firstDelta = delta;
    totalDelta += delta;
    return out;
  });
  return { text: lines.join('\n'), firstDelta, totalDelta };
}

editorEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();

  const value = editorEl.value;
  const start = editorEl.selectionStart ?? 0;
  const end = editorEl.selectionEnd ?? start;

  // A plain Tab with no multi-line selection just types a tab.
  if (!e.shiftKey && !value.slice(start, end).includes('\n')) {
    // execCommand keeps the textarea's native undo stack (and fires `input`, so
    // the autosave clock starts) where assigning .value would throw both away.
    document.execCommand('insertText', false, INDENT_UNIT);
    return;
  }

  const [from, to] = lineSpan(value, start, end);
  const { text, firstDelta, totalDelta } = reindentBlock(value.slice(from, to), e.shiftKey);
  if (!totalDelta && !firstDelta) return; // nothing left to outdent

  editorEl.setSelectionRange(from, to);
  document.execCommand('insertText', false, text);
  // A selection that began at the line start keeps covering the whole line.
  const newStart = start === from ? from : Math.max(from, start + firstDelta);
  editorEl.setSelectionRange(newStart, Math.max(newStart, end + totalDelta));
});

// The list item the caret sits in, if any — Tab nests list items in the WYSIWYG
// editor, which is what Tab means in a rendered document.
function caretListItem() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  /** @type {Node | Element | null} */
  let node = sel.getRangeAt(0).startContainer;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const el = /** @type {Element | null} */ (node);
  const li = el && el.closest ? el.closest('li') : null;
  return li && wysiwygEl.contains(li) ? li : null;
}

wysiwygEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  if (caretListItem()) {
    document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    // indent/outdent are formatting commands; mark the buffer ourselves rather
    // than relying on them to look like input.
    if (state.currentFile && state.viewMode === 'wysiwyg') markBufferEdited();
  } else if (!e.shiftKey) {
    document.execCommand('insertText', false, INDENT_UNIT);
  }
});
