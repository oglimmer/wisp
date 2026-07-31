// The editor pane's views: Raw (the canonical buffer), Editor (WYSIWYG), Preview,
// and the read-only image viewer. applyView() shows exactly one.

import { api } from './api.js';
import { closeDiffOnly, renderDiffPane } from './diff.js';
import { diffModeToggleEl, diffRawBtn, diffViewEl, diffVisualBtn, editorEl, imageViewEl, imageViewImgEl, imageViewMetaEl, renderedEl, viewDiffBtn, viewMdBtn, viewRawBtn, viewToggleEl, viewWysBtn, wysiwygEl } from './dom.js';
import { flushSave } from './editor.js';
import { refreshFind } from './find.js';
import { gitState } from './git.js';
import { foldToMarkdown, frontmatterNode, safeMarkdownHtml, splitFrontmatter } from './markdown.js';
import { restorePosition, syncAnchor } from './positions.js';
import { STORED_VIEW_MODES, VIEW_MODES, state } from './state.js';

export function isMarkdown(filePath) {
  return /\.(md|markdown|mdown|mkd)$/i.test(filePath || '');
}

// The image extensions the app knows about — what drag & drop imports, and what
// opens in the viewer pane instead of the text editor. (Kept in step with
// IMAGE_MIME in main/images.mjs, which decides what can actually be read.)
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;

// Image files aren't text: opening one shows the picture, not its bytes.
export function isImage(filePath) {
  return IMAGE_RE.test(filePath || '');
}

// Project the buffer into one of the two display panes. Frontmatter is shown
// verbatim rather than rendered — marked reads a leading `---` block as a rule
// plus a heading, and the fold re-attaches the buffer's copy.
function renderPane(paneEl, source) {
  const { fm, body } = splitFrontmatter(source || '');
  const html = safeMarkdownHtml(body);
  if (html !== null) {
    paneEl.innerHTML = html;
  } else {
    // marked or DOMPurify failed to load — fall back to showing the source as-is.
    paneEl.textContent = body;
  }
  if (fm) paneEl.prepend(frontmatterNode(fm));
  hydrateImages(paneEl);
}

// Render the current editor buffer as Markdown into the preview pane.
export function renderMarkdown() {
  renderPane(renderedEl, editorEl.value);
}

// Render the current editor buffer as editable formatted HTML in the WYSIWYG pane.
function renderWysiwyg() {
  renderPane(wysiwygEl, editorEl.value);
}

// Convert the WYSIWYG pane's current HTML back to Markdown and write it into the
// editor buffer (the single source of truth that gets saved). No-op unless we're
// actually in WYSIWYG mode with a file open.
export function syncWysiwygToEditor() {
  if (state.viewMode !== 'wysiwyg' || !state.currentFile) return;
  // Only fold back when there are real WYSIWYG edits (every edit sets `dirty`).
  // Skipping when clean keeps an unedited buffer byte-for-byte as loaded, so the
  // fold is never even asked about a file the user only viewed.
  if (!state.dirty) return;
  // Block-by-block against the buffer it came from, so an untouched block keeps
  // its own source rather than turndown's rendering of it (see markdown.js).
  const folded = foldToMarkdown(editorEl.value, wysiwygEl);
  // Usually identical for an edit inside one block: leave the textarea (and its
  // native undo stack and caret) alone rather than reassigning the same text.
  if (folded !== editorEl.value) editorEl.value = folded;
}

