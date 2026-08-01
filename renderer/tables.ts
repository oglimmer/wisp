// Table insertion and growth, in both editing panes. Raw rewrites the pipe-
// delimited source; the Editor rearranges the live <table>. The pipe syntax itself
// — splitting a row, reading the delimiter, formatting the model back out — lives
// in markdown.js, because the WYSIWYG fold needs the same formatter to write a
// turned-down table the way this pane writes one.

import { editorEl, wysiwygEl } from './dom.js';
import { markBufferEdited } from './editor.js';
import { blockGap, formatTable, isDelimiterRow, isHeadingRow, isTableLine, parseTable, pipePositions } from './markdown.js';
import type { Table } from './markdown.js';
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

/** Insert a table, or grow the one the caret is in by a row or a column. */
export type TableOp = 'insert' | 'row-above' | 'row-below' | 'column-left' | 'column-right';

/** A cell of the model, by index. Row 0 is the heading. */
interface CellRef {
  row: number;
  col: number;
}

/** The table the caret is in, as source lines plus the offsets they occupy. */
interface TableBlock {
  lines: string[];
  /** Offsets of the block's first and last characters in the buffer. */
  from: number;
  to: number;
  /** The caret's line within the block, and its column within that line. */
  line: number;
  column: number;
}

// The table the caret sits in, as source lines plus the offsets they occupy, or
// null. A run of pipe rows is only a table if its second line is the delimiter —
// without one the block is prose that merely contains pipes.
function tableBlockAt(value: string, caret: number): TableBlock | null {
  const lines = value.split('\n');
  const starts: number[] = [];
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

// Where a cell's text starts in a formatted line: past its opening pipe and the
// space after it, which is where the caret belongs once the table is rewritten.
function cellStart(line: string, col: number) {
  const at = pipePositions(line);
  if (col >= at.length) return line.length;
  return Math.min(at[col] + 2, line.length);
}

// Which cell of the model the caret is in. The delimiter row isn't a row of the
// model, so a caret parked on it counts as the heading row above it.
function caretCell(block: TableBlock, table: Table): CellRef {
  const row = block.line <= 1 ? 0 : block.line - 1;
  const at = pipePositions(block.lines[block.line]);
  let col = at.filter((p) => p < block.column).length - 1;
  col = Math.min(Math.max(col, 0), table.aligns.length - 1);
  return { row, col };
}

function blankTable(rows: number, cols: number): Table {
  return {
    aligns: Array.from({ length: cols }, () => ''),
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => '')),
  };
}

// Grow the model, and say which cell the caret should land in afterwards. Row
// indices clamp to 1: row 0 is the heading, and nothing can precede it.
function growTable(table: Table, op: TableOp, at: CellRef): CellRef {
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
function rewriteRawTable(block: TableBlock, table: Table, at: CellRef) {
  const lines = formatTable(table);
  editorEl.setSelectionRange(block.from, block.to);
  document.execCommand('insertText', false, lines.join('\n'));
  const line = at.row === 0 ? 0 : at.row + 1; // the delimiter row sits at index 1
  const before = lines.slice(0, line).reduce((n: number, text: string) => n + text.length + 1, 0);
  const caret = block.from + before + cellStart(lines[line], at.col);
  editorEl.setSelectionRange(caret, caret);
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

function rawTableOp(op: TableOp) {
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
  let node: Node | Element | null = sel.getRangeAt(0).startContainer;
  if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;
  const el = (node as Element | null);
  const cell = (el && el.closest ? el.closest('th, td') : null) as HTMLTableCellElement | null;
  return cell && wysiwygEl.contains(cell) ? cell : null;
}

function placeCaretIn(node: Node) {
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
function tableBody(table: HTMLTableElement): HTMLTableSectionElement {
  const existing = Array.from(table.tBodies)[0];
  if (existing) return existing;
  const body = document.createElement('tbody');
  table.appendChild(body);
  return body;
}

function isHeadingCellRow(row: HTMLTableRowElement) {
  return row.parentNode?.nodeName === 'THEAD' || isHeadingRow(row);
}

function wysiwygInsertRow(cell: HTMLTableCellElement, below: boolean) {
  // A cell outside a row, or a row outside a table, is not a state the pane can
  // reach — but the operation has nowhere to put a row either way, and answering
  // "no new cell" is what the caller already handles.
  const row = cell.closest('tr');
  const table = row?.closest('table');
  if (!row || !table) return null;
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
    row.parentNode?.insertBefore(fresh, below ? row.nextElementSibling : row);
  }
  return fresh.firstElementChild as HTMLTableCellElement | null;
}

function wysiwygInsertColumn(cell: HTMLTableCellElement, after: boolean) {
  const table = cell.closest('table') as HTMLTableElement;
  const index = cell.cellIndex + (after ? 1 : 0);
  let caretCellEl: HTMLTableCellElement | null = null;
  Array.from(table.rows).forEach((row) => {
    const fresh = document.createElement(isHeadingCellRow(row) ? 'th' : 'td') as HTMLTableCellElement;
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
  const table = wysiwygEl.querySelector('table[data-fresh]') as HTMLTableElement | null;
  if (!table) return false;
  table.removeAttribute('data-fresh');
  placeCaretIn(table.rows[0].cells[0]);
  return true;
}

function wysiwygTableOp(op: TableOp) {
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
const TABLE_KEYS: Record<string, TableOp> = {
  ArrowLeft: 'column-left',
  ArrowRight: 'column-right',
  ArrowUp: 'row-above',
  ArrowDown: 'row-below',
};

export function tableOpFor(e: KeyboardEvent): TableOp | null {
  if (!(e.ctrlKey || e.metaKey)) return null;
  if (e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') return 'insert';
  if (e.altKey && !e.shiftKey) return TABLE_KEYS[e.key] || null;
  return null;
}

export function runTableOp(op: TableOp) {
  if (!state.currentFile) return;
  // Another text field (find, the smart-insert note) owns its own keyboard while
  // it has focus — a table belongs to the note, not to whatever is being typed.
  const focus = (document.activeElement as HTMLElement | null);
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
