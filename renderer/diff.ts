// The diff view — the fourth view of the open file, in the editor pane.

import { api } from './api.js';
import { currentFileEl, diffViewEl, editorEl, treeEl } from './dom.js';
import { cancelPendingSave, flushSave, openFile } from './editor.js';
import { refreshFind } from './find.js';
import { GIT_LETTER, WORD_DIFF_MAX_CELLS, gitFileStatus, gitState } from './git.js';
import { diffOps, lcsOps, type Op } from './lcs.js';
import { restorePosition } from './positions.js';
import { state } from './state.js';
import { showContextMenu } from './tree.js';
import { cssEscape, relativePath, setStatus } from './util.js';
import { applyView, setViewMode } from './views.js';

// The diff is the fourth view of the open file, shown in the editor pane alongside
// Raw / Editor / Preview rather than in a window of its own — so reviewing a change
// is the same gesture as reading the file, and the tree stays visible next to it.
// Two renderings of the same change: side-by-side, and git's own unified patch.

// Guards against a slow diff painting over a newer one.
let diffToken = 0;

// Show a file's changes, from the tree's context menu or the git bar's list.
export async function showDiffFor(target) {
  if (!gitState || !target) return;
  await flushSave();
  const entry = gitFileStatus.get(target);

  if (entry && entry.kind === 'deleted') {
    // Nothing to open — drop any queued write first so an autosave can't recreate
    // the file we're about to describe as gone.
    cancelPendingSave();
    state.diffOnlyFile = target;
    state.currentFile = target;
    state.dirty = false;
    editorEl.value = '';
    editorEl.disabled = true;
    currentFileEl.textContent = relativePath(target);
    setStatus('Deleted — showing its last committed contents');
    document.querySelectorAll('.node-row.active').forEach((el) => el.classList.remove('active'));
    state.viewMode = 'diff';
    applyView();
    return;
  }

  if (state.currentFile !== target || state.diffOnlyFile) {
    closeDiffOnly();
    const row = treeEl.querySelector(`[data-path="${cssEscape(target)}"]`);
    await openFile(target, row);
  }
  setViewMode('diff');
}

// Leave the deleted-file diff. The editor goes back to having nothing open, which
// is the truth — the file it was showing isn't there.
export function closeDiffOnly() {
  if (!state.diffOnlyFile) return;
  state.diffOnlyFile = null;
  state.currentFile = null;
  state.dirty = false;
  editorEl.value = '';
  editorEl.disabled = true;
  currentFileEl.textContent = 'No file open';
  setStatus('');
}

// Draw the open file's diff into the pane. Async, so it stamps a token and drops
// its result if the file or the view moved on while git was working.
export async function renderDiffPane() {
  const forFile = state.currentFile;
  const token = ++diffToken;
  if (!forFile || !gitState) {
    diffViewEl.replaceChildren(diffMessage('Nothing to diff.'));
    return;
  }
  diffViewEl.replaceChildren(diffMessage('Loading…'));

  const res = await api.gitDiff(state.baseFolder, forFile);
  if (token !== diffToken || state.currentFile !== forFile) return;

  if (!res || !res.ok) {
    diffViewEl.replaceChildren(diffMessage('Could not diff this file: ' + ((res && res.error) || 'unknown error')));
    return;
  }
  diffViewEl.replaceChildren(state.diffMode === 'raw' ? renderRawDiff(res) : renderVisualDiff(res));
  // The rows only exist now, so this is the first moment the pane can be put on the
  // line the reader was on — before refreshFind, which scrolls to a match when the
  // find bar is open and should win.
  restorePosition();
  // The diff is a real pane, so ⌘F searches it like any other.
  refreshFind();
}

// The git bar's list of everything that has changed. A plain popup menu, not a
// dialog: picking an entry opens that file's diff in the editor pane.
export function showChangedFiles(anchorEl) {
  if (!gitState) return;
  if (!gitState.files.length) {
    setStatus('No changes — the vault is clean.');
    return;
  }
  const rect = anchorEl.getBoundingClientRect();
  showContextMenu(
    { clientX: rect.left, clientY: rect.bottom + 4 },
    gitState.files.map((file) => ({
      label: `${GIT_LETTER[file.kind] || 'M'}  ${file.rel}`,
      fn: () => showDiffFor(file.path),
    }))
  );
}

function diffMessage(text) {
  const el = document.createElement('div');
  el.className = 'diff-empty';
  el.textContent = text;
  return el;
}

