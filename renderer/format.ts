// Block-level formatting in both editing panes: what kind of block the cursor is
// in — a heading, plain text, or a fenced code block.
//
// The shape is tables.js': one operation, dispatched on effectiveViewMode() and
// carried out in each pane's own terms, because the two editing panes are the same
// document in two representations rather than two features. Raw rewrites the
// Markdown source line by line; the Editor rearranges the live DOM. What the two
// have in common — where a block begins, which lines are a table — lives in
// markdown.js, so neither pane can drift into its own idea of it.
//
// Every operation is *absolute*, not a toggle on the marker that happens to be
// there: `⌘⌥2` on a bullet, a quote or an h1 alike leaves an h2, and `⌘⌥0` leaves
// a plain paragraph. The one exception is code, which has to be a toggle — a
// second `⌘⌥C` is the only way to take the fences off again, and `⌘⌥0` does the
// same, since "normal text" is what unfencing leaves behind.

import { editorEl, wysiwygEl } from './dom.js';
import { markBufferEdited } from './editor.js';
import { blockGap, isTableLine } from './markdown.js';
import { state } from './state.js';
import { setStatus } from './util.js';
import { effectiveViewMode } from './views.js';
import type { EffectiveViewMode } from './views.js';

const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 };

/**
 * What kind of block to make the one the cursor is in. Absolute, not a toggle —
 * except `code`, where a second one is the only way back out.
 */
export type FormatOp = 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'code';

/** A fenced code block, as the lines it spans. An unterminated one is not `closed`. */
interface FenceBlock {
  start: number;
  end: number;
  closed: boolean;
}

// ---- Raw view ----

// Where each line of the source starts, so a caret offset can be read as a line
// and a line written back as a span of the buffer.
function lineStarts(lines: string[]) {
  const starts: number[] = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length + 1;
  }
  return starts;
}

function lineAt(starts: number[], caret: number) {
  let idx = 0;
  while (idx + 1 < starts.length && starts[idx + 1] <= caret) idx += 1;
  return idx;
}

