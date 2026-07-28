// Table insertion and growth, in both editing panes. Raw rewrites the pipe-
// delimited source; the Editor rearranges the live <table>.

import { editorEl, wysiwygEl } from './dom.js';
import { markBufferEdited } from './editor.js';
import { isHeadingRow } from './markdown.js';
import { state } from './state.js';
import { setStatus } from './util.js';
import { effectiveViewMode } from './views.js';

// A Markdown table is the one construct that's genuinely painful to type by hand
// and worse to widen afterwards, so the five operations that matter get shortcuts:
// insert a table, and grow the one the caret is in by a row or a column in either
// direction. Both editing views are served, and each in its own terms — Raw edits
// the pipe-delimited source, the Editor edits the live <table> — because the two
// panes are the same document in different representations, not two features.
//
// The heading row is special in both: GFM has exactly one and it comes first (a
// table *is* its delimiter row), so no operation can put a row above it.

const TABLE_SIZE = 3; // a fresh table: a heading row plus two body rows, 3 columns
const MIN_CELL_WIDTH = 3; // the narrowest delimiter GFM can express (`:-:`)

// Delimiter cell → column alignment, mirroring CELL_BORDER on the way back in.
function borderAlign(cell) {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return '';
}

// Positions of the cell-separating pipes in a source row. A `\|` is an escaped
// literal inside a cell (that's how cellText writes one out), not a separator.
function pipePositions(line) {
  const at = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '|' && line[i - 1] !== '\\') at.push(i);
  }
  return at;
}

