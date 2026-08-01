// Per-file reading position: one place in the note, put back in every view.
//
// Reopening a note should land where it was left — and so should switching between
// Raw, Editor, Preview and Diff. The four panes lay the same file out completely
// differently, so "the same scroll offset" would be four different places in it.
// What is remembered is therefore a position in the *source*: a fractional line for
// the top of the viewport and a line/column for the caret, which each pane maps
// into and out of its own geometry.
//
// Each pane's own exact offset is kept alongside that, because a mapped position is
// only ever as precise as the correspondence between a rendered block and the lines
// behind it. A pane whose stored offset was recorded against the anchor still in
// force is restored to it byte-for-byte; only a pane the reader has moved away from
// since is mapped. So Raw → Preview → Raw comes back to exactly the pixel and caret
// it left, while Raw → Preview lands on the paragraph the reader was reading.
//
// Capture is continuous, off the panes' own scroll/selection events. Deriving the
// anchor is not: mapping a scroll offset onto a line means measuring the pane, and a
// hidden pane has no geometry at all (nor, for the textarea, a width to wrap at). So
// `syncAnchor()` is called at the points where the live pane or the buffer is about
// to be taken away — a view switch, a file switch, a flush — while the pane the
// position describes is still on screen.

import { diffViewEl, editorEl, renderedEl, wysiwygEl } from './dom.js';
import { blockLineRanges, type LineRange } from './markdown.js';
import { state, type ViewMode } from './state.js';
import { relativePath } from './util.js';
import { effectiveViewMode } from './views.js';

// Positions are a convenience, not the user's data — cap the store rather than
// letting a long-lived vault accumulate an entry per file forever. Insertion
// order is the LRU order, so the oldest entry is the first one.
const MAX_FILES = 200;
const SAVE_MS = 500;

/** A pane's own scroll offset, stamped with the anchor it was recorded against. */
export interface PaneOffset {
  top: number;
  seq?: number;
  start?: number;
  end?: number;
}

/** A place in the *source*: a line and a column, not a pixel offset. */
export interface Caret {
  line: number;
  col: number;
}

/**
 * What is remembered for one file. The four pane keys are exactly `ViewMode`, so
 * `pos[mode]` is a checked lookup rather than an index signature — which is what
 * keeps a fifth pane from being read out of here by accident.
 */
export interface Position {
  seq?: number;
  /** The pane the reader last moved in — the only one that can be measured. */
  from?: ViewMode;
  anchor?: { line: number; caret: Caret | null } | null;
  raw?: PaneOffset;
  wysiwyg?: PaneOffset;
  preview?: PaneOffset;
  diff?: PaneOffset;
}

let positions: Map<string, Position> = new Map();
let storageKey: string | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// The file whose anchor is owed: the reader has moved in a pane, but the line that
// movement amounts to hasn't been worked out yet (see syncAnchor).
let anchorOwed: string | null = null;

// effectiveViewMode() reports one mode more than ViewMode: 'image', the derived
// mode for a picture opened from the tree. It has no buffer behind it, so it is
// never a Position key — paneEl() answers null for it, and `isPaneMode` is what
// lets the compiler see that every caller has already returned by then.
type PaneMode = ViewMode | 'image';
const isPaneMode = (mode: PaneMode): mode is ViewMode => mode !== 'image';

// The image viewer and a deleted file's diff show something that isn't the buffer,
// so neither has a position in it to remember.
function paneEl(mode: PaneMode) {
  if (mode === 'raw') return editorEl;
  if (mode === 'wysiwyg') return wysiwygEl;
  if (mode === 'preview') return renderedEl;
  if (mode === 'diff') return diffViewEl;
  return null;
}

