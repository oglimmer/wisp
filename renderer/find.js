// Find & replace inside the open file. Highlighting takes two routes because the
// panes are different beasts — see the Find & replace section of CLAUDE.md.

import { editorEl, findBarEl, findCaseBtn, findCloseBtn, findCountEl, findHighlightsEl, findInputEl, findNextBtn, findPrevBtn, findReplaceRowEl, replaceAllBtn, replaceBtn, replaceInputEl, wysiwygEl } from './dom.js';
import { markBufferEdited } from './editor.js';
import { state } from './state.js';
import { setStatus } from './util.js';
import { activePaneEl, effectiveViewMode, setViewMode } from './views.js';

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
export let findOpen = false;
// Raw mode: `{start, end}` offsets into the buffer. WYSIWYG / preview: live Ranges.
let findMatches = [];
let findIndex = -1;
/** @type {ReturnType<typeof setTimeout> | null} */
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
export function syncHighlightBox() {
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
    const span = /** @type {HTMLElement | null} */ (
      findHighlightsEl.querySelector('.find-hit.current')
    );
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
export function refreshFind(anchor) {
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
export function scheduleFindRefresh() {
  if (!findOpen) return;
  if (findRefreshTimer) clearTimeout(findRefreshTimer);
  findRefreshTimer = setTimeout(() => {
    findRefreshTimer = null;
    refreshFind(effectiveViewMode() === 'raw' ? editorEl.selectionStart : undefined);
  }, 120);
}

export function findStep(delta) {
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

export function openFind(withReplace) {
  // Replace rewrites the Markdown source; the visual panes are projections of it,
  // so switch to the buffer itself rather than offering a control that can't work.
  // (Not for an image: there's no source buffer behind it to switch to.)
  const mode = effectiveViewMode();
  if (withReplace && state.currentFile && mode !== 'raw' && mode !== 'image') {
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

export function closeFind() {
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
  if (!state.currentFile || effectiveViewMode() !== 'raw') return;
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
  if (!state.currentFile || effectiveViewMode() !== 'raw' || !findMatches.length) return;
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