// The cells of one source row. GFM makes the outer pipes optional, so a blank
// segment before the first pipe or after the last is a delimiter's shadow rather
// than a cell — dropping them keeps the column count honest either way.
function splitRow(line) {
  const at = pipePositions(line);
  if (!at.length) return null;
  const cells = [];
  let from = 0;
  for (const pipe of at) {
    cells.push(line.slice(from, pipe));
    from = pipe + 1;
  }
  cells.push(line.slice(from));
  if (!cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map((cell) => cell.trim());
}

// A table row, strictly: it opens with a pipe. GFM would also swallow a following
// paragraph line into the table, but reformatting prose as a row is a silent way
// to mangle a note, so the block we edit stops where the pipes do.
function isTableLine(line) {
  return line.trim().startsWith('|');
}

function isDelimiterRow(line) {
  const cells = splitRow(line);
  return !!cells && cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

// The table the caret sits in, as source lines plus the offsets they occupy, or
// null. A run of pipe rows is only a table if its second line is the delimiter —
// without one the block is prose that merely contains pipes.
function tableBlockAt(value, caret) {
  const lines = value.split('\n');
  const starts = [];
  let pos = 0;
  for (const line of lines) {
    starts.push(pos);
    pos += line.length + 1;
  }
  let idx = 0;
  while (idx + 1 < lines.length && starts[idx + 1] <= caret) idx += 1;
  if (!isTableLine(lines[idx])) return null;
  let first = idx;
  let last = idx;
  while (first > 0 && isTableLine(lines[first - 1])) first -= 1;
  while (last + 1 < lines.length && isTableLine(lines[last + 1])) last += 1;
  const block = lines.slice(first, last + 1);
  if (block.length < 2 || isDelimiterRow(block[0]) || !isDelimiterRow(block[1])) return null;
  return {
    lines: block,
    from: starts[first],
    to: starts[last] + lines[last].length,
    line: idx - first,
    column: caret - starts[idx],
  };
}

// Source lines → the model every operation works on: the heading row and the body
// rows as one list (the delimiter row isn't content, it's the alignments), padded
// to a common width so a column can be inserted at the same index in every row.
function parseTable(lines) {
  const rows = lines.map(splitRow).filter(Boolean);
  const aligns = rows[1].map(borderAlign);
  const body = rows.filter((_, i) => i !== 1);
  const cols = Math.max(aligns.length, ...body.map((row) => row.length));
  body.forEach((row) => {
    while (row.length < cols) row.push('');
  });
  while (aligns.length < cols) aligns.push('');
  return { aligns, rows: body };
}

// The model back to source, with the columns padded to a common width. Every
// operation rewrites all of a table's lines anyway (a new column touches each
// one), so lining them up costs nothing and keeps the raw source readable.
function formatTable(table) {
  const widths = table.aligns.map((_, col) =>
    table.rows.reduce((max, row) => Math.max(max, (row[col] || '').length), MIN_CELL_WIDTH)
  );
  const border = table.aligns.map((align, col) => {
    const width = widths[col];
    if (align === 'center') return `:${'-'.repeat(width - 2)}:`;
    if (align === 'left') return `:${'-'.repeat(width - 1)}`;
    if (align === 'right') return `${'-'.repeat(width - 1)}:`;
    return '-'.repeat(width);
  });
  const line = (cells) => `| ${cells.map((cell, col) => cell.padEnd(widths[col])).join(' | ')} |`;
  const out = table.rows.map((row) => line(row));
  out.splice(1, 0, line(border));
  return out;
}

// Where a cell's text starts in a formatted line: past its opening pipe and the
// space after it, which is where the caret belongs once the table is rewritten.
function cellStart(line, col) {
  const at = pipePositions(line);
  if (col >= at.length) return line.length;
  return Math.min(at[col] + 2, line.length);
}

// Which cell of the model the caret is in. The delimiter row isn't a row of the
// model, so a caret parked on it counts as the heading row above it.
function caretCell(block, table) {
  const row = block.line <= 1 ? 0 : block.line - 1;
  const at = pipePositions(block.lines[block.line]);
  let col = at.filter((p) => p < block.column).length - 1;
  col = Math.min(Math.max(col, 0), table.aligns.length - 1);
  return { row, col };
}

function blankTable(rows, cols) {
  return {
    aligns: Array.from({ length: cols }, () => ''),
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')),
  };
}

// Grow the model, and say which cell the caret should land in afterwards. Row
// indices clamp to 1: row 0 is the heading, and nothing can precede it.
function growTable(table, op, at) {
  const cols = table.aligns.length;
  if (op === 'row-above' || op === 'row-below') {
    const index = op === 'row-below' ? at.row + 1 : Math.max(at.row, 1);
    table.rows.splice(index, 0, Array.from({ length: cols }, () => ''));
    return { row: index, col: at.col };
  }
  const index = op === 'column-right' ? at.col + 1 : at.col;
  table.aligns.splice(index, 0, '');
  table.rows.forEach((row) => row.splice(index, 0, ''));
  return { row: at.row, col: index };
}

// Replace the table's source lines with the rewritten ones and put the caret in
// `at`. insertText (rather than assigning .value) keeps the textarea's native undo
// stack and fires `input`, which is what the autosave clock hangs off.
function rewriteRawTable(block, table, at) {
  const lines = formatTable(table);
  editorEl.setSelectionRange(block.from, block.to);
  document.execCommand('insertText', false, lines.join('\n'));
  const line = at.row === 0 ? 0 : at.row + 1; // the delimiter row sits at index 1
  const before = lines.slice(0, line).reduce((n, text) => n + text.length + 1, 0);
  const caret = block.from + before + cellStart(lines[line], at.col);
  editorEl.setSelectionRange(caret, caret);
}

// A table has to start its own block, so it takes a blank line on each side —
// unless the text there already provides one (or there is no text at all).
function blockGap(text, trailing) {
  if (!text) return '';
  const blank = trailing ? /^\n\n/.test(text) : /\n\n$/.test(text);
  if (blank) return '';
  const newline = trailing ? text.startsWith('\n') : text.endsWith('\n');
  return newline ? '\n' : '\n\n';
}

function rawInsertTable() {
  const lines = formatTable(blankTable(TABLE_SIZE, TABLE_SIZE));
  const start = editorEl.selectionStart ?? 0;
  const end = editorEl.selectionEnd ?? start;
  const lead = blockGap(editorEl.value.slice(0, start), false);
  const tail = blockGap(editorEl.value.slice(end), true);
  document.execCommand('insertText', false, lead + lines.join('\n') + tail);
  const caret = start + lead.length + cellStart(lines[0], 0);
  editorEl.setSelectionRange(caret, caret);
  return true;
}

function rawTableOp(op) {
  if (op === 'insert') return rawInsertTable();
  const block = tableBlockAt(editorEl.value, editorEl.selectionStart ?? 0);
  if (!block) return false;
  const table = parseTable(block.lines);
  rewriteRawTable(block, table, growTable(table, op, caretCell(block, table)));
  return true;
}

// The table cell the caret sits in, if any — the WYSIWYG counterpart of
// tableBlockAt, and the anchor every Editor-side operation grows from.
function caretTableCell() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  /** @type {Node | Element | null} */
  let node = sel.getRangeAt(0).startContainer;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const el = /** @type {Element | null} */ (node);
  const cell = el && el.closest ? el.closest('th, td') : null;
  return cell && wysiwygEl.contains(cell) ? cell : null;
}

function placeCaretIn(node) {
  const range = document.createRange();
  range.setStart(node, 0);
  range.collapse(true);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

// Where a new body row goes. A browser parks a bare <tr> in a <tbody>, and the
// heading row usually lives in its own <thead>, so a table may have either or
// both — the body is whichever section isn't the heading's.
function tableBody(table) {
  const existing = Array.from(table.tBodies)[0];
  if (existing) return existing;
  const body = document.createElement('tbody');
  table.appendChild(body);
  return body;
}

function isHeadingCellRow(row) {
  return row.parentNode.nodeName === 'THEAD' || isHeadingRow(row);
}

function wysiwygInsertRow(cell, below) {
  const row = cell.parentNode;
  const table = row.closest('table');
  const fresh = document.createElement('tr');
  for (let i = 0; i < row.children.length; i += 1) {
    fresh.appendChild(document.createElement('td'));
  }
  if (isHeadingCellRow(row)) {
    // Nothing can precede the heading row, so both directions mean the same thing
    // from it: the new row opens the body. When the heading row *is* in the body
    // (a browser parks a bare <tr> there), that means after it, not at the top —
    // a row above it would leave the table with no heading at all.
    const body = tableBody(table);
    const at = body === row.parentNode ? row.nextElementSibling : body.firstElementChild;
    body.insertBefore(fresh, at);
  } else {
    row.parentNode.insertBefore(fresh, below ? row.nextElementSibling : row);
  }
  return fresh.firstElementChild;
}

function wysiwygInsertColumn(cell, after) {
  const table = cell.closest('table');
  const index = cell.cellIndex + (after ? 1 : 0);
  /** @type {HTMLTableCellElement | null} */
  let caretCellEl = null;
  Array.from(table.rows).forEach((row) => {
    const fresh = document.createElement(isHeadingCellRow(row) ? 'th' : 'td');
    row.insertBefore(fresh, row.children[index] || null);
    if (row === cell.parentNode) caretCellEl = fresh;
  });
  return caretCellEl;
}

function wysiwygInsertTable() {
  const head = `<tr>${'<th></th>'.repeat(TABLE_SIZE)}</tr>`;
  const body = `<tr>${'<td></td>'.repeat(TABLE_SIZE)}</tr>`.repeat(TABLE_SIZE - 1);
  // Tagged so the caret can be put in the new table's first cell: insertHTML
  // gives back no handle on what it inserted.
  document.execCommand(
    'insertHTML',
    false,
    `<table data-fresh="1"><thead>${head}</thead><tbody>${body}</tbody></table>`
  );
  const table = /** @type {HTMLTableElement | null} */ (
    wysiwygEl.querySelector('table[data-fresh]')
  );
  if (!table) return false;
  table.removeAttribute('data-fresh');
  placeCaretIn(table.rows[0].cells[0]);
  return true;
}

function wysiwygTableOp(op) {
  if (op === 'insert') return wysiwygInsertTable();
  const cell = caretTableCell();
  if (!cell) return false;
  const fresh =
    op === 'row-above' || op === 'row-below'
      ? wysiwygInsertRow(cell, op === 'row-below')
      : wysiwygInsertColumn(cell, op === 'column-right');
  if (fresh) placeCaretIn(fresh);
  return true;
}

// ⌘/Ctrl+⇧T inserts a table; ⌘/Ctrl+⌥+arrow grows the one the caret is in, in the
// direction of the arrow.
const TABLE_KEYS = {
  ArrowLeft: 'column-left',
  ArrowRight: 'column-right',
  ArrowUp: 'row-above',
  ArrowDown: 'row-below',
};

export function tableOpFor(e) {
  if (!(e.ctrlKey || e.metaKey)) return null;
  if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') return 'insert';
  if (e.altKey && !e.shiftKey) return TABLE_KEYS[e.key] || null;
  return null;
}

export function runTableOp(op) {
  if (!state.currentFile) return;
  // Another text field (find, the smart-insert note) owns its own keyboard while
  // it has focus — a table belongs to the note, not to whatever is being typed.
  const focus = /** @type {HTMLElement | null} */ (document.activeElement);
  const inPane = focus === editorEl || wysiwygEl.contains(focus);
  const typing =
    focus && (focus.tagName === 'INPUT' || focus.tagName === 'TEXTAREA' || focus.isContentEditable);
  if (!inPane && typing) return;

  const mode = effectiveViewMode();
  if (mode !== 'raw' && mode !== 'wysiwyg') {
    setStatus('Tables can be edited in the Raw and Editor views');
    return;
  }
  // Both paths edit through the pane's own selection, so it has to be the focused
  // one — otherwise execCommand has nothing to act on.
  const pane = mode === 'raw' ? editorEl : wysiwygEl;
  if (!inPane) pane.focus();
  if (!(mode === 'raw' ? rawTableOp(op) : wysiwygTableOp(op))) {
    // Growing needs a table around the caret; inserting only needs a caret, so the
    // one way it fails is the pane not having one yet.
    setStatus(op === 'insert' ? 'Click in the editor first' : 'The cursor is not in a table');
    return;
  }
  // The raw path edits through insertText, which fires `input` — but the Editor
  // path rearranges the DOM directly, which doesn't, so mark the buffer here.
  markBufferEdited();
}