// Positions are keyed by vault so switching folders doesn't mix two vaults'
// files (paths are stored relative for the same reason — moving a vault keeps
// them pointing at the right notes).
export function loadPositions(folder: string | null) {
  flushPositions(); // don't carry a pending write over to the new key
  positions = new Map();
  anchorOwed = null;
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
  // The live pane is still on screen here, which is the only time the anchor can
  // be worked out — and a persisted position is worth little without it.
  syncAnchor();
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

// A moved (or renamed) file keeps its reading position. The store is keyed by
// vault-relative path, so the key has to follow the file — including every file
// under a folder that moved, which is why this re-keys by prefix as well.
export function remapPositions(oldRel: string, newRel: string) {
  if (!oldRel || !newRel || oldRel === newRel) return;
  const sep = oldRel.includes('\\') ? '\\' : '/';
  const prefix = oldRel + sep;
  // Rebuilt in order rather than edited in place: the Map's order is the LRU one.
  const next: Map<string, Position> = new Map();
  for (const [key, pos] of positions) {
    if (key === oldRel) next.set(newRel, pos);
    else if (key.startsWith(prefix)) next.set(newRel + sep + key.slice(prefix.length), pos);
    else next.set(key, pos);
  }
  positions = next;
  if (anchorOwed === oldRel) anchorOwed = newRel;
  schedulePersist();
}

// Fetch this file's entry, moving it to the end: the Map's order is the LRU one.
function touch(key: string): Position {
  const pos = positions.get(key) || {};
  positions.delete(key);
  positions.set(key, pos);
  while (positions.size > MAX_FILES) {
    const oldest = positions.keys().next().value;
    if (oldest === undefined) break;
    positions.delete(oldest);
  }
  return pos;
}

// The file whose position the panes are currently showing, or null if there is
// nothing to remember (no vault, no file, or a deleted file shown as a diff).
function positionKey() {
  if (!state.baseFolder || !state.currentFile || state.diffOnlyFile) return null;
  return relativePath(state.currentFile);
}

// ---- Capture ----

function capturePosition() {
  const key = positionKey();
  if (!key) return;
  const mode = effectiveViewMode();
  const el = paneEl(mode);
  if (!el || !isPaneMode(mode)) return;
  const pos = touch(key);
  pos.seq = (pos.seq || 0) + 1;
  pos.from = mode;
  pos[mode] = paneOffset(mode, el, pos.seq);
  // What line that amounts to is worked out later, while the pane is still up.
  anchorOwed = key;
  schedulePersist();
}

/** @returns {PaneOffset} */
function paneOffset(mode: ViewMode, el: HTMLElement, seq?: number, top?: number) {
  const offset: PaneOffset = { top: top === undefined ? el.scrollTop : top, seq };
  if (mode === 'raw') {
    offset.start = editorEl.selectionStart ?? 0;
    offset.end = editorEl.selectionEnd ?? offset.start;
  }
  return offset;
}

/**
 * Work out which line the reader is on in the pane they last moved in, while that
 * pane is still on screen. A no-op unless a movement is owed one, so it can be
 * called freely from anywhere about to swap the pane or the buffer out.
 */
export function syncAnchor() {
  const key = anchorOwed;
  if (!key || key !== positionKey()) return;
  const pos = positions.get(key);
  if (!pos) return;
  const mode = pos.from;
  // Only the live pane can be measured — and only it is the one that moved.
  if (!mode || mode !== effectiveViewMode()) return;
  const el = paneEl(mode);
  if (!el) return;
  const anchor = readAnchor(mode, el, pos);
  if (!anchor) return; // nothing to map with; the exact offsets still stand
  pos.anchor = anchor;
  anchorOwed = null;
  schedulePersist();
}

/** A place in the source the panes are matched against: a line, and maybe a caret. */
interface Anchor {
  line: number;
  caret: Caret | null;
}

function readAnchor(mode: ViewMode, el: HTMLElement, pos: Position): Anchor | null {
  const carried = pos.anchor ? pos.anchor.caret : null;
  if (mode === 'raw') {
    const tops = rawLineTops();
    if (!tops) return null;
    return { line: lineAtPixels(tops, el.scrollTop), caret: caretFromRaw() };
  }
  if (mode === 'wysiwyg' || mode === 'preview') {
    const line = paneLineAt(el);
    if (line === null) return null;
    // Only the Editor pane has a caret of its own. Scrolling the read-only Preview
    // (or the diff) moves the reader, not the cursor — so the caret is carried
    // across unchanged rather than dragged to wherever the scroll ended up.
    const caret = mode === 'wysiwyg' ? paneCaret(el) : null;
    return { line, caret: caret || carried };
  }
  if (mode === 'diff') {
    const line = diffLineAt(el);
    if (line === null) return null;
    return { line, caret: carried };
  }
  return null;
}

// ---- Restore ----

// A pane full of images lays out short until they decode (hydrateImages resolves
// each one through main), so a restore into one clamps and lands high. Remember
// what was asked for and re-apply it as the pictures arrive.
let pending: { el: Element, top: number } | null = null;
// The scroll offset and caret this module put there itself. The events that follow
// a restore are not the reader going anywhere, and taking them for movement would
// throw the anchor away — and with it the exact offset every other pane is matched
// to, which is what makes a round trip land back on the same pixel.
const appliedTop: Map<Element, number> = new Map();
let appliedSelection: {start: number, end: number} | null = null;
let appliedCaret: {node: Node, offset: number} | null = null;

function applyScroll(el: HTMLElement, top: number) {
  el.scrollTop = top;
  appliedTop.set(el, el.scrollTop);
  pending = el.scrollTop < top ? { el, top } : null;
}

export function restorePosition() {
  pending = null;
  const key = positionKey();
  if (!key) return;
  const mode = effectiveViewMode();
  const el = paneEl(mode);
  if (!el) return;
  const pos = positions.get(key);
  const offset = pos && isPaneMode(mode) ? pos[mode] : null;
  // This pane's own offset is the better answer whenever it was recorded against
  // the anchor still in force — it is exact where a mapping is approximate. The
  // anchor wins only when the reader has since moved somewhere else, and only once
  // that movement has actually been worked out (an owed one is out of date).
  const anchor = pos && pos.anchor && anchorOwed !== key ? pos.anchor : null;
  const stale = !!pos && (!offset || offset.seq !== pos.seq);
  const mapped = anchor && stale ? mapAnchor(mode, el, anchor) : null;

  // A file with no remembered position opens at the top — which has to be applied
  // rather than left alone: assigning `editorEl.value` parks Chromium's caret at
  // the *end* of the text, and the focus() that follows scrolls it into view, so
  // "do nothing" means opening at the bottom of the file.
  const top = mapped ? mapped.top : offset ? offset.top : 0;
  // The caret first: setting it scrolls it into view, so the scroll offset has to
  // be applied after to win when the reader had scrolled away from the caret.
  if (mode === 'raw') applyRawSelection(mapped ? caretOffsets(mapped.caret) : offset);
  else if (mode === 'wysiwyg' && mapped) placePaneCaret(el, mapped.caret);
  applyScroll(el, top || 0);

  // This pane now shows the anchor, so remember its offset as matched to it: coming
  // back here is then an exact restore rather than the same mapping run twice. A
  // restore that *couldn't* map leaves the pane stale on purpose — the diff's rows
  // don't exist until git has answered, and it is restored again when they do.
  if (pos && isPaneMode(mode) && (mapped || !stale)) {
    pos[mode] = paneOffset(mode, el, pos.seq, top || 0);
    schedulePersist();
  }
}

// The buffer offsets to put the textarea's selection at: a stored raw offset pair
// as it stands, a caret mapped from another pane as a collapsed cursor.
function caretOffsets(caret: Caret | null) {
  if (!caret) return null;
  const at = offsetAtLineCol(caret.line, caret.col);
  return { start: at, end: at };
}

function applyRawSelection(sel: { start?: number; end?: number } | null | undefined) {
  const max = editorEl.value.length;
  // The file may have been edited elsewhere since — clamp rather than trusting a
  // stored offset to still be inside it. (scrollTop the browser clamps itself.)
  const start = clamp(sel && typeof sel.start === 'number' ? sel.start : 0, 0, max);
  const end = clamp(sel && typeof sel.end === 'number' ? sel.end : start, start, max);
  editorEl.setSelectionRange(start, end);
  appliedSelection = { start, end };
}

function mapAnchor(mode: PaneMode, el: HTMLElement, anchor: Anchor) {
  const top =
    mode === 'raw' ? rawPixelsAt(anchor.line)
    : mode === 'diff' ? diffTopAt(el, anchor.line)
    : paneTopAt(el, anchor.line);
  if (top === null) return null;
  return { top, caret: anchor.caret || null };
}

// ---- The buffer's lines ----

let lineCache: {text: string, lines: string[]} | null = null;

function bufferLines() {
  const text = editorEl.value;
  if (!lineCache || lineCache.text !== text) lineCache = { text, lines: text.split('\n') };
  return lineCache.lines;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const clamp01 = (n: number) => (Number.isFinite(n) ? clamp(n, 0, 1) : 0);

// A block sitting within a pixel of the viewport's top edge is the block at the top:
// laid-out positions are fractional, so an exact comparison would answer with the
// block above it — one that isn't on screen at all.
const EDGE = 1;

function caretFromRaw() {
  const at = editorEl.selectionStart ?? 0;
  const before = editorEl.value.slice(0, at);
  const line = before.split('\n').length - 1;
  return { line, col: at - (before.lastIndexOf('\n') + 1) };
}

function offsetAtLineCol(line: number, col: number) {
  const lines = bufferLines();
  const i = clamp(Math.floor(line) || 0, 0, lines.length - 1);
  let at = 0;
  for (let k = 0; k < i; k++) at += lines[k].length + 1;
  return at + clamp(col || 0, 0, lines[i].length);
}

// ---- Raw: source lines ↔ pixels ----
// The textarea soft-wraps, so a source line can be several rows tall and where it
// sits cannot be worked out from a line height. So it is measured: a copy of the
// text, at the same width, with the same typography (`.text-metrics` shares the
// textarea's own CSS rule), one span per line to read the tops off. Built only when
// a position has to cross panes, and cached until the text or the width changes.

let metrics: {text: string, width: number, tops: number[]} | null = null;

/** @returns one top per line, plus the bottom of the last */
function rawLineTops(): number[] | null {
  const text = editorEl.value;
  const width = editorEl.clientWidth;
  const parent = editorEl.parentElement;
  // A hidden textarea has no width to wrap at, so there is nothing to measure.
  if (!width || !parent) return null;
  if (metrics && metrics.text === text && metrics.width === width) return metrics.tops;

  const box = document.createElement('div');
  box.className = 'text-metrics';
  box.style.width = width + 'px';
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (i) box.appendChild(document.createTextNode('\n'));
    const span = document.createElement('span');
    // A zero-width space keeps an empty line's span from collapsing to no box at
    // all, which would leave it with no position to read.
    span.textContent = line || '\u200b';
    box.appendChild(span);
  });
  parent.appendChild(box);
  const spans = box.children;
  const tops = new Array(spans.length + 1);
  for (let i = 0; i < spans.length; i++) tops[i] = (spans[i] as HTMLElement).offsetTop;
  const last = (spans[spans.length - 1] as HTMLElement | undefined);
  tops[spans.length] = last ? last.offsetTop + last.offsetHeight : 0;
  box.remove();

  metrics = { text, width, tops };
  return tops;
}