// git's unified patch, coloured by line kind. Shown verbatim — this is the view for
// when you want to see exactly what git sees.
function renderRawDiff(res) {
  if (!res.raw) {
    return diffMessage(
      res.binary ? 'Binary file — no textual diff.' : 'No textual change against HEAD.'
    );
  }
  const pre = document.createElement('pre');
  pre.className = 'diff-raw';
  for (const line of res.raw.split('\n')) {
    const el = document.createElement('div');
    let kind = 'ctx';
    if (line.startsWith('@@')) kind = 'hunk';
    else if (/^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(line))
      kind = 'meta';
    else if (line.startsWith('+')) kind = 'add';
    else if (line.startsWith('-')) kind = 'del';
    el.className = 'diff-raw-line diff-' + kind;
    el.textContent = line;
    pre.appendChild(el);
  }
  return pre;
}

// A changed line is a row, and unchanged runs are already collapsed to one — so this is
// a ceiling on how much *changed*, not on how big the file is (which is what the old
// LCS-table ceiling amounted to, and why a note with one edited paragraph could be
// refused). Past it the rows are cut off rather than the view: they are in file order,
// so what is kept is the start of the change, and the count of what isn't is said.
const MAX_DIFF_ROWS = 20000;

// Side-by-side: HEAD on the left, the working tree on the right, with the words that
// actually changed picked out inside a modified line.
function renderVisualDiff(res) {
  if (res.binary) return diffMessage('Binary file — no textual diff.');
  const head = res.head === null ? '' : res.head;
  const work = res.work === null ? '' : res.work;
  if (head === work) return diffMessage('No change against HEAD.');

  const headLines = splitLines(head);
  const workLines = splitLines(work);

  const wrap = document.createElement('div');
  wrap.className = 'diff-visual';

  const legend = document.createElement('div');
  legend.className = 'diff-legend';
  legend.textContent = res.isNew
    ? 'New file — nothing in HEAD to compare against'
    : res.isDeleted
      ? 'Deleted — HEAD on the left, nothing on the right'
      : 'HEAD (left) → working tree (right)';
  wrap.appendChild(legend);

  const grid = document.createElement('div');
  grid.className = 'diff-grid';
  // diffOps, not lcsOps: this runs over whole files, and a table over one of those is
  // what used to make the view refuse anything past a few thousand lines.
  const rows = condenseRows(pairRows(diffOps(headLines, workLines)));
  for (const row of rows.slice(0, MAX_DIFF_ROWS)) grid.appendChild(diffRowEl(row));
  wrap.appendChild(grid);
  if (rows.length > MAX_DIFF_ROWS) {
    const more = rows.length - MAX_DIFF_ROWS;
    wrap.appendChild(
      diffMessage(`⋯ ${more} further row${more === 1 ? '' : 's'} not shown — the Raw view has the whole patch.`)
    );
  }
  return wrap;
}

// Text to displayed lines. A trailing newline *terminates* the last line rather
// than starting an empty one, and empty text is no lines at all — without both,
// every file picks up a phantom blank line at the end and a deleted file shows one
// empty line opposite its former contents.
function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// One side-by-side row. `mod` is the only kind with text on both sides, which is
// what the word-level highlighting needs — but the type says `string | null` for
// each, so `wordSegments()` below still has to be handed a checked pair.
interface PairedRow {
  type: 'ctx' | 'mod' | 'del' | 'add';
  left: string | null;
  right: string | null;
  ln: number | null;
  rn: number | null;
}

// A row as rendered, once distant context has been collapsed: either a real row or
// the "⋯ N unchanged lines" marker that replaced a run of them. Discriminated on
// `type`, so reading `.count` off a real row (or `.left` off a gap) doesn't compile.
interface GapRow {
  type: 'gap';
  count: number;
}
type DiffRow = PairedRow | GapRow;

