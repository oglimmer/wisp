// Importing dropped images into the vault, and Claude's description of each.

import { api } from './api.js';
import { editorEl, renderedEl, wysiwygEl } from './dom.js';
import { markBufferEdited, scheduleSave } from './editor.js';
import { scheduleFindRefresh, syncHighlightBox } from './find.js';
import { IMAGE_SUMMARY, state } from './state.js';
import { refreshTree } from './tree.js';
import { setStatus } from './util.js';
import { effectiveViewMode, hydrateImages, isImage, isMarkdown, renderMarkdown } from './views.js';

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
        res = await api.analyzeImage(state.baseFolder, imagePath);
      } finally {
        analyzing--;
      }
      if (state.currentFile !== forFile) return; // note closed — nothing left to update
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
  if (!state.currentFile) {
    setStatus('Open a file before adding images.', true);
    return;
  }
  // An image is open, not a note — there's no buffer to insert a reference into.
  if (isImage(state.currentFile)) {
    setStatus('Open a note before adding images.', true);
    return;
  }
  const images = Array.from(fileList).filter(
    (f) => /^image\//.test(f.type) || isImage(f.name)
  );
  if (!images.length) return;
  const forFile = state.currentFile; // the note these images belong to, pinned across the awaits

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
    const res = await api.importImage(state.baseFolder, state.currentFile, srcPath, file.name);
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
    state.dirty = true;
    setStatus('Saving…');
    scheduleSave();
    if (wys) {
      hydrateImages(wysiwygEl); // resolve the newly inserted <img>s to data URLs
      // Leave the caret after the last inserted image so typing continues there.
      const sel = range && window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else if (state.viewMode === 'preview' && isMarkdown(state.currentFile)) {
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
    /** @type {Range | null} */
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