function lineAtPixels(tops: number[], top: number) {
  const last = tops.length - 2; // the final entry is the bottom, not a line
  if (last < 0) return 0;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= top) lo = mid;
    else hi = mid - 1;
  }
  const height = Math.max(1, tops[lo + 1] - tops[lo]);
  return lo + clamp01((top - tops[lo]) / height);
}

function rawPixelsAt(line: number) {
  const tops = rawLineTops();
  if (!tops) return null;
  const last = Math.max(tops.length - 2, 0);
  const i = clamp(Math.floor(line) || 0, 0, last);
  const frac = clamp01(line - i);
  return tops[i] + frac * Math.max(0, tops[i + 1] - tops[i]);
}

// ---- Rendered panes: source lines ↔ pixels ----
// A pane's top-level children are its blocks and `blockLineRanges` says which lines
// each came from, so the block at the top of the viewport — and how far the reader
// has scrolled into it — is a line. When the two don't line up (a WYSIWYG pane with
// edits not yet folded back, an html block that rendered as several elements) the
// pane is mapped by proportion instead: coarse, but never wrong about which end of
// the file it is at.

function paneRegions(el: HTMLElement) {
  const ranges = blockLineRanges(editorEl.value);
  const kids = Array.from(el.children) as HTMLElement[];
  if (!ranges || !kids.length || ranges.length !== kids.length) return null;
  const origin = el.getBoundingClientRect().top - el.scrollTop;
  const regions = kids.map((kid, i) => ({
    start: ranges[i].start,
    end: ranges[i].end,
    top: kid.getBoundingClientRect().top - origin,
    bottom: 0,
  }));
  for (let i = 0; i < regions.length; i++) {
    regions[i].bottom = i + 1 < regions.length ? regions[i + 1].top : el.scrollHeight;
  }
  return regions;
}

