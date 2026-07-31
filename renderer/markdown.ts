// Both directions between the buffer and the panes that project it: Markdown ->
// HTML for the preview and the WYSIWYG editor, and HTML -> Markdown for folding
// the editor's changes back. marked speaks GFM and turndown only CommonMark, so
// everything GFM adds needs an explicit inverse rule here or a WYSIWYG save
// silently destroys it — and the fold itself is reconciled block by block (see
// **WYSIWYG fold-back**) so an unedited block keeps its original source bytes.

import { lcsOps } from './lcs.js';
import { IMAGE_SUMMARY } from './state.js';

// ---- Markdown -> HTML ----

// marked leaves raw HTML in the source intact (`<script>`, event handlers,
// javascript: links). Never assign its output to innerHTML without sanitizing.
// If DOMPurify failed to load, fall closed to plain text rather than injecting.
/** @returns {string | null} */
export function safeMarkdownHtml(source) {
  if (!window.marked) return null;
  // marked.parse is only asynchronous when configured with `async: true`, which
  // this app never does — so the declared string | Promise<string> is a string.
  const raw = (window.marked.parse(source || '') as string);
  if (!window.DOMPurify) return null;
  return window.DOMPurify.sanitize(raw, {
    // Standard HTML profile: keeps headings, lists, tables, images, links,
    // <details>/<summary> (image description blocks), strips scripts/handlers.
    USE_PROFILES: { html: true },
  });
}

// ---- Frontmatter ----
// A leading `---` block is metadata, not prose, and marked has no idea: it reads
// the block as a thematic break followed by a setext heading. So the panes would
// show a bogus heading at the top of the note — and a WYSIWYG save would fold
// *that* back, turning the frontmatter into `## title: … tags: \[…\]` for good.
// It is split off before rendering, shown verbatim, and re-attached byte-for-byte
// by foldToMarkdown.

export const FRONTMATTER_CLASS = 'md-frontmatter';

// The closing fence may end the file without a newline; an empty block (`---`
// twice with nothing between) is still frontmatter.
const FRONTMATTER_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * @param {string} text
 * @returns {{fm: string, body: string}} `fm` is the whole block including both
 * fences (empty if there is none), `body` everything after it. `fm + body` is
 * always the input.
 */
export function splitFrontmatter(text) {
  const source = text || '';
  const m = FRONTMATTER_RE.exec(source);
  if (!m) return { fm: '', body: source };
  return { fm: m[0], body: source.slice(m[0].length) };
}

// Shown, but not editable: the buffer keeps the canonical copy and the fold
// re-attaches it, so an edit made here would be silently discarded. Raw view is
// where frontmatter is edited.
export function frontmatterNode(fm) {
  const pre = document.createElement('pre');
  pre.className = FRONTMATTER_CLASS;
  pre.setAttribute('contenteditable', 'false');
  pre.textContent = fm.replace(/\r?\n$/, '');
  return pre;
}

function isFrontmatterNode(node) {
  return !!node
    && node.nodeType === Node.ELEMENT_NODE
    && node.nodeName === 'PRE'
    && (node as Element).classList.contains(FRONTMATTER_CLASS);
}

// ---- Which lines a rendered block came from ----
// The panes lay the same file out completely differently, so putting the reader
// back on the line they were on means knowing which source lines each rendered
// block came from. That is a lexer question rather than a rendering one: marked's
// tokens carry their `raw`, so counting newlines while walking them gives every
// block a line range without rendering anything (which is what keeps a view switch
// off the marked + DOMPurify pass per block that the fold pays for).
//
// Only the blocks a pane can *show* get a range, in the pane's own order: blank
// lines, a link definition and a comment DOMPurify strips are not children of the
// pane at all, and counting them would put every later block one out of step. Their
// lines are absorbed into the range of the block before them, so the ranges still
// cover the whole file.

const newlines = (text) => (text ? text.split('\n').length - 1 : 0);

/**
 * The source lines behind each top-level child of a rendered pane, in order.
 * @param {string} text the whole buffer, frontmatter included
 * @returns {{start: number, end: number}[] | null} half-open, 0-based line ranges;
 *   null when marked can't be asked or there is nothing to show
 */
