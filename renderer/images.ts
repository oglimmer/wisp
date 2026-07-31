// Importing images into the vault — dropped or pasted — and Claude's description
// of each.

import { api } from './api.js';
import { editorEl, renderedEl, wysiwygEl } from './dom.js';
import { markBufferEdited, scheduleSave } from './editor.js';
import { scheduleFindRefresh, syncHighlightBox } from './find.js';
import { IMAGE_SUMMARY, state } from './state.js';
import { refreshTree } from './tree.js';
import { setStatus } from './util.js';
import { effectiveViewMode, hydrateImages, isImage, isMarkdown, renderMarkdown } from './views.js';

// Dropping (or pasting) image files copies them into the vault's images/ folder
// and inserts a Markdown reference. In raw view the ref lands at the cursor; in
// preview view (where there's no cursor) it's appended to the end of the buffer.

// One image that made it into the vault: the ref written into the note, and the
// absolute path Claude is pointed at to describe it.
interface ImportedImage {
  ref: string;
  path: string;
}

function insertAtCursor(text: string) {
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
function insertImageNode(range: Range, ref: string, alt: string) {
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
function describeBlock(description: string) {
  return `<details>\n<summary>${IMAGE_SUMMARY}</summary>\n${description}\n</details>`;
}

// Rewrite the alt text of the `![…](ref)` reference in `text` and insert the
// description block after the line holding it. Returns null if that reference is
// gone — the user is free to edit or delete it while Claude is still thinking.
function withImageAnalysis(text: string, ref: string, alt: string, description: string) {
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
function replaceBufferKeepingCaret(next: string) {
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
function applyAnalysisToWysiwyg(ref: string, alt: string, description: string) {
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
async function analyzeImported(imports: ImportedImage[], forFile: string | null) {
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

// Whether there is somewhere to put an image at all. A dropped or pasted picture
// needs a note to reference it from: with no file open there is no buffer, and
// with an *image* open there is no text behind it to hold a reference.
function noteIsOpen() {
  if (!state.currentFile) {
    setStatus('Open a file before adding images.', true);
    return false;
  }
  if (isImage(state.currentFile)) {
    setStatus('Open a note before adding images.', true);
    return false;
  }
  return true;
}

// A file straight off the OS, by whichever route it arrived. A dropped file always
// has a path behind it; one that came in on the clipboard (a screenshot, "Copy
// Image") is only bytes, so it goes to main as a data URL instead.
function fileDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => resolve('');
    reader.readAsDataURL(file);
  });
}

async function importFile(file: File) {
  let srcPath = '';
  try {
    srcPath = api.getPathForFile(file);
  } catch {}
  if (srcPath) {
    return api.importImage(state.baseFolder, state.currentFile, srcPath, file.name);
  }
  const dataUrl = await fileDataUrl(file);
  // Annotated so this answers with the same envelope the two channels do — the
  // caller narrows on `ok` and would otherwise see a widened `boolean`.
  if (!dataUrl) {
    return ({
      ok: false,
      error: 'Could not read the image.',
    } as import('../types/ipc').Fail);
  }
  // No name: the clipboard's own ("image.png", when it gives one at all) says
  // nothing, so main names it after the moment it was pasted.
  return api.importImageData(state.baseFolder, state.currentFile, dataUrl);
}

// What every import ends with, however the images arrived: the buffer is dirty,
// the tree has a new images/ folder in it, and Claude is asked to describe what
// just landed. Descriptions fold in afterwards — the note is usable without them.
async function afterImport(imports: ImportedImage[], forFile: string | null) {
  state.dirty = true;
  setStatus('Saving…');
  scheduleSave();
  await refreshTree(); // surface the new images/ folder + files
  analyzeImported(imports, forFile).catch(() => {});
}

// Import image files and reference them from the open note. `range` is where to
// put them in the visual editor (a drop point, or the caret on paste).
async function insertImageFiles(fileList: FileList | File[], range: Range | null) {
  if (!noteIsOpen()) return;
  const images = Array.from(fileList).filter(
    (f) => /^image\//.test(f.type) || isImage(f.name)
  );
  if (!images.length) return;
  const forFile = state.currentFile; // the note these images belong to, pinned across the awaits

  // In the visual editor, insert <img> nodes at that point (falling back to the
  // end); other modes edit the Markdown source buffer. effectiveViewMode, so a
  // remembered 'wysiwyg' can't route the insert into a pane that isn't live.
  const wys = effectiveViewMode() === 'wysiwyg';
  let at = wys ? range || endOfWysiwygRange() : null;

  let added = 0;
  const imports: ImportedImage[] = [];
  for (const file of images) {
    const res = await importFile(file);
    if (!res.ok) {
      setStatus('Error: ' + res.error, true);
      continue;
    }
    const alt = file.name.replace(/\.[^.]+$/, '');
    if (wys && at) {
      at = insertImageNode(at, res.ref, alt);
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

  if (!added) return;
  if (wys) {
    hydrateImages(wysiwygEl); // resolve the newly inserted <img>s to data URLs
    // Leave the caret after the last inserted image so typing continues there.
    const sel = at && window.getSelection();
    if (sel && at) {
      sel.removeAllRanges();
      sel.addRange(at);
    }
  } else if (state.viewMode === 'preview' && isMarkdown(state.currentFile)) {
    renderMarkdown();
  }
  await afterImport(imports, forFile);
}

function setupDrop(el: HTMLElement) {
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
    let dropRange: Range | null = null;
    if (el === wysiwygEl && document.caretRangeFromPoint) {
      dropRange = document.caretRangeFromPoint(e.clientX, e.clientY);
    }
    insertImageFiles(e.dataTransfer.files, dropRange);
  });
}
setupDrop(editorEl);
setupDrop(wysiwygEl);
setupDrop(renderedEl);

// ---- Paste ----
// An image reaches the clipboard three ways, and all three end up as a file in
// images/ with an ordinary reference to it:
//
//   * bytes — a screenshot, or "Copy Image" from a browser: a File with no path;
//   * Markdown text holding `![](data:image/png;base64,…)`, which is what several
//     other note apps put on the clipboard;
//   * HTML holding `<img src="data:…">`, pasted into the visual editor.
//
// The last two would otherwise be pasted verbatim, and a base64 image inlined in
// the note is a megabyte on a single line: it bloats every save, shows up as one
// unreadable line in the diff, and turndown carries it through every WYSIWYG fold.

// Terminates on whitespace and on the delimiters that end a URL in either
// context — `)` closes a Markdown ref, a quote closes an HTML attribute.
const DATA_URL_RE = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+=-]+)*,[^\s"'()<>[\]]+/gi;

// Import each distinct data: URL and return url → { ref, path } for the ones that
// landed. A URL that main refuses (unknown type, too large, malformed) is simply
// absent from the map, and the caller leaves that image out rather than writing
// the base64 into the note.
async function importDataUrls(urls: string[]) {
  const imported = new Map<string, ImportedImage>();
  for (const url of urls) {
    if (imported.has(url)) continue;
    const res = await api.importImageData(state.baseFolder, state.currentFile, url);
    if (res.ok) imported.set(url, { ref: res.ref, path: res.path });
    else setStatus('Error: ' + res.error, true);
  }
  return imported;
}

// Pasted text with images inlined in it: import each and hand back the same text
// with the data URLs replaced by references. Null when there was nothing to do,
// which is the signal to let the browser paste it as it always has.
async function importTextImages(text: string) {
  const urls = text.match(DATA_URL_RE);
  if (!urls) return null;
  const imported = await importDataUrls(urls);
  if (!imported.size) return null;
  return {
    text: text.replace(DATA_URL_RE, (url) => imported.get(url)?.ref ?? url),
    imports: [...imported.values()],
  };
}

// The same for pasted HTML, read as a document rather than scanned as text: the
// images are imported and the fragment is sanitized before it is inserted, exactly
// as rendered Markdown is. An image that failed to import is dropped — its data
// URL is the one thing that must not reach the note.
//
// What is rewritten is `data-md-src`, not `src`: the pane holds hydrated pictures
// (see hydrateImages), and the data URL the paste arrived with is already exactly
// that. Putting the reference in `src` instead would send Chromium to fetch a path
// the app:// scheme has nothing at, and the image would blink out until the
// resolved copy came back.
async function importHtmlImages(html: string) {
  if (!window.DOMPurify) return null; // no sanitizer — fall back to the text route
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const imgs = [...doc.querySelectorAll('img')].filter((img) =>
    /^data:image\//i.test(img.getAttribute('src') || '')
  );
  if (!imgs.length) return null;
  const imported = await importDataUrls(imgs.map((img) => img.getAttribute('src') || ''));
  if (!imported.size) return null;
  for (const img of imgs) {
    const hit = imported.get(img.getAttribute('src') || '');
    if (!hit) {
      img.remove();
      continue;
    }
    // The portable path turndown re-emits on save; the src stays the data URL the
    // paste came with, which is what the pane shows anyway.
    img.setAttribute('data-md-src', hit.ref);
  }
  return {
    html: window.DOMPurify.sanitize(doc.body.innerHTML, { USE_PROFILES: { html: true } }),
    imports: [...imported.values()],
  };
}

// The caret, as a range inside `el` — where a paste goes in the visual editor.
function selectionRangeIn(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return null;
  range.deleteContents(); // a paste replaces the selection
  return range;
}

function setupPaste(el: HTMLElement) {
  el.addEventListener('paste', (e) => {
    const cd = e.clipboardData;
    if (!cd || !state.currentFile) return;
    const wys = el === wysiwygEl;
    const files = Array.from(cd.files || []).filter(
      (f) => /^image\//.test(f.type) || isImage(f.name)
    );
    // Everything below has to be read off the clipboard synchronously — the event
    // (and its data) is gone by the first await.
    const html = wys ? cd.getData('text/html') : '';
    const text = cd.getData('text/plain');

    // Bytes win: copying an image in a browser also puts an <img> on the clipboard
    // pointing back at the original URL, and the file is the thing we can import.
    if (files.length) {
      if (!noteIsOpen()) return;
      e.preventDefault();
      insertImageFiles(files, wys ? selectionRangeIn(wysiwygEl) : null);
      return;
    }

    const inHtml = /data:image\//i.test(html);
    if (!inHtml && !/data:image\//i.test(text)) return; // an ordinary paste
    if (!noteIsOpen()) return;
    e.preventDefault();
    pasteInlineImages(el, inHtml ? html : '', text).catch(() => {});
  });
}

// Import the images inlined in a paste, then insert what is left. The importing
// is asynchronous, so the pane is focused again before the insert: execCommand
// edits whatever has focus, and losing the paste is worse than pasting it late.
async function pasteInlineImages(pane: HTMLElement, html: string, text: string) {
  const forFile = state.currentFile;
  const done = html ? await importHtmlImages(html) : await importTextImages(text);
  if (state.currentFile !== forFile) return; // the note closed while we were writing
  pane.focus();
  if (!done) {
    // Nothing imported — paste the clipboard's own text rather than swallowing it.
    // Not the HTML: it still holds the images, which is what we were avoiding.
    document.execCommand('insertText', false, text);
    return;
  }
  if ('html' in done) {
    document.execCommand('insertHTML', false, done.html);
    // The imported pictures are already showing (their src is the data URL the
    // paste carried); this is for any *other* relative image in the fragment —
    // a paragraph copied from another note, say.
    hydrateImages(wysiwygEl);
  } else {
    // execCommand rather than assigning .value: it keeps the pane's native undo
    // stack and fires `input`, which is what the autosave clock hangs off.
    // No re-render to do: a paste can only land in a pane that takes typing, and
    // the Preview pane is not one.
    document.execCommand('insertText', false, done.text);
  }
  scheduleFindRefresh(); // the pasted text moved the find bar's matches
  await afterImport(done.imports, forFile);
}

setupPaste(editorEl);
setupPaste(wysiwygEl);

// Stop a stray drop elsewhere in the window from navigating the app to the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
