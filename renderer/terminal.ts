// The terminal pane: an interactive `claude` at the vault root, in a collapsible
// panel under the editor.
//
// It is a *pty* rather than a one-shot `runClaude()` call, because the CLI is a
// full-screen TUI: main owns the process, this module only draws it with xterm.js
// and forwards keystrokes. What claude then writes to the vault is picked up by the
// watcher in `watch.js` — this module deliberately knows nothing about that, since
// a pause in a pty's output says nothing about whether a task finished.
//
// **Collapsing does not stop the session.** A task the user kicked off keeps
// running with the pane hidden — the header keeps saying so — because hiding a
// panel is a view change, and killing a running agent is not.

import { api } from './api.js';
import {
  dividerTerminalEl,
  terminalBodyEl,
  terminalCaretEl,
  terminalPaneEl,
  terminalRestartBtn,
  terminalStatusEl,
  terminalToggleBtn,
} from './dom.js';
import { state } from './state.js';
import { relativePath } from './util.js';

const OPEN_KEY = 'rawNotes.terminalOpen';

let term: import('@xterm/xterm').Terminal | null = null;
let fit: import('@xterm/addon-fit').FitAddon | null = null;
let paneOpen = localStorage.getItem(OPEN_KEY) === '1';
let running = false; // a pty is alive (or being started) for the current vault

// xterm.js and the fit addon load as classic scripts, like marked and turndown. If
// they are missing the pane degrades to a disabled header rather than throwing on
// the first expand.
const xtermAvailable = !!(window.Terminal && window.FitAddon);

function setTerminalStatus(text: string, kind?: string) {
  terminalStatusEl.textContent = text;
  terminalStatusEl.classList.toggle('running', kind === 'running');
  terminalStatusEl.classList.toggle('error', kind === 'error');
}

// ---- The pane ----

// True while the keyboard belongs to claude: index.js stands its editor shortcuts
// down, so ⌘F and friends reach the pty instead of the note behind it.
export function terminalFocused() {
  return paneOpen && terminalPaneEl.contains(document.activeElement);
}

function paintToggle() {
  terminalPaneEl.classList.toggle('collapsed', !paneOpen);
  dividerTerminalEl.classList.toggle('hidden', !paneOpen);
  terminalCaretEl.textContent = paneOpen ? '▾' : '▸';
  terminalToggleBtn.setAttribute('aria-expanded', paneOpen ? 'true' : 'false');
  terminalToggleBtn.title = paneOpen
    ? 'Hide the Claude terminal (⌘J) — the session keeps running'
    : 'Show the Claude terminal (⌘J)';
  terminalRestartBtn.classList.toggle('hidden', !paneOpen || !xtermAvailable);
}

export function toggleTerminal() {
  setTerminalOpen(!paneOpen);
}

function setTerminalOpen(next: boolean) {
  paneOpen = next;
  localStorage.setItem(OPEN_KEY, paneOpen ? '1' : '0');
  paintToggle();
  if (!paneOpen) return;
  if (!xtermAvailable) {
    setTerminalStatus('xterm.js did not load — the terminal is unavailable.', 'error');
    return;
  }
  ensureTerm();
  // The pane was display:none a moment ago, so it had no size to fit to: measure
  // after the browser has laid the expanded panel out.
  requestAnimationFrame(() => {
    fitTerm();
    if (!running) startSession();
    if (term) term.focus();
  });
}