export function blockLineRanges(text) {
  if (!window.marked || !window.marked.lexer) return null;
  const { fm, body } = splitFrontmatter(text || '');
  let tokens;
  try {
    tokens = window.marked.lexer(body);
  } catch {
    return null; // an unparseable buffer has no blocks to line up with
  }
  const ranges: {start: number, end: number}[] = [];
  // Frontmatter is a block of its own in the pane (shown verbatim), and the body
  // starts on the line after it.
  let at = newlines(fm);
  if (fm) ranges.push({ start: 0, end: at });
  for (const t of tokens) {
    const raw = t.raw || '';
    if (!raw) continue;
    if (rendersVisibly(t)) ranges.push({ start: at, end: at });
    at += newlines(raw);
  }
  if (!ranges.length) return null;
  // Each range runs to the start of the next — that is what absorbs the blank lines
  // and hidden blocks between them — and the last one to the end of the file.
  const total = Math.max(newlines(text) + 1, at + 1);
  for (let i = 0; i < ranges.length; i++) {
    const next = i + 1 < ranges.length ? ranges[i + 1].start : total;
    ranges[i].end = Math.max(next, ranges[i].start + 1);
  }
  return ranges;
}

// Whether a token reaches the pane as a child of its own.
function rendersVisibly(t) {
  if (t.type === 'space' || t.type === 'def') return false;
  const raw = (t.raw || '').trim();
  if (!raw) return false;
  return !/^<!--[\s\S]*-->$/.test(raw); // DOMPurify strips comments
}

// ---- HTML -> Markdown ----

let turndown: import('turndown') | null = null;
// Internal: the fold is the only way HTML becomes Markdown here (see
// **WYSIWYG fold-back**), so nothing outside this module needs the service itself.
function getTurndown() {
  if (turndown || !window.TurndownService) return turndown;
  const td = new window.TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  // Emit the vault-relative path we stashed on hydrated images (their live src is
  // a data: URL), not the inlined base64 — so saved Markdown stays portable.
  td.addRule('vaultImage', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = node.getAttribute('alt') || '';
      const src = node.getAttribute('data-md-src') || node.getAttribute('src') || '';
      return src ? `![${alt}](${src})` : '';
    },
  });
  // Image-description blocks are raw HTML in the note; re-emit them as HTML
  // rather than letting turndown flatten them to their text. Not turndown.keep:
  // <details> isn't in turndown's block list, so a plain keep would splice it
  // inline and it would stop being its own HTML block. Rebuilt rather than echoed
  // via outerHTML because turndown collapses whitespace before rules run, which
  // would fold the block onto one line on every WYSIWYG save.
  td.addRule('detailsBlock', {
    filter: 'details',
    replacement: (_content, node) => {
      const summary = node.querySelector('summary');
      const label = summary ? summary.textContent.trim() : IMAGE_SUMMARY;
      const rest = node.cloneNode(true);
      const stale = rest.querySelector('summary');
      if (stale) stale.parentNode.removeChild(stale);
      // innerHTML, so escaped entities stay escaped exactly as they sit in the note.
      const body = rest.innerHTML.trim();
      return `\n\n<details>\n<summary>${label}</summary>\n${body}\n</details>\n\n`;
    },
  });
  // The frontmatter block is a read-only projection of text the buffer still
  // holds and foldToMarkdown re-attaches, so re-emitting it here would duplicate
  // it — and as a bare <pre> turndown would fence it as a code block.
  td.remove((node) => isFrontmatterNode(node));
  td.escape = narrowEscape;
  // A bare URL in the source is a link only because marked speaks GFM, and
  // turndown answers with `[url](url)` — so an edited paragraph grew a link out of
  // text that was never written as one. Re-emit the URL as itself; GFM reads it as
  // the same link next time round.
  td.addRule('bareLink', {
    filter: (node) => node.nodeName === 'A'
      && !node.getAttribute('title')
      && node.getAttribute('href') === node.textContent,
    replacement: (content) => content,
  });
  // turndown writes a bullet as its marker plus *three* spaces (`-   item`, and
  // `1.  ` for an ordered list), which nothing writes by hand — so editing one
  // item of a list rewrote the marker of every item in it, since the whole list is
  // one block. One space is what this app's own source uses, and what the note
  // being edited almost certainly already had; the continuation indent follows the
  // marker's width, which is what keeps a nested list or a wrapped paragraph
  // attached to its item. Otherwise this is turndown's own rule.
  td.addRule('listItem', {
    filter: 'li',
    replacement: (content, node, options) => {
      const parent = node.parentNode;
      let prefix = `${options.bulletListMarker} `;
      if (parent && parent.nodeName === 'OL') {
        const start = parent.getAttribute('start');
        const index = Array.prototype.indexOf.call(parent.children, node);
        prefix = `${start ? Number(start) + index : index + 1}. `;
      }
      // A paragraph inside the item ends with a newline, which has to survive the
      // trim so the next line of the item is still separated from it.
      const isParagraph = /\n$/.test(content);
      const body = content.replace(/^\n+/, '').replace(/\n+$/, '') + (isParagraph ? '\n' : '');
      // Only lines with something on them are indented — indenting a blank one
      // (which is how a loose list, or a second paragraph in an item, is written)
      // would leave the separator carrying trailing spaces.
      return prefix
        + body.replace(/\n(?=[^\n])/g, `\n${' '.repeat(prefix.length)}`)
        + (node.nextSibling ? '\n' : '');
    },
  });
  addGfmRules(td);
  turndown = td;
  return turndown;
}