// marked emits <img src="images/foo.png"> with vault-relative paths, but the app's
// app:// origin + CSP won't load those directly. For each local image, ask the
// main process to resolve it (relative to the open file) and inline it as a data
// URL. Remote (http/data) sources are left alone. Captures the file the render was
// for so a stale async result from a previous file can't paint over a new one.
export function hydrateImages(container) {
  const forFile = state.currentFile;
  container.querySelectorAll('img').forEach(async (img) => {
    const raw = img.getAttribute('src') || '';
    if (!raw || /^(https?:|data:)/i.test(raw)) return;
    // Stash the original vault-relative path before we swap in the data: URL, so
    // WYSIWYG edits can round-trip back to the portable Markdown reference.
    if (!img.dataset.mdSrc) img.dataset.mdSrc = raw;
    const res = await api.readImage(state.baseFolder, forFile, raw);
    if (state.currentFile !== forFile) return; // file switched while we were loading
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
export function effectiveViewMode() {
  // A deleted file has nothing left on disk to show in any other pane.
  if (state.diffOnlyFile) return 'diff';
  // An image file has no text to edit at all — it always shows in the viewer.
  if (state.currentFile && isImage(state.currentFile)) return 'image';
  // Diff applies to any text file, not just Markdown — but only inside a repo.
  if (state.viewMode === 'diff') return canDiffCurrent() ? 'diff' : 'raw';
  const md = !!state.currentFile && isMarkdown(state.currentFile);
  let mode = md ? state.viewMode : 'raw';
  if (mode === 'wysiwyg' && !window.TurndownService) mode = 'raw';
  return mode;
}

// Whether the Diff view has anything to say about the open file: a repository, a
// file, and a file that isn't a picture (a binary diff is nothing to look at).
function canDiffCurrent() {
  return !!gitState && !!state.currentFile && !isImage(state.currentFile);
}

// The element holding the text the live pane shows — what search operates on.
export function activePaneEl() {
  const mode = effectiveViewMode();
  if (mode === 'wysiwyg') return wysiwygEl;
  if (mode === 'preview') return renderedEl;
  if (mode === 'image') return imageViewEl;
  if (mode === 'diff') return diffViewEl;
  return editorEl;
}

// Show the right pane for the current file + mode. The toggle is only offered for
// Markdown files; everything else is always edited raw.
export function applyView() {
  const mode = effectiveViewMode();
  const showRaw = mode === 'raw';
  const showWys = mode === 'wysiwyg';
  const showPreview = mode === 'preview';
  const showImage = mode === 'image';
  const showDiff = mode === 'diff';

  // The three editing views belong to Markdown files; Diff belongs to any text
  // file in a repository. They share one toggle, so each button is shown on its
  // own terms and the group hides only when nothing is left in it.
  const md = !showImage && !!state.currentFile && isMarkdown(state.currentFile) && !state.diffOnlyFile;
  const canDiff = canDiffCurrent() || !!state.diffOnlyFile;
  viewRawBtn.classList.toggle('hidden', !md);
  viewWysBtn.classList.toggle('hidden', !md);
  viewMdBtn.classList.toggle('hidden', !md);
  viewDiffBtn.classList.toggle('hidden', !canDiff);
  viewToggleEl.classList.toggle('hidden', !md && !canDiff);
  diffModeToggleEl.classList.toggle('hidden', !showDiff);

  if (showWys) renderWysiwyg();
  if (showPreview) renderMarkdown();
  if (showDiff) renderDiffPane();
  // The picture itself is loaded by openFile; dropping it when the pane goes away
  // keeps a big data URL from sitting in memory behind the next file.
  if (!showImage) clearImageView();
  // Likewise a diff can be large; don't leave one behind an editing pane.
  if (!showDiff) diffViewEl.replaceChildren();

  editorEl.classList.toggle('hidden', !showRaw);
  wysiwygEl.classList.toggle('hidden', !showWys);
  renderedEl.classList.toggle('hidden', !showPreview);
  imageViewEl.classList.toggle('hidden', !showImage);
  diffViewEl.classList.toggle('hidden', !showDiff);

  viewRawBtn.classList.toggle('active', showRaw);
  viewWysBtn.classList.toggle('active', showWys);
  viewMdBtn.classList.toggle('active', showPreview);
  viewDiffBtn.classList.toggle('active', showDiff);
  diffVisualBtn.classList.toggle('active', state.diffMode === 'visual');
  diffRawBtn.classList.toggle('active', state.diffMode === 'raw');

  // The pane that just became visible was re-rendered (or lost its scroll while
  // hidden), so put the reader back where they were in it — before refreshFind,
  // which scrolls to a match when the find bar is open and that should win.
  restorePosition();

  // A re-render throws away the nodes any search highlight pointed at, and a mode
  // switch changes which pane (and which text) is being searched.
  refreshFind();
}

export function setViewMode(mode) {
  if (!VIEW_MODES.includes(mode)) mode = 'raw';
  if (mode === 'wysiwyg' && !window.TurndownService) mode = 'raw';
  // Leaving WYSIWYG: fold its edits back into the buffer before we switch panes,
  // otherwise raw/preview would show the pre-edit source.
  if (state.viewMode === 'wysiwyg' && mode !== 'wysiwyg') syncWysiwygToEditor();
  // Leaving the diff of a deleted file: there is no file to fall back to, so drop
  // the diff-only state and the editor goes empty rather than showing a ghost.
  if (mode !== 'diff' && state.diffOnlyFile) closeDiffOnly();
  // Read the place the reader is at off the pane that is about to be swapped out,
  // while it is still on screen and measurable — that is what the next pane is put
  // back at. After the fold, so the lines it is expressed in are the buffer's.
  syncAnchor();
  state.viewMode = mode;
  // Diff is deliberately not remembered across sessions (see VIEW_MODES).
  if (STORED_VIEW_MODES.includes(state.viewMode)) localStorage.setItem('rawNotes.viewMode', state.viewMode);
  // The diff reads what's on disk, so land any pending edit before it's drawn.
  if (state.viewMode === 'diff') flushSave();
  applyView();
  if (!state.currentFile) return;
  // Only the two editing panes take the keyboard; Preview and Diff are read-only.
  const focusEl = state.viewMode === 'raw' ? editorEl : state.viewMode === 'wysiwyg' ? wysiwygEl : null;
  if (!focusEl) return;
  focusEl.focus();
  // Then the position once more: focusing a pane scrolls its caret into view, which
  // would otherwise undo the restore applyView just did (the same reason openFile
  // restores last).
  restorePosition();
}

// Switch between the side-by-side and unified-patch renderings of the same diff.
export function setDiffMode(mode) {
  if (state.diffMode === mode) return;
  syncAnchor(); // the rendering about to be replaced is the one that can be read
  state.diffMode = mode;
  localStorage.setItem('rawNotes.diffMode', mode);
  applyView();
}

// ---- Image view ----
// Images are read as a data URL by main (same reason as the preview: the app's
// app:// origin + CSP won't load vault paths directly) and shown read-only.

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

export function showImageView(filePath, res) {
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