function paneLineAt(el: HTMLElement) {
  const total = bufferLines().length;
  const regions = paneRegions(el);
  if (!regions) return clamp01(el.scrollTop / Math.max(1, el.scrollHeight)) * total;
  let i = regions.length - 1;
  while (i > 0 && regions[i].top > el.scrollTop + EDGE) i--;
  const region = regions[i];
  const frac = clamp01((el.scrollTop - region.top) / Math.max(1, region.bottom - region.top));
  return region.start + frac * Math.max(1, region.end - region.start);
}

function paneTopAt(el: HTMLElement, line: number) {
  const regions = paneRegions(el);
  if (!regions) {
    const total = bufferLines().length;
    return Math.max(0, el.scrollHeight) * clamp01(line / Math.max(1, total));
  }
  const i = regionFor(regions, line);
  const region = regions[i];
  const frac = clamp01((line - region.start) / Math.max(1, region.end - region.start));
  return region.top + frac * Math.max(0, region.bottom - region.top);
}

// The block a line falls in — the last one that starts at or before it.
// Takes anything carrying a `start`: the measured pane regions, and the raw line
// ranges `blockLineRanges()` answers with.
function regionFor(regions: { start: number }[], line: number) {
  let i = regions.length - 1;
  while (i > 0 && regions[i].start > line) i--;
  return i;
}