// ---- Escaping ----
// turndown escapes every `*`, `_`, `[` and `]` in a text node unconditionally, so
// anything it writes comes back as `5 \* 3`, `snake\_case`, `\[\[WikiLink\]\]`.
// None of those were markup, and none of them can become markup — the escapes are
// pure noise, and noise in a note's source is what the fold exists to avoid.
//
// So each character is escaped only where it could actually re-parse as syntax.
// The line-anchored rules are turndown's own (with `m` added, which changes nothing
// while whitespace is collapsed but is right if it isn't); the four character rules
// are narrowed:
const NARROW_ESCAPES = [
  [/\\/g, '\\\\'], // first, or it would escape the escapes below
  // `*` opens emphasis only where it flanks a word, and a list only at the start of
  // a line. ` 5 * 3 ` is neither. `***` is a thematic break, and its first `*` is
  // followed by a non-space, so it is still caught.
  [/^\*(?=[ \t])|\*(?=\S)|(?<=\S)\*/gm, '\\*'],
  // `_` is the same, except CommonMark ignores one *inside* a word — which is what
  // makes snake_case safe to leave exactly as it was written.
  [/(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/gu, '\\_'],
  // A `[` only opens a link, image, reference or definition when a `]` follows with
  // `(`, `[` or `:` behind it; escaping the opening bracket alone breaks the parse,
  // so `]` never needs one. That is what leaves `[[WikiLink]]` alone. `[^` is
  // exempt: it is a footnote, which marked doesn't render at all, so escaping it
  // only corrupted the note's own footnotes.
  // (The trade: a *deliberately escaped* `\[text\]` in a note that also defines
  // `[text]:` somewhere loses its escape and becomes a link. Vanishingly rare
  // against wiki links and footnotes, which are everywhere.)
  [/\[(?!\^)(?=[^\]]*\][(\[:])/g, '\\['],
  [/`/g, '\\`'], // opens code wherever it sits
  [/^-(?=[ \t-]|$)/gm, '\\-'], // a bullet, or the `---` of a break/setext rule
  [/^\+ /gm, '\\+ '],
  [/^(=+)$/gm, '\\$1'], // a setext underline is the whole line
  [/^(#{1,6}) /gm, '\\$1 '],
  [/^~~~/gm, '\\~~~'],
  [/^>/gm, '\\>'],
  [/^(\d+)\. /gm, '$1\\. '],
];

function narrowEscape(text) {
  return NARROW_ESCAPES.reduce((out, [re, to]) => out.replace(re, to), text);
}

// ---- Table source ----
// The pipe syntax on its own terms: reading a row, recognising the delimiter,
// writing the model back out padded. Two callers need exactly this — `tables.js`,
// which edits a table's source in the Raw pane, and the `table` turndown rule
// below, which has to write a turned-down table the way the Raw pane writes one.

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
export function pipePositions(line: string) {
  const at: number[] = [];
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
  const cells: string[] = [];
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
export function isTableLine(line) {
  return line.trim().startsWith('|');
}

export function isDelimiterRow(line) {
  const cells = splitRow(line);
  return !!cells && cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

// Source lines → the model every operation works on: the heading row and the body
// rows as one list (the delimiter row isn't content, it's the alignments), padded
// to a common width so a column can be inserted at the same index in every row.
export function parseTable(lines) {
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
export function formatTable(table) {
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

// Re-pad a table's source, or null if the text isn't a well-formed table block.
// turndown emits `| a | b |` with no padding at all, so without this a table
// edited in the WYSIWYG pane comes back unaligned — a whole-table diff for a
// one-cell change, which is the churn the fold exists to avoid.
function repadTable(text) {
  const lines = text.split('\n');
  if (lines.length < 2 || !lines.every(isTableLine)) return null;
  // The same test tableBlockAt applies: a run of pipe rows is only a table if its
  // second row is the delimiter, and the first one isn't.
  if (isDelimiterRow(lines[0]) || !isDelimiterRow(lines[1])) return null;
  if (lines.some((line) => !splitRow(line))) return null;
  return formatTable(parseTable(lines)).join('\n');
}

// ---- Block separation ----
// A block-level construct — a table, a fenced code block — has to start its own
// block, so it takes a blank line on each side unless the text there already
// provides one (or there is no text at all). Both panes' inserters need exactly
// this, for the same reason they need one table formatter: two versions would mean
// two ideas of where a block begins.
/**
 * @param {string} text the source on that side of the insertion point
 * @param {boolean} trailing true for the text *after* it, which is read outwards
 */
export function blockGap(text, trailing) {
  if (!text) return '';
  const blank = trailing ? /^\n\n/.test(text) : /\n\n$/.test(text);
  if (blank) return '';
  const newline = trailing ? text.startsWith('\n') : text.endsWith('\n');
  return newline ? '\n' : '\n\n';
}

// Delimiter-row cell for each alignment GFM can express.
const CELL_BORDER = { left: ':--', center: ':-:', right: '--:' };

// marked renders GFM — tables, ~~strikethrough~~, `- [ ]` task lists — but stock
// turndown only reverses CommonMark, so without these rules a WYSIWYG save
// *destroys* every one of them: a table flattens into one paragraph per cell,
// strikethrough and checkboxes come back as bare text. These are the inverse
// rules, so what marked renders is what turndown re-emits.
function addGfmRules(td) {
  // Cells open with their own `|`; the row closes the last one. Deriving the
  // pipes here rather than from a cell's index keeps it right whatever mix of
  // element and whitespace nodes the contenteditable pane leaves in a row.
  td.addRule('tableCell', {
    filter: ['th', 'td'],
    replacement: (content) => `| ${cellText(content)} `,
  });
  td.addRule('tableRow', {
    filter: 'tr',
    replacement: (content, node) => {
      const row = `\n${content}|`;
      if (!isHeadingRow(node)) return row;
      // A GFM table *is* its delimiter row — without one the block is prose, so
      // the heading row emits it, carrying each column's alignment across.
      const border = Array.from(node.children)
        .map((cell) => `| ${CELL_BORDER[cellAlign(cell)] || '---'} `)
        .join('');
      return `${row}\n${border}|`;
    },
  });
  td.addRule('tableSection', {
    filter: ['thead', 'tbody', 'tfoot'],
    replacement: (content) => content,
  });
  td.addRule('table', {
    filter: (node) => node.nodeName === 'TABLE' && hasHeadingRow(node),
    // Rows already carry their own leading newline; drop the blank lines the
    // section boundaries leave behind, since one would end the table early. Then
    // re-pad through the Raw editor's own formatter, so a table edited here is
    // written the way this app writes tables rather than as bare `| a | b |`.
    replacement: (content) => {
      const rows = content.replace(/\n{2,}/g, '\n').trim();
      return `\n\n${repadTable(rows) ?? rows}\n\n`;
    },
  });
  // A table with no heading row can't be written as GFM at all, so keep the
  // HTML the note already had rather than flattening it to text.
  td.keep((node) => node.nodeName === 'TABLE' && !hasHeadingRow(node));

  td.addRule('strikethrough', {
    filter: ['del', 's', 'strike'],
    replacement: (content) => (content ? `~~${content}~~` : ''),
  });
  // The checkbox is the marker: re-emit it as one. The space before the label is
  // a text node of the <li>, so the marker doesn't add its own.
  td.addRule('taskListItem', {
    filter: (node) => node.nodeName === 'INPUT'
      && node.getAttribute('type') === 'checkbox'
      && node.parentNode
      && node.parentNode.nodeName === 'LI',
    replacement: (_content, node) => (node.checked ? '[x]' : '[ ]'),
  });
}

// A cell is one line of a pipe-delimited row, so anything that would end the
// cell early has to go: a literal pipe is escaped, and a line break becomes the
// <br> GFM uses for one (a cell can't span source lines). A break at either edge
// is dropped rather than written out — it's a blank line with nothing on the far
// side of it, and an empty cell is exactly where Chromium parks the placeholder
// <br> it gives an empty editable block, which would otherwise save as text.
function cellText(content) {
  return content
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, '<br>')
    .trim()
    .replace(/^(?:<br>)+|(?:<br>)+$/g, '');
}

function cellAlign(cell) {
  const attr = (cell.getAttribute('align') || '').toLowerCase();
  if (attr) return attr; // what marked emits
  return ((cell.style && cell.style.textAlign) || '').toLowerCase();
}

// Mirrors how marked reads one: the row of a <thead>, or an all-<th> first row
// of the table or of a leading <tbody> (which is where a browser parking a bare
// <tr> puts it).
export function isHeadingRow(row) {
  const parent = row && row.parentNode;
  if (!parent) return false;
  if (parent.nodeName === 'THEAD') return true;
  const leadingSection = parent.nodeName === 'TABLE'
    || (parent.nodeName === 'TBODY' && !parent.previousElementSibling);
  return leadingSection
    && parent.firstElementChild === row
    && row.children.length > 0
    && Array.from(row.children).every((cell: Element) => cell.nodeName === 'TH');
}

function hasHeadingRow(table) {
  return !!(table.rows && table.rows.length && isHeadingRow(table.rows[0]));
}

// ---- WYSIWYG fold-back ----
// Markdown -> HTML -> Markdown is lossy on *syntax*, not just on the GFM the
// rules above restore: the DOM does not record whether a heading was `#` or
// underlined, whether a bullet was `-` or `*`, where a paragraph's source lines
// were wrapped, how a table's columns were padded, or which of `_x_` / `*x*` was
// written. turndown answers in its own canonical style, and it escapes anything
// that could be read as markup — so handing it the whole pane rewrites every
// block in the file. One keystroke then lands a whole-file diff, which reads
// exactly like data loss even where nothing was lost.
//
// So the fold is reconciled block by block: each block of the *old source* is
// re-rendered on its own and matched, by HTML, against the blocks now in the
// pane. A block that still renders to what the pane holds is emitted as its
// original bytes; only genuinely edited or new blocks go through turndown.
// Anything the pane cannot show — blank lines, link definitions, HTML comments
// DOMPurify strips — is never compared and always rides along verbatim.
//
// Every uncertainty falls back to turning the whole pane down (today's behaviour:
// reformatted, but complete). Nothing here may drop an edit.

// The LCS table is blocks × blocks, far smaller than the diff view's lines ×
// lines, but it is still O(n×m) over input the user controls.
const FOLD_MAX_CELLS = 1_000_000;

/**
 * Fold the WYSIWYG pane back into Markdown, keeping the source of every block the
 * user did not actually change.
 * @param {string} oldText the buffer as it stood before the pane was edited
 * @param {Element} paneEl the contenteditable pane
 * @returns {string}
 */
export function foldToMarkdown(oldText, paneEl) {
  const td = getTurndown();
  if (!td) return oldText; // no turndown: the caller must not write a lossy save
  const { fm, body } = splitFrontmatter(oldText);
  const reconciled = reconcile(body, paneEl, td);
  return fm + (reconciled === null ? td.turndown(paneEl.innerHTML) : reconciled);
}

/**
 * The reconciled body, or null if it can't be trusted and the caller should fall
 * back to turning the whole pane down.
 * @returns {string | null}
 */
function reconcile(body, paneEl, td) {
  const src = sourceBlocks(body);
  const pane = paneBlocks(paneEl);
  if (!src) return null;
  const visible = src.blocks.filter((b) => b.sig !== '');
  if ((visible.length + 1) * (pane.length + 1) > FOLD_MAX_CELLS) return null;
  const ops = lcsOps(visible.map((b) => b.sig), pane.map((b) => b.sig));

  let out = src.prefix;
  let i = 0; // into src.blocks, hidden ones included
  let j = 0; // into pane
  // The blank lines between two blocks are held back rather than written as they
  // are passed: whatever the source put between the blocks either side of a
  // deleted one is one separation, not two.
  let sep = '';
  let last = ''; // the block emitted last, to test a new block's adjacency against
  const emit = (chunk, isAdd) => {
    if (!chunk) return;
    if (out) {
      if (sep) {
        out += sep; // the source's own separation, byte for byte
      } else {
        // No separator in the source — either the blocks genuinely sat on adjacent
        // lines (a heading and its first paragraph), or one of them is new. A new
        // block needs a blank line wherever the block before it would otherwise
        // swallow it as a lazy continuation — but not where the syntax already ends
        // that block, or an edit beside a heading would insert a blank line into a
        // note nobody touched there.
        if (!out.endsWith('\n')) out += '\n';
        if (isAdd && !out.endsWith('\n\n') && !stillSeparate(last, chunk)) out += '\n';
      }
    }
    sep = '';
    last = chunk;
    out += chunk;
  };
  // The hidden blocks before the next visible one. The pane never showed them, so
  // the user cannot have edited them away: blank lines become the pending
  // separation, and anything else (a link definition, a comment DOMPurify
  // stripped) is emitted where it stood.
  const flushHidden = () => {
    while (i < src.blocks.length && src.blocks[i].sig === '') {
      const raw = src.blocks[i++].raw;
      if (raw.trim()) emit(raw, false);
      else sep = raw;
    }
  };

  for (const op of ops) {
    if (op.type === 'add') {
      emit(td.turndown(pane[j++].html).trim(), true);
      continue;
    }
    flushHidden();
    const block = src.blocks[i++];
    if (op.type === 'ctx') {
      emit(block.raw, false); // unchanged: the original bytes, not turndown's rendering
      j++;
    }
    // 'del' — the block is gone from the pane, so nothing is emitted for it, and
    // its pending separation stands in for the one that followed it.
  }
  flushHidden();

  // A pane with content in it must never fold back to an empty file.
  if (pane.length && !out.trim()) return null;
  // End the file the way it ended before rather than however the last block's
  // turndown output happened to, so an edit near the bottom doesn't also add or
  // drop the trailing newline.
  if (out.trim()) out = out.replace(/[ \t\r\n]*$/, endOf(body));
  return out;
}

/**
 * Whether `next`, written on the line straight after `prev`, still opens a block
 * of its own instead of being read as a continuation of `prev`. marked is asked
 * rather than guessed at, since it is what reads the file back: the boundary holds
 * if `prev` still lexes as the whole of the first token. Anything unclear — no
 * marked, a `prev` that isn't one block, a lexer error — answers false, which
 * keeps the blank line that has always been written there.
 * @param {string} prev @param {string} next
 */
function stillSeparate(prev, next) {
  if (!prev) return true;
  if (!window.marked || !window.marked.lexer) return false;
  const head = prev.replace(/[ \t\r\n]*$/, '') + '\n';
  try {
    const tokens = window.marked.lexer(head + next);
    return tokens.length > 1 && tokens[0].raw === head;
  } catch {
    return false;
  }
}

// The whitespace a body ends with — a new file (no body yet) gets the one
// trailing newline a text file is expected to have.
function endOf(body) {
  if (!body) return '\n';
  return (/[ \t\r\n]*$/.exec(body) || [''])[0];
}

/**
 * The old source split into blocks, each carrying its original bytes and the HTML
 * it renders to (`sig`; empty means the pane cannot show it). `prefix` is the
 * blank lines before the first block.
 *
 * Concatenating `prefix` and every `raw` reproduces the source exactly — and that
 * is asserted, because a byte that ended up in no block would be dropped from
 * every fold.
 * @returns {{prefix: string, blocks: {raw: string, sig: string}[]} | null}
 */
// One-entry memo: rendering every block costs a marked + DOMPurify pass each, and
// while the user types in one block the autosave folds the *same* buffer again
// every 400ms. The buffer only changes when a fold writes it or a file is opened,
// so keying on its text is enough.
let blockCache: {body: string, blocks: {prefix: string, blocks: {raw: string, sig: string}[]} | null} | null = null;

function sourceBlocks(body) {
  if (blockCache && blockCache.body === body) return blockCache.blocks;
  const blocks = lexSourceBlocks(body);
  blockCache = { body, blocks };
  return blocks;
}

function lexSourceBlocks(body) {
  if (!window.marked || !window.marked.lexer) return null;
  let tokens;
  try {
    tokens = window.marked.lexer(body);
  } catch {
    return null; // an unparseable buffer is not something to reconcile against
  }
  // A link definition renders to nothing, so a paragraph that uses one renders
  // differently in isolation than it does in the pane. Rendering each block with
  // every definition in scope is what keeps `[text][ref]` matching — and so
  // preserved — instead of being rewritten as an inline link.
  const defs = tokens.filter((t) => t.type === 'def').map((t) => t.raw).join('\n');
  const scope = defs ? defs + '\n\n' : '';

  let prefix = '';
  const blocks: {raw: string, sig: string}[] = [];
  for (const t of tokens) {
    const raw = t.raw || '';
    if (!raw) continue;
    // Blank lines between blocks are a token of their own: before the first block
    // they are the prefix, after one they are a hidden block of their own.
    if (!blocks.length && !raw.trim()) {
      prefix += raw;
      continue;
    }
    let sig = '';
    if (raw.trim()) {
      const html = safeMarkdownHtml(scope + raw);
      if (html === null) return null; // marked or DOMPurify missing — see the pane
      sig = canonicalHtml(html);
    }
    blocks.push({ raw, sig });
  }
  const covered = blocks.reduce((n, b) => n + b.raw.length, prefix.length);
  if (covered !== body.length) return null;
  return { prefix, blocks };
}

// Inline elements a contenteditable can leave stranded at the top level. They are
// not blocks of their own — grouping them into one paragraph is what keeps them
// from being skipped, and a skipped node is an edit thrown away.
const INLINE_TAGS = new Set(['A', 'ABBR', 'B', 'BDI', 'BDO', 'BR', 'BUTTON', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'IMG', 'INPUT', 'INS', 'KBD', 'LABEL', 'MARK', 'Q', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR', 'WBR']);

/**
 * The pane's top-level blocks, in order, each with the HTML to turn down and the
 * signature to match against the source.
 * @returns {{html: string, sig: string}[]}
 */
function paneBlocks(paneEl) {
  const out: {html: string, sig: string}[] = [];
  let pending = '';
  const flush = () => {
    if (pending.trim()) out.push(paneBlock(`<p>${pending}</p>`));
    pending = '';
  };
  for (const node of Array.from(paneEl.childNodes) as ChildNode[]) {
    if (node.nodeType === Node.TEXT_NODE) {
      pending += escapeHtml((node as Text).data);
      continue;
    }
    // A comment is a block of its own so that a note holding one still *matches*
    // the source that produced it. (Whether one reaches the pane at all depends on
    // DOMPurify: it strips comments, which makes the source block hidden instead —
    // preserved either way, which is the point.)
    if (node.nodeType === Node.COMMENT_NODE) {
      flush();
      out.push(paneBlock(`<!--${(node as Comment).data}-->`));
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    if (isFrontmatterNode(node)) continue; // re-attached from the buffer instead
    const el = (node as Element);
    if (INLINE_TAGS.has(el.nodeName)) {
      pending += el.outerHTML;
      continue;
    }
    flush();
    out.push(paneBlock(el.outerHTML));
  }
  flush();
  return out;
}

function paneBlock(html) {
  return { html, sig: canonicalHtml(html) };
}

// Both sides of the comparison have to be the same serialization of the same DOM:
// one is a string marked produced, the other a live pane's own innerHTML. Passing
// marked's string through a detached element normalises it, and hydrateImages'
// swaps are undone so a resolved picture doesn't read as an edit.
function canonicalHtml(html) {
  const box = document.createElement('div');
  box.innerHTML = html;
  for (const img of Array.from(box.querySelectorAll('img'))) {
    const src = img.getAttribute('data-md-src');
    if (src) {
      img.setAttribute('src', src); // in place, so the attribute order still matches
      img.removeAttribute('data-md-src');
    }
    img.classList.remove('img-missing');
    if (!img.className) img.removeAttribute('class');
    if (/^Image not found: /.test(img.getAttribute('title') || '')) img.removeAttribute('title');
  }
  return box.innerHTML.trim();
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
