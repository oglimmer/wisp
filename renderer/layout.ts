// The four draggable dividers. Row dividers restore late, on purpose.

import { byId, workspaceEl } from './dom.js';

(function setupDivider() {
  const divider = byId('divider');
  const sidebar = byId('sidebar');
  const MIN = 160;
  const MAX = 600; // keep in sync with .sidebar min/max-width in styles.css

  const clamp = (w: number) => Math.max(MIN, Math.min(MAX, w));

  // Restore a persisted width from a previous session.
  const saved = parseInt(localStorage.getItem('rawNotes.sidebarWidth') || '', 10);
  if (!Number.isNaN(saved)) sidebar.style.width = clamp(saved) + 'px';

  let dragging = false;

  function onMove(e: MouseEvent) {
    if (!dragging) return;
    const left = workspaceEl.getBoundingClientRect().left;
    sidebar.style.width = clamp(e.clientX - left) + 'px';
  }

  function onUp() {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('rawNotes.sidebarWidth', String(parseInt(sidebar.style.width, 10)));
  }

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    divider.classList.add('dragging');
    // Lock the cursor and stop text selection while dragging over the editor.
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
})();

// ---- Resizable vertical stack (note box / preview / editor) ----
// Saved panel heights can only be restored once the workspace is actually laid
// out, so each divider registers its restore step here and `restoreRowDividers()`
// runs them the first time a folder is opened.
const rowDividerRestores: (() => void)[] = [];
let rowDividersRestored = false;

export function restoreRowDividers() {
  if (rowDividersRestored) return;
  rowDividersRestored = true;
  for (const restore of rowDividerRestores) restore();
}

// Each row divider resizes the panel directly above it by setting its height;
// the editor is flex:1 and absorbs whatever's left. RESERVE keeps the editor
// from being squeezed away entirely.
// `opts.below` marks a panel that sits *under* its divider (the reminder list),
// so dragging up grows it instead of down.
interface RowDividerOptions {
  /** The element the panel's height is measured against; the editor pane by default. */
  container?: HTMLElement | null;
  /** Pixels the editor keeps however far the divider is dragged. */
  reserve?: number;
  /** The panel sits *under* its divider (the reminder list), so dragging up grows it. */
  below?: boolean;
}

function makeRowDivider(
  divider: HTMLElement,
  panel: HTMLElement,
  storageKey: string,
  minPx: number,
  opts: RowDividerOptions = {},
) {
  const paneEl = opts.container || (document.querySelector('.editor-pane') as HTMLElement);
  const RESERVE = opts.reserve ?? 140;
  const dir = opts.below ? -1 : 1;
  const clamp = (h: number) =>
    Math.max(minPx, Math.min(h, paneEl.getBoundingClientRect().height - RESERVE));

  // Deferred, not applied here: clamping needs the container's real height, and
  // #workspace is display:none until a folder opens, where every measurement
  // reads 0 — which would clamp each panel to its minimum and quietly throw the
  // stored layout away on every launch.
  rowDividerRestores.push(() => {
    const saved = parseInt(localStorage.getItem(storageKey) || '', 10);
    if (!Number.isNaN(saved)) panel.style.height = clamp(saved) + 'px';
  });

  let dragging = false;
  let startY = 0;
  let startH = 0;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    divider.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    panel.style.height = clamp(startH + dir * (e.clientY - startY)) + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem(storageKey, String(parseInt(panel.style.height, 10)));
  });
}

makeRowDivider(byId('divider-input'), byId('smart-insert'), 'rawNotes.inputHeight', 70);
makeRowDivider(byId('divider-preview'), byId('smart-preview'), 'rawNotes.previewHeight', 60);
// The terminal sits *under* its divider, so dragging up grows it — and it is only
// draggable while expanded (the handle hides itself with the pane's body).
makeRowDivider(byId('divider-terminal'), byId('terminal-pane'), 'rawNotes.terminalHeight', 120, {
  below: true,
});
makeRowDivider(byId('divider-reminders'), byId('reminders'), 'rawNotes.remindersHeight', 92, {
  container: byId('sidebar'),
  reserve: 120,
  below: true,
});