// The block markers a line can open with, in the order they nest: blockquote
// arrows, a list bullet (with an optional task checkbox) and an ATX heading.
// Taking all of them off is what "normal text" means — and a heading conversion
// takes them off too, so `- item` becomes `## item` rather than `- ## item`.
const LINE_PREFIX = /^[ \t]*(?:>[ \t]?)*(?:(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?(?:#{1,6}[ \t]+)?/;

// A setext underline: the second line of a two-line heading. It only underlines
// something, so it counts as one when the line above it has text on it —
// otherwise `---` is a thematic break, which is a block of its own.
const SETEXT_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;

function isSetextUnderline(lines: string[], i: number) {
  return i > 0 && SETEXT_RE.test(lines[i]) && !!(lines[i - 1] || '').trim();
}

// The fenced code blocks of the source, as line ranges. Mirrors how marked reads
// them: an opening fence is three or more backticks or tildes (a backtick fence's
// info string may not itself contain a backtick), closed by a fence of the same
// character, at least as long, with nothing after it. An unterminated fence runs
// to the end of the file — which is exactly what the panes show — so it is a
// block too rather than being ignored.
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

function fenceBlocks(lines: string[]) {
  const out: FenceBlock[] = [];
  let open: { start: number; fence: string } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = FENCE_RE.exec(lines[i]);
    if (!m) continue;
    if (!open) {
      if (m[1][0] === '`' && m[2].includes('`')) continue; // not a fence, just backticks
      open = { start: i, fence: m[1] };
    } else if (m[1][0] === open.fence[0] && m[1].length >= open.fence.length && !m[2].trim()) {
      out.push({ start: open.start, end: i, closed: true });
      open = null;
    }
  }
  if (open) out.push({ start: open.start, end: lines.length - 1, closed: false });
  return out;
}

function fenceBlockAt(lines: string[], index: number) {
  return fenceBlocks(lines).find((b) => index >= b.start && index <= b.end) || null;
}

// Replace whole lines of the buffer. insertText (rather than assigning .value)
// keeps the textarea's native undo stack and fires `input`, which is what the
// autosave clock hangs off — the same reason tables.js writes this way.
function replaceLines(lines: string[], starts: number[], from: number, to: number, text: string) {
  editorEl.setSelectionRange(starts[from], starts[to] + lines[to].length);
  document.execCommand('insertText', false, text);
}

// Take the fences off the block the cursor is in, leaving its contents where they
// stood. The closing fence is only dropped when there is one: an unterminated
// block's last line is content.
function rawUnfence(lines: string[], starts: number[], fence: FenceBlock) {
  const body = lines.slice(fence.start + 1, fence.closed ? fence.end : fence.end + 1);
  const caret = starts[fence.start];
  replaceLines(lines, starts, fence.start, fence.end, body.join('\n'));
  editorEl.setSelectionRange(caret, caret);
  return true;
}

// Wrap lines in a fence. A selection decides the lines itself; a bare cursor takes
// the paragraph it sits in (the run of non-blank lines around it), and on a blank
// line there is nothing to wrap, so an empty block is opened to type into.
function rawFence(
  lines: string[],
  starts: number[],
  from: number,
  to: number,
  start: number,
  end: number,
) {
  const value = editorEl.value;
  if (start === end && !lines[from].trim()) {
    const lead = blockGap(value.slice(0, start), false);
    const tail = blockGap(value.slice(start), true);
    document.execCommand('insertText', false, `${lead}\`\`\`\n\n\`\`\`${tail}`);
    const caret = start + lead.length + 4; // past "```\n", on the empty line
    editorEl.setSelectionRange(caret, caret);
    return true;
  }
  let first = from;
  let last = to;
  if (start === end) {
    while (first > 0 && lines[first - 1].trim()) first -= 1;
    while (last + 1 < lines.length && lines[last + 1].trim()) last += 1;
  }
  const body = lines.slice(first, last + 1).join('\n');
  const lead = blockGap(value.slice(0, starts[first]), false);
  const tail = blockGap(value.slice(starts[last] + lines[last].length), true);
  replaceLines(lines, starts, first, last, `${lead}\`\`\`\n${body}\n\`\`\`${tail}`);
  // The cursor stays on the text it was on, now one fence line further down.
  const caret = start + lead.length + 4;
  editorEl.setSelectionRange(caret, Math.max(caret, end + lead.length + 4));
  return true;
}

// Rewrite the marker every touched line opens with. Blank lines in a multi-line
// selection are left alone — they separate the blocks either side of them — but a
// cursor on a blank line still gets its marker, since that is a heading about to
// be typed.
function rawPrefix(
  lines: string[],
  starts: number[],
  from: number,
  to: number,
  start: number,
  end: number,
  op: FormatOp,
) {
  const level = HEADING_LEVEL[op] || 0;
  const marker = level ? `${'#'.repeat(level)} ` : '';
  const single = from === to;
  // A setext heading is two lines, so the underline has to go with the first one —
  // it is the only thing making that line a heading.
  const last = isSetextUnderline(lines, to + 1) ? to + 1 : to;

  const out: string[] = [];
  for (let i = from; i <= last; i += 1) {
    const line = lines[i];
    if (isSetextUnderline(lines, i)) continue; // dropped, not re-marked
    const body = line.slice((LINE_PREFIX.exec(line) || [''])[0].length);
    out.push(body.trim() || single ? marker + body : line);
  }

  const before = lines.slice(from, last + 1).join('\n');
  const after = out.join('\n');
  if (after === before) return true; // already that kind of block
  const firstDelta = out[0].length - lines[from].length;
  const totalDelta = after.length - before.length;
  replaceLines(lines, starts, from, last, after);
  // Put the selection back on the same text: a selection that began at the line
  // start keeps covering the whole line, anything else moves with its marker.
  const lineStart = starts[from];
  const newStart = start === lineStart ? lineStart : Math.max(lineStart, start + firstDelta);
  const newEnd = start === end ? newStart : Math.max(newStart, end + totalDelta);
  editorEl.setSelectionRange(newStart, newEnd);
  return true;
}

function rawFormatOp(op: FormatOp) {
  const lines = editorEl.value.split('\n');
  const starts = lineStarts(lines);
  const start = editorEl.selectionStart ?? 0;
  const end = editorEl.selectionEnd ?? start;
  const from = lineAt(starts, start);
  const to = Math.max(from, lineAt(starts, end));

  // Inside a code block, both "normal text" and a second ⌘⌥C mean the same thing:
  // take the fences off. Nothing else is stripped — the lines are code, not prose.
  const fence = fenceBlockAt(lines, from);
  if (fence && (op === 'code' || op === 'paragraph')) return rawUnfence(lines, starts, fence);
  if (op === 'code') return rawFence(lines, starts, from, to, start, end);
  return rawPrefix(lines, starts, from, to, start, end, op);
}

// ---- Editor (WYSIWYG) view ----

// The blocks a format operation can act on. A `div` is in the list because that is
// what a contenteditable leaves behind when the user splits a line themselves.
const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, pre, blockquote, li, div';

function elementOf(node: Node | null) {
  const el = node && node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
  return el && el.nodeType === Node.ELEMENT_NODE ? (el as Element) : null;
}

function currentRange() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  return wysiwygEl.contains(range.commonAncestorContainer) ? range : null;
}

// The blocks the selection touches, in document order. *Leaf-most* blocks: what a
// format operation acts on is the list item, not the list around it, and the
// paragraph, not the blockquote it sits in.
function selectedBlocks() {
  const range = currentRange();
  if (!range) return [];
  const leaves = Array.from(wysiwygEl.querySelectorAll(BLOCK_SEL)).filter(
    (el) => !el.querySelector(BLOCK_SEL)
  );
  const touched = leaves.filter((el) => range.intersectsNode(el));
  if (!range.collapsed) return touched;
  // A collapsed range sits on the boundary between two blocks as readily as inside
  // one, so the cursor's own block wins over whatever it touches.
  const block = elementOf(range.startContainer)?.closest(BLOCK_SEL);
  if (block && leaves.includes(block)) return [block];
  return touched.slice(0, 1);
}

// Move `el` out to the pane's top level, splitting every list or quote around it.
// "Make this a heading" on the third bullet means exactly that: the bullet leaves
// the list, and the list closes up either side of it.
function liftOut(el: Element) {
  let node: Element = el;
  while (node.parentNode && node.parentNode !== wysiwygEl && wysiwygEl.contains(node.parentNode)) {
    const parent = (node.parentNode as Element);
    const grandparent = parent.parentNode;
    if (!grandparent) break;
    const tail = (parent.cloneNode(false) as Element);
    while (node.nextSibling) tail.appendChild(node.nextSibling);
    grandparent.insertBefore(node, parent.nextSibling);
    if (tail.childNodes.length) grandparent.insertBefore(tail, node.nextSibling);
    if (!parent.childNodes.length) parent.remove();
  }
  return node;
}

// Drop a block, and any list or quote it was the last thing in.
function removeBlock(el: Element) {
  let node: Node | null = el;
  while (node && node !== wysiwygEl) {
    // Annotated because `node` is assigned from it below: without it the two
    // infer through each other and the checker gives up.
    const parent: ParentNode | null = node.parentNode;
    (node as Element).remove();
    if (!parent || parent === wysiwygEl || (parent as Element).children.length) break;
    node = parent;
  }
}

// A block as the plain text a code block is made of: hard breaks become newlines,
// and a task checkbox is a marker rather than text, so it doesn't come along.
function blockText(el: Element) {
  const copy = (el.cloneNode(true) as Element);
  copy.querySelectorAll('br').forEach((br) => br.replaceWith(document.createTextNode('\n')));
  copy.querySelectorAll('input').forEach((input) => input.remove());
  // A contenteditable writes non-breaking spaces where it needs a space to stay
  // put; in a code block they would be that character, not a space.
  return (copy.textContent || '').replace(/\u00a0/g, ' ');
}

// Where the cursor sits inside a block, counted in characters, so it can be put
// back in the block that replaces it.
function caretOffsetIn(el: Element) {
  const range = currentRange();
  if (!range || !el.contains(range.startContainer)) return null;
  const upto = range.cloneRange();
  upto.selectNodeContents(el);
  upto.setEnd(range.startContainer, range.startOffset);
  return upto.toString().length;
}

function placeCaret(el: Element, offset: number | null) {
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let target: Text | null = null;
  let at = 0;
  let left = offset ?? Infinity;
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    const node = (text as Text);
    target = node;
    at = Math.min(left, node.data.length);
    if (left <= node.data.length) break;
    left -= node.data.length;
  }
  if (target) range.setStart(target, at);
  else {
    range.selectNodeContents(el);
    range.collapse(false);
  }
  range.collapse(true);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

// The block(s) `el` becomes. Everything but a code block keeps its children, so
// the bold and the links inside it survive the change; a code block holds text,
// so each of its lines becomes a block of its own rather than one run-on line.
function convertBlock(el: Element, op: FormatOp) {
  const tag = op === 'paragraph' ? 'p' : op;
  const made: Element[] = [];
  if (el.nodeName === 'PRE') {
    const lines = blockText(el).replace(/\n+$/, '').split('\n');
    const parts = op === 'paragraph' ? lines.filter((line, _i, all) => line.trim() || all.length === 1) : [lines.join(' ')];
    for (const line of parts) {
      const node = document.createElement(tag);
      node.textContent = line;
      made.push(node);
    }
  } else {
    const node = document.createElement(tag);
    // The checkbox of a task item is its bullet, not its text.
    el.querySelectorAll('input[type="checkbox"]').forEach((box) => box.remove());
    while (el.firstChild) node.appendChild(el.firstChild);
    made.push(node);
  }
  if (!made.length) made.push(document.createElement(tag));
  return made;
}

function wysiwygConvert(blocks: Element[], op: FormatOp) {
  const offset = blocks.length === 1 ? caretOffsetIn(blocks[0]) : null;
  let landed: Element | null = null;
  for (const el of blocks) {
    const anchor = liftOut(el);
    const made = convertBlock(el, op);
    anchor.replaceWith(...made);
    landed = made[made.length - 1];
  }
  if (landed) placeCaret(landed, offset);
  return true;
}

// Fence the touched blocks as one code block — or, if the cursor is simply in one
// already, unfence it back into paragraphs.
function wysiwygCode(blocks: Element[]) {
  if (!blocks.length) return false;
  if (blocks.length === 1 && blocks[0].nodeName === 'PRE') return wysiwygConvert(blocks, 'paragraph');
  const text = blocks.map(blockText).join('\n');
  const pre = document.createElement('pre');
  const code = document.createElement('code');
  code.textContent = text;
  pre.appendChild(code);
  const anchor = liftOut(blocks[0]);
  anchor.replaceWith(pre);
  blocks.slice(1).forEach(removeBlock);
  placeCaret(code, text.length);
  return true;
}

function wysiwygFormatOp(op: FormatOp) {
  const blocks = selectedBlocks();
  if (op === 'code') return wysiwygCode(blocks);
  // A cursor in stray text the pane never wrapped in a block has nothing to
  // replace; the browser's own formatBlock wraps it, which is what it is for.
  if (!blocks.length) {
    if (!currentRange()) return false;
    document.execCommand('formatBlock', false, op === 'paragraph' ? '<p>' : `<${op}>`);
    return true;
  }
  return wysiwygConvert(blocks, op);
}

// ---- Typing a marker ----
// In the Raw pane `- ` at the start of a line *is* a bullet; in the Editor it is
// two characters that stay two characters, since nothing re-reads the pane as
// Markdown while it is being typed. So the marker is honoured as it is written:
// `*` or `-` followed by a space at the start of a block turns the block into a
// list item, the way it would have read had it been typed in the source.

// A plain paragraph, or a list item that is already one. A heading, a quote's own
// text, a table cell or a code block keeps the character as the character —
// converting there would silently throw away the block the user is in, which is a
// worse surprise than a literal dash.
function markerBlock(range: Range) {
  const block = elementOf(range.startContainer)?.closest(BLOCK_SEL);
  if (!block || !wysiwygEl.contains(block)) return null;
  const tag = block.nodeName;
  if (tag !== 'P' && tag !== 'DIV' && tag !== 'LI') return null;
  return block.closest('table, pre') ? null : block;
}

// Chromium makes its own list rather than joining the one above, which would
// leave two `<ul>`s where the source had one — and turndown writes them out as
// two lists, so the note grows a break nobody typed.
function mergeWithListAbove(item: Element) {
  const list = item.parentElement;
  const above = list && list.previousElementSibling;
  if (!list || !above || above.nodeName !== list.nodeName) return;
  while (list.firstChild) above.appendChild(list.firstChild);
  list.remove();
}

/**
 * Handle the space that follows a lone `*` or `-` at the start of a block.
 * @returns true if it started a list, and the space should not be typed
 */
export function bulletInputRule(): boolean {
  if (state.viewMode !== 'wysiwyg' || !state.currentFile) return false;
  const range = currentRange();
  if (!range || !range.collapsed) return false;
  const block = markerBlock(range);
  if (!block) return false;
  // Everything in the block up to the cursor — the marker and nothing else.
  const upto = range.cloneRange();
  upto.selectNodeContents(block);
  upto.setEnd(range.startContainer, range.startOffset);
  if (!/^[*-]$/.test(upto.toString())) return false;

  const sel = window.getSelection();
  if (!sel) return false;
  sel.removeAllRanges();
  sel.addRange(upto);
  document.execCommand('delete'); // the marker becomes the bullet, not text in it
  // Already a bullet — Enter in a list makes the next item, so a marker typed
  // there is someone asking for what they already have. Swallow it rather than
  // leaving `- \- eggs` in the note. (Tab is how an item nests.)
  if (block.nodeName !== 'LI') {
    document.execCommand('insertUnorderedList');
    const item = elementOf(window.getSelection()?.anchorNode ?? null)?.closest('li');
    if (item && wysiwygEl.contains(item)) mergeWithListAbove(item);
  }
  // insertUnorderedList is a formatting command: no `input` event, same as the
  // table ops and indent/outdent.
  markBufferEdited();
  return true;
}

// ---- Dispatch ----

// A table row is written as a table, in either pane: `# | a | b |` is not a
// heading, and a cell is not a block that can hold one.
function caretInTable(mode: EffectiveViewMode) {
  if (mode === 'raw') {
    const lines = editorEl.value.split('\n');
    return isTableLine(lines[lineAt(lineStarts(lines), editorEl.selectionStart ?? 0)] || '');
  }
  const range = currentRange();
  return !!range && !!elementOf(range.startContainer)?.closest('table');
}

// ⌘⌥ / Ctrl+Alt plus a digit sets what kind of block the cursor is in — 0 is plain
// text, 1–6 the heading levels — and +C fences it as code. That keeps every
// block-level operation on one modifier: the same chord grows a table by an arrow.
//
// Keyed off `e.code`, the key's position, rather than `e.key`, the character it
// produced: Option is a character modifier on macOS (⌥1 types "¡") and a digit
// isn't in the same place on every layout, so the position is the only reading of
// this chord that can't be wrong.
//
// The plain ⌘0/⌘1… chords other editors use are not available: ⌘0/⌘+/⌘- are the
// window menu's zoom accelerators, and a menu accelerator never reaches the page.
const FORMAT_CODES: Record<string, FormatOp> = {
  Digit0: 'paragraph',
  Digit1: 'h1',
  Digit2: 'h2',
  Digit3: 'h3',
  Digit4: 'h4',
  Digit5: 'h5',
  Digit6: 'h6',
  KeyC: 'code',
};

export function formatOpFor(e: KeyboardEvent): FormatOp | null {
  if (!(e.ctrlKey || e.metaKey) || !e.altKey || e.shiftKey) return null;
  return FORMAT_CODES[e.code] || null;
}

export function runFormatOp(op: FormatOp) {
  if (!state.currentFile) return;
  // Another text field (find, the smart-insert note) owns its own keyboard while
  // it has focus — formatting belongs to the note, not to whatever is being typed.
  const focus = (document.activeElement as HTMLElement | null);
  const inPane = focus === editorEl || wysiwygEl.contains(focus);
  const typing =
    focus && (focus.tagName === 'INPUT' || focus.tagName === 'TEXTAREA' || focus.isContentEditable);
  if (!inPane && typing) return;

  const mode = effectiveViewMode();
  if (mode !== 'raw' && mode !== 'wysiwyg') {
    setStatus('Formatting can be applied in the Raw and Editor views');
    return;
  }
  // Both paths edit through the pane's own selection, so it has to be the focused
  // one — otherwise execCommand has nothing to act on.
  const pane = mode === 'raw' ? editorEl : wysiwygEl;
  if (!inPane) pane.focus();

  if (caretInTable(mode)) {
    setStatus('A table row is a table — use the table shortcuts');
    return;
  }
  if (!(mode === 'raw' ? rawFormatOp(op) : wysiwygFormatOp(op))) {
    setStatus('Click in the editor first');
    return;
  }
  // The raw path edits through insertText, which fires `input` — but the Editor
  // path rearranges the DOM directly, which doesn't, so mark the buffer here.
  markBufferEdited();
}
