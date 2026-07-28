// HTML -> Markdown, the reverse of what marked does for the preview. marked speaks
// GFM and turndown only CommonMark, so everything GFM adds needs an explicit
// inverse rule here or a WYSIWYG save silently destroys it.

import { IMAGE_SUMMARY } from './state.js';

let turndown = null;
export function getTurndown() {
  if (turndown || !window.TurndownService) return turndown;
  turndown = new window.TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  // Emit the vault-relative path we stashed on hydrated images (their live src is
  // a data: URL), not the inlined base64 — so saved Markdown stays portable.
  turndown.addRule('vaultImage', {
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
  turndown.addRule('detailsBlock', {
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
  addGfmRules(turndown);
  return turndown;
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
    // section boundaries leave behind, since one would end the table early.
    replacement: (content) => `\n\n${content.replace(/\n{2,}/g, '\n').trim()}\n\n`,
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
    && Array.from(row.children).every((cell) => cell.nodeName === 'TH');
}

function hasHeadingRow(table) {
  return !!(table.rows && table.rows.length && isHeadingRow(table.rows[0]));
}

// Smart-insert state: the last plan Claude returned, and the exact note text it