// ---- The diff pane ----
// Its rows carry the working-tree line they show (`data-line`, 1-based), which is
// enough to step into and out of the diff without losing the place. The unified
// patch carries no line numbers, so it keeps its own offset and leaves the anchor
// to whichever pane set it.

function diffRows(el: HTMLElement) {
  const rows = el.querySelectorAll('.diff-row[data-line]') as NodeListOf<HTMLElement>;
  if (!rows.length) return null;
  const origin = el.getBoundingClientRect().top - el.scrollTop;
  return Array.from(rows).map((row) => ({
    line: Number((row as HTMLElement).dataset.line) - 1,
    // A diff row is `display: contents` — its cells are the grid's own items, so the
    // row itself has no box to measure and the first cell is where it starts.
    top: (row.firstElementChild || row).getBoundingClientRect().top - origin,
  }));
}

function diffLineAt(el: HTMLElement) {
  const rows = diffRows(el);
  if (!rows) return null;
  let i = rows.length - 1;
  while (i > 0 && rows[i].top > el.scrollTop + EDGE) i--;
  return rows[i].line;
}

function diffTopAt(el: HTMLElement, line: number) {
  const rows = diffRows(el);
  if (!rows) return null;
  // Above the first row shown is the legend, which is worth seeing.
  if (line < rows[0].line) return 0;
  let i = 0;
  while (i + 1 < rows.length && rows[i + 1].line <= line) i++;
  return rows[i].top;
}

// ---- The caret across panes ----
// This is what the panes disagree about most: a rendered block carries neither the
// markers nor the markup of the source lines behind it, so a column in one is not a
// column in the other. What crosses is the *line* — found by walking the block's
// source lines and spending each one's visible length — with the column following as
// far as that line's own marker allows. Exact in Raw, and on the right line (and
// near enough the right word) coming back the other way.

const LINE_MARKER = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|>[ \t]*|#{1,6}[ \t]+)?/;

function markerLength(line: string) {
  return (LINE_MARKER.exec(line) || [''])[0].length;
}

function paneCaret(el: HTMLElement): Caret | null {
  const sel = window.getSelection();
  if (!sel || !sel.focusNode || !el.contains(sel.focusNode)) return null;
  const ranges = blockLineRanges(editorEl.value);
  const kids = Array.from(el.children);
  if (!ranges || ranges.length !== kids.length) return null;
  const block = topLevelBlock(el, sel.focusNode);
  if (!block) return null;
  const i = kids.indexOf(block);
  if (i < 0) return null;
  return lineColInBlock(ranges[i], textOffsetIn(block, sel.focusNode, sel.focusOffset));
}

