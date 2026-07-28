// Per-file caret and scroll positions.
//
// Reopening a note should put you back where you left it, so each file's position
// is remembered per vault: the caret (and selection) in the Raw textarea, plus a
// scroll offset for each of the three panes separately — they lay the same file
// out differently, so one shared offset would land somewhere else in each.
//
// Capture is continuous, off the panes' own scroll/selection events, rather than
// only at the moment a file closes. That is what lets `applyView()` restore too:
// switching modes re-renders the preview and WYSIWYG panes from scratch (and a
// hidden pane loses its scroll anyway), so every view switch would otherwise
// bounce the reader back to the top of the file.

import { editorEl, renderedEl, wysiwygEl } from './dom.js';
import { state } from './state.js';
import { relativePath } from './util.js';
import { effectiveViewMode } from './views.js';

// Positions are a convenience, not the user's data — cap the store rather than
// letting a long-lived vault accumulate an entry per file forever. Insertion
// order is the LRU order, so the oldest entry is the first one.
const MAX_FILES = 200;
const SAVE_MS = 500;

let positions = new Map(); // relative path -> { raw?, wysiwyg?, preview? }
/** @type {string | null} */
let storageKey = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let saveTimer = null;

// The image and diff panes are read-only views of something that isn't the
// buffer, and diff isn't even a mode the app reopens into — neither has a
// position worth keeping.
function paneEl(mode) {
  if (mode === 'raw') return editorEl;
  if (mode === 'wysiwyg') return wysiwygEl;
  if (mode === 'preview') return renderedEl;
  return null;
}

// Positions are keyed by vault so switching folders doesn't mix two vaults'
// files (paths are stored relative for the same reason — moving a vault keeps
// them pointing at the right notes).
export function loadPositions(folder) {
  flushPositions(); // don't carry a pending write over to the new key
  positions = new Map();
  storageKey = folder ? 'rawNotes.positions:' + folder : null;
  if (!storageKey) return;
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    if (!Array.isArray(saved)) return;
    for (const entry of saved) {
      if (!Array.isArray(entry)) continue;
      const [path, pos] = entry;
      if (typeof path === 'string' && pos && typeof pos === 'object') positions.set(path, pos);
    }
  } catch {
    // A corrupt entry costs nothing to throw away — start the vault fresh.
    positions = new Map();
  }
}

function schedulePersist() {
  if (!storageKey || saveTimer) return;
  saveTimer = setTimeout(flushPositions, SAVE_MS);
}

// Write the store out now. Called on close (and before the key changes) so the
// last few seconds of reading aren't lost to the debounce.
export function flushPositions() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify([...positions]));
  } catch {
    // Out of quota, private mode, … — positions are disposable, never a failure
    // the user needs to hear about.
  }
}

// Fetch this file's entry, moving it to the end: the Map's order is the LRU one.
function touch(key) {
  const pos = positions.get(key) || {};
  positions.delete(key);
  positions.set(key, pos);
  while (positions.size > MAX_FILES) positions.delete(positions.keys().next().value);
  return pos;
}

// The file whose position the panes are currently showing, or null if there is
// nothing to remember (no vault, no file, or a deleted file shown as a diff).
function positionKey() {
  if (!state.baseFolder || !state.currentFile || state.diffOnlyFile) return null;
  return relativePath(state.currentFile);
}

export function capturePosition() {
  const key = positionKey();
  if (!key) return;
  const mode = effectiveViewMode();
  const el = paneEl(mode);
  if (!el) return;
  const pos = touch(key);
  pos[mode] =
    mode === 'raw'
      ? { top: el.scrollTop, start: editorEl.selectionStart ?? 0, end: editorEl.selectionEnd ?? 0 }
      : { top: el.scrollTop };
  schedulePersist();
}

// A pane full of images lays out short until they decode (hydrateImages resolves
// each one through main), so a restore into one clamps and lands high. Remember
// what was asked for and re-apply it as the pictures arrive.
/** @type {{ el: Element, top: number, applied: number } | null} */
let pending = null;

function applyScroll(el, top) {
  el.scrollTop = top;
  pending = el.scrollTop < top ? { el, top, applied: el.scrollTop } : null;
}

export function restorePosition() {
  pending = null;
  const key = positionKey();
  if (!key) return;
  const mode = effectiveViewMode();
  const el = paneEl(mode);
  if (!el) return;
  // A file with no remembered position opens at the top — which has to be applied
  // rather than left alone: assigning `editorEl.value` parks Chromium's caret at
  // the *end* of the text, and the focus() that follows scrolls it into view, so
  // "do nothing" means opening at the bottom of the file.
  const saved = positions.get(key)?.[mode] || {};
  // The file may have been edited elsewhere since — clamp rather than trusting a
  // stored offset to still be inside it. (scrollTop the browser clamps itself.)
  if (mode === 'raw') {
    const max = editorEl.value.length;
    const start = Math.min(Math.max(saved.start ?? 0, 0), max);
    const end = Math.min(Math.max(saved.end ?? start, start), max);
    // Selection first: setting it scrolls the caret into view, so the stored
    // scroll offset has to be applied after it to win when the user had scrolled
    // away from the caret.
    editorEl.setSelectionRange(start, end);
  }
  applyScroll(el, saved.top ?? 0);
}

// Reading is scrolling and moving the caret, so that is where the position comes
// from. Both handlers are cheap (a couple of property reads into a Map); only the
// localStorage write is throttled.
for (const el of [editorEl, wysiwygEl, renderedEl]) {
  el.addEventListener(
    'scroll',
    () => {
      // A scroll that isn't the one our own restore just made is the user going
      // somewhere else: stop trying to put them back.
      if (pending && pending.el === el && el.scrollTop !== pending.applied) pending = null;
      capturePosition();
    },
    { passive: true },
  );
  // Capture phase: an <img> load event doesn't bubble.
  el.addEventListener(
    'load',
    () => {
      if (pending && pending.el === el) applyScroll(el, pending.top);
    },
    true,
  );
}
document.addEventListener('selectionchange', () => {
  if (document.activeElement === editorEl) capturePosition();
});