// Turn the flat op list into left/right line pairs. Within one changed block the
// deletions and additions are zipped together so a rewritten line sits opposite the
// line it replaced (which is what makes the word-level highlighting meaningful).
function pairRows(ops: Op[]): PairedRow[] {
  const rows: PairedRow[] = [];
  let ln = 0;
  let rn = 0;
  let i = 0;
  while (i < ops.length) {
    if (ops[i].type === 'ctx') {
      rows.push({ type: 'ctx', left: ops[i].text, right: ops[i].text, ln: ++ln, rn: ++rn });
      i++;
      continue;
    }
    const block: Op[] = [];
    while (i < ops.length && ops[i].type !== 'ctx') block.push(ops[i++]);
    const dels = block.filter((o) => o.type === 'del').map((o) => o.text);
    const adds = block.filter((o) => o.type === 'add').map((o) => o.text);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      const left = k < dels.length ? dels[k] : null;
      const right = k < adds.length ? adds[k] : null;
      rows.push({
        type: left !== null && right !== null ? 'mod' : left !== null ? 'del' : 'add',
        left,
        right,
        ln: left !== null ? ++ln : null,
        rn: right !== null ? ++rn : null,
      });
    }
  }
  return rows;
}

// Same idea as condenseDiff, on paired rows: keep a few lines of context around each
// change and replace the rest with a "⋯ N unchanged lines" marker.
function condenseRows(rows: PairedRow[]): DiffRow[] {
  const CONTEXT = 3;
  const keep: boolean[] = new Array(rows.length).fill(false);
  for (let k = 0; k < rows.length; k++) {
    if (rows[k].type === 'ctx') continue;
    for (let d = -CONTEXT; d <= CONTEXT; d++) {
      if (k + d >= 0 && k + d < rows.length) keep[k + d] = true;
    }
  }
  const out: DiffRow[] = [];
  let k = 0;
  while (k < rows.length) {
    if (keep[k]) {
      out.push(rows[k]);
      k++;
      continue;
    }
    let count = 0;
    while (k < rows.length && !keep[k]) {
      count++;
      k++;
    }
    out.push({ type: 'gap', count });
  }
  return out;
}

function diffRowEl(row) {
  const el = document.createElement('div');
  el.className = 'diff-row diff-' + row.type;
  if (row.type === 'gap') {
    el.textContent = `⋯ ${row.count} unchanged line${row.count === 1 ? '' : 's'}`;
    return el;
  }

  // The working-tree line this row shows, which is what lets the view be put back
  // on the line the reader was on in another pane (see renderer/positions.js).
  if (row.rn !== null && row.rn !== undefined) el.dataset.line = String(row.rn);

  // Only a replaced line has two versions to compare word by word.
  const words = row.type === 'mod' ? wordSegments(row.left, row.right) : null;
  el.appendChild(numCell(row.ln));
  el.appendChild(textCell(row.left, words ? words.left : null, 'left'));
  el.appendChild(numCell(row.rn));
  el.appendChild(textCell(row.right, words ? words.right : null, 'right'));
  return el;
}

function numCell(n) {
  const el = document.createElement('div');
  el.className = 'diff-num';
  el.textContent = n === null || n === undefined ? '' : String(n);
  return el;
}

// A null line means "this side has nothing here" — rendered as an empty filler cell
// so the two columns stay aligned rather than sliding past each other.
function textCell(text, segments, side) {
  const el = document.createElement('div');
  el.className = 'diff-text diff-' + side;
  if (text === null) {
    el.classList.add('diff-blank');
    return el;
  }
  if (!segments) {
    el.textContent = text;
    return el;
  }
  for (const seg of segments) {
    if (seg.type === 'ctx') {
      el.appendChild(document.createTextNode(seg.text));
    } else {
      const mark = document.createElement('span');
      mark.className = 'diff-word';
      mark.textContent = seg.text;
      el.appendChild(mark);
    }
  }
  return el;
}

// Word-level diff of one replaced line, as the two sides' segment lists. Returns
// null when the lines are too long to be worth an O(n×m) table — the row then just
// renders as whole-line add/remove, which is still correct, only less precise.
function wordSegments(left, right) {
  const A = left.match(/\s+|\S+/g) || [];
  const B = right.match(/\s+|\S+/g) || [];
  if ((A.length + 1) * (B.length + 1) > WORD_DIFF_MAX_CELLS) return null;

  const out = { left: [], right: [] };
  const push = (side, type, text) => {
    const list = out[side];
    const last = list[list.length - 1];
    if (last && last.type === type) last.text += text; // merge runs, fewer spans
    else list.push({ type, text });
  };
  for (const op of lcsOps(A, B)) {
    if (op.type === 'ctx') {
      push('left', 'ctx', op.text);
      push('right', 'ctx', op.text);
    } else if (op.type === 'del') {
      push('left', 'del', op.text);
    } else {
      push('right', 'add', op.text);
    }
  }
  return out;
}