function placePaneCaret(el: HTMLElement, caret: Caret | null) {
  if (!caret) return;
  const ranges = blockLineRanges(editorEl.value);
  const kids = Array.from(el.children);
  if (!ranges || !kids.length || ranges.length !== kids.length) return;
  const i = regionFor(ranges, caret.line);
  const spot = textNodeAt(kids[i], blockTextOffset(ranges[i], caret));
  const sel = window.getSelection();
  if (!spot || !sel) return; // a block with no text (a lone picture) has nowhere to put it
  sel.setBaseAndExtent(spot.node, spot.offset, spot.node, spot.offset);
  appliedCaret = spot;
}

// The pane child a node sits in — the ancestor whose parent is the pane itself.
function topLevelBlock(el: Element, node: Node | null) {
  let cur: Node | null = node;
  while (cur && cur.parentNode !== el) cur = cur.parentNode;
  return cur && cur.nodeType === Node.ELEMENT_NODE ? (cur as Element) : null;
}

// How many characters of the block's rendered text come before (node, offset).
function textOffsetIn(block: Element, node: Node, offset: number) {
  if (node === block) {
    // An offset among the block's children rather than into text.
    let n = 0;
    for (let k = 0; k < offset && k < block.childNodes.length; k++) {
      n += (block.childNodes[k].textContent || '').length;
    }
    return n;
  }
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let n = 0;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (t === node) return n + offset;
    n += (t.nodeValue || '').length;
  }
  return n;
}

function lineColInBlock(range: LineRange, offset: number): Caret {
  const lines = bufferLines();
  let rest = Math.max(0, offset);
  for (let ln = range.start; ln < range.end; ln++) {
    const text = lines[ln] || '';
    const marker = markerLength(text);
    const visible = Math.max(0, text.length - marker);
    // The last line of the block takes whatever is left: a rendered block is never
    // longer than its source, so overrun means markup that isn't in the rendering.
    if (rest <= visible || ln === range.end - 1) return { line: ln, col: Math.min(marker + rest, text.length) };
    rest -= visible + 1; // the line break between two source lines
  }
  return { line: range.start, col: 0 };
}

function blockTextOffset(range: LineRange, caret: Caret) {
  const lines = bufferLines();
  const line = clamp(caret.line, range.start, range.end - 1);
  let offset = 0;
  for (let ln = range.start; ln < line; ln++) {
    const text = lines[ln] || '';
    offset += Math.max(0, text.length - markerLength(text)) + 1;
  }
  const text = lines[line] || '';
  offset += Math.max(0, Math.min(caret.col || 0, text.length) - markerLength(text));
  return offset;
}

function textNodeAt(block: Element, offset: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let n = 0;
  let last: Node | null = null;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const len = (t.nodeValue || '').length;
    if (offset <= n + len) return { node: t, offset: clamp(offset - n, 0, len) };
    n += len;
    last = t;
  }
  return last ? { node: last, offset: (last.nodeValue || '').length } : null;
}

// ---- Where positions come from ----
// Reading is scrolling and moving the caret, so that is what is watched. Both
// handlers are cheap (a couple of property reads into a Map); the localStorage
// write is throttled, and working out the line is left to syncAnchor.

for (const el of [editorEl, wysiwygEl, renderedEl, diffViewEl]) {
  el.addEventListener(
    'scroll',
    () => {
      if (appliedTop.get(el) === el.scrollTop) return; // our own restore
      appliedTop.delete(el);
      // A scroll that isn't the one our own restore just made is the reader going
      // somewhere else: stop trying to put them back.
      if (pending && pending.el === el) pending = null;
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
  const active = document.activeElement;
  if (active !== editorEl && active !== wysiwygEl) return;
  if (isRestoredCaret(active)) return;
  capturePosition();
});

// Whether the selection is still exactly the one a restore put there. Setting it is
// what fires the event, and treating that as the reader moving the cursor would
// throw the anchor away on every view switch.
function isRestoredCaret(active: Element | null) {
  if (active === editorEl) {
    return !!appliedSelection
      && appliedSelection.start === (editorEl.selectionStart ?? 0)
      && appliedSelection.end === (editorEl.selectionEnd ?? 0);
  }
  const sel = window.getSelection();
  return !!appliedCaret && !!sel && sel.focusNode === appliedCaret.node && sel.focusOffset === appliedCaret.offset;
}