function ensureTerm() {
  if (term || !window.Terminal || !window.FitAddon) return;
  const styles = getComputedStyle(document.documentElement);
  const cssVar = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;

  term = new window.Terminal({
    fontFamily: cssVar('--font-mono', 'Menlo, monospace'),
    fontSize: 12,
    lineHeight: 1.25,
    cursorBlink: true,
    // The pty is the scrollback that matters for a live session; this is only what
    // the user can scroll back through in the pane.
    scrollback: 5000,
    // Not `allowProposedApi`: nothing here uses one, and it would opt the pane in
    // to xterm APIs that can change under it.
    theme: {
      background: cssVar('--bg', '#1e1e1e'),
      foreground: cssVar('--text', '#d4d4d4'),
      cursor: cssVar('--accent', '#4a9eff'),
      selectionBackground: cssVar('--bg-active', '#37373d'),
    },
  });
  fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(terminalBodyEl);

  // Keystrokes go straight to the tty; a resize (from fit, below) goes with them,
  // or the TUI keeps drawing to a width the pane no longer has.
  term.onData((data) => api.termInput(data));
  term.onResize(({ cols, rows }) => {
    if (running) api.termResize(cols, rows);
  });

  // Any layout change — the divider, the window, the sidebar — re-fits. Collapsed
  // the pane measures zero, and fitting to zero would resize the pty to nothing.
  new ResizeObserver(() => {
    if (paneOpen) fitTerm();
  }).observe(terminalBodyEl);
}

function fitTerm() {
  if (!fit || !paneOpen) return;
  try {
    fit.fit();
  } catch {
    // fit throws if the element has no measurable size yet (mid-transition); the
    // ResizeObserver will call again once it does.
  }
}

// ---- The session ----

async function startSession() {
  if (!term || !state.baseFolder) return;
  running = true; // set first: a second expand mid-start must not spawn twice
  setTerminalStatus('Starting claude…');
  const res = await api.termStart(state.baseFolder, term.cols, term.rows);
  if (!res.ok) {
    running = false;
    setTerminalStatus(res.error || 'Could not start claude.', 'error');
    // Written into the pane as well as the header: this is where the user is
    // looking, and the reason (no `claude` on PATH, usually) is worth keeping.
    term.write(`\r\n\x1b[31m${res.error || 'Could not start claude.'}\x1b[0m\r\n`);
    return;
  }
  setTerminalStatus(`claude · ${relativePath(state.baseFolder) || 'vault root'}`, 'running');
}

// The ⟳ button, and every vault change: the session's cwd is the vault, so it
// cannot follow one — it is replaced.
export async function restartTerminal() {
  if (!xtermAvailable || !state.baseFolder) return;
  await api.termStop();
  running = false;
  if (!paneOpen) {
    setTerminalStatus('');
    return;
  }
  ensureTerm();
  if (term) term.reset();
  fitTerm();
  await startSession();
}

// Called from openFolder(): the workspace is on screen by then, which is what the
// fit needs, and the old session (if any) belongs to the folder that just closed.
export async function terminalVaultChanged() {
  if (!xtermAvailable) {
    paintToggle();
    if (paneOpen) setTerminalStatus('xterm.js did not load — the terminal is unavailable.', 'error');
    return;
  }
  await api.termStop();
  running = false;
  paintToggle();
  if (!paneOpen) {
    setTerminalStatus('');
    return;
  }
  ensureTerm();
  if (term) term.reset();
  fitTerm();
  await startSession();
}

api.onTermData((data) => {
  if (term) term.write(data);
});

api.onTermExit(({ exitCode }) => {
  running = false;
  if (term) term.write(`\r\n\x1b[90m[claude exited (${exitCode})] — ⟳ to start again\x1b[0m\r\n`);
  setTerminalStatus(`claude exited (${exitCode})`, exitCode === 0 ? undefined : 'error');
});

// ---- Wiring ----

terminalToggleBtn.addEventListener('click', toggleTerminal);
terminalRestartBtn.addEventListener('click', () => restartTerminal());
// Clicking anywhere in the empty part of the pane puts the caret back in claude.
terminalBodyEl.addEventListener('mousedown', () => {
  if (term && !terminalFocused()) term.focus();
});
// The persisted state is applied to the header now; the session itself waits for
// terminalVaultChanged(), because a pane inside the hidden workspace measures zero
// and would size the pty to nothing.
paintToggle();
if (paneOpen && !xtermAvailable) {
  setTerminalStatus('xterm.js did not load — the terminal is unavailable.', 'error');
}
